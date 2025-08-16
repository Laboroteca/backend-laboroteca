// scripts/auditarFacturas.js
// Ejecuta: node scripts/auditarFacturas.js

const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');
const axios = require('axios');

// ───────────────────────── CONFIG ─────────────────────────
const WINDOW_DAYS = 25;

// Compras (LECTURA)
const COMPRAS_SHEET_ID = '1ShSiaz_TtODbVkczI1mfqTBj5nHb3xSEywyB0E6BL9I';
const COMPRAS_SHEET_TAB = 'Hoja 1'; // A: Nombre, B: Apellidos, C: DNI, D: Descripción, E: Importe, F: Fecha (es-ES), G: Email

// Registro auditorías (ESCRITURA)
const AUDIT_SHEET_ID = '1P39jEoMGO3fxFmFGDKKECxa9sV4xk_N3rv1wXrJyYJM';
const AUDIT_SHEET_TAB_DEFAULT = 'Hoja 1';

// GCS PDFs
const GCS_BUCKET = process.env.GOOGLE_CLOUD_BUCKET || 'laboroteca-facturas';

// FacturaCity (con fallbacks proporcionados)
const FC_BASE = (process.env.FACTURACITY_API_URL || 'https://app2.factura.city/680d72cf23386/api/3').replace(/\/+$/, '');
const FC_KEY  = (process.env.FACTURACITY_API_KEY || 'KlyDZCM6gbsyBP7jgDum').trim();

// Email (tu helper SMTP2GO)
const { enviarEmailPersonalizado } = require('../services/email');
const EMAIL_DEST = 'laboroteca@gmail.com';

// Google Auth (mismas credenciales que ya usas)
if (!process.env.GCP_CREDENTIALS_BASE64) {
  throw new Error('❌ Falta GCP_CREDENTIALS_BASE64');
}
const credentials = JSON.parse(Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8'));
const sheetsAuth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const storage = new Storage({ credentials });

// ───────────────────────── UTILS ─────────────────────────
const now = () => new Date();
const utcISO = d => new Date(d).toISOString();
function log(msg, extra=''){ console.log(`[${utcISO(Date.now())}] ${msg}${extra?' '+extra:''}`); }
function warn(msg, extra=''){ console.warn(`[${utcISO(Date.now())}] ${msg}${extra?' '+extra:''}`); }

function normalizarTexto(str=''){
  return String(str).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,' ')
    .trim();
}

function parseFechaESES(s){
  if (!s) return null;
  const t = String(s).replace(',', '');
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [_, d, mo, y, h='0', mi='0', se='0'] = m;
  return new Date(Date.UTC(+y, +mo-1, +d, +h, +mi, +se));
}

function daysDiff(a,b){ return Math.abs((a - b) / 86400000); }
function withinWindow(a, b, days = WINDOW_DAYS){ return daysDiff(a,b) <= days; }

function startDate(days=WINDOW_DAYS){
  const d = now();
  d.setDate(d.getDate() - days);
  return d;
}

function toYMD(d){
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,'0');
  const da = String(d.getUTCDate()).padStart(2,'0');
  return `${y}-${m}-${da}`;
}

function fmtES(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });
}

function dedupObjects(arr, keyFn){
  const seen = new Set();
  const out = [];
  for (const it of arr){
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

// ───────────────────────── SHEETS (COMPRAS) ─────────────────────────
async function leerComprasDeSheets(){
  const client = await sheetsAuth.getClient();
  const sheets = google.sheets({ version:'v4', auth: client });

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: COMPRAS_SHEET_ID,
    range: `${COMPRAS_SHEET_TAB}!A2:K`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });

  const minDate = startDate();
  const rows = (data.values || []).map(r => {
    const [nombre, apellidos, dni, descripcion, importeStr, fechaStr, email] = r;
    const fecha = parseFechaESES(fechaStr);
    const importe = typeof importeStr === 'string'
      ? parseFloat(importeStr.replace('€','').replace(',','.'))
      : Number(importeStr || 0);
    return {
      fuente: 'SHEETS',
      nombre: nombre || '', apellidos: apellidos || '',
      nombreN: normalizarTexto(nombre || ''), apellidosN: normalizarTexto(apellidos || ''),
      email: (email || '').toLowerCase().trim(),
      descripcion: descripcion || '', descN: normalizarTexto(descripcion || ''),
      importe, fecha, fechaStr: fmtES(fecha)
    };
  }).filter(r => r.fecha && r.fecha >= minDate);

  log(`📥 Sheets: ${rows.length} registros en ventana de ${WINDOW_DAYS} días.`);
  return rows;
}

function detectarDuplicadosSheets(rows){
  const out = [];
  const byPerson = new Map();
  for (const r of rows) {
    const key = `${r.nombreN}||${r.apellidosN}`;
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(r);
  }
  for (const arr of byPerson.values()){
    arr.sort((a,b)=>a.fecha-b.fecha);
    for (let i=0;i<arr.length;i++){
      const base = arr[i];
      const grupo = [base];
      for (let j=i+1;j<arr.length;j++){
        const cand = arr[j];
        if (withinWindow(base.fecha, cand.fecha)) grupo.push(cand);
        else break;
      }
      if (grupo.length >= 2){
        const byDesc = new Map();
        for (const x of grupo){
          if (!byDesc.has(x.descN)) byDesc.set(x.descN, []);
          byDesc.get(x.descN).push(x);
        }
        for (const [descK, arrD] of byDesc.entries()){
          if (descK && arrD.length >= 2){
            out.push({
              tipo: 'DUP_SHEETS_SAME_DESC',
              nombre: base.nombre, apellidos: base.apellidos, email: base.email,
              descripcion: arrD[0].descripcion,
              count: arrD.length,
              fechas: arrD.map(e=>e.fechaStr),
              numerosFactura: [] // se completa con FacturaCity si hay match
            });
          }
        }
      }
    }
  }
  log(`🔎 Sheets duplicados (mismo nombre+apellidos+descripción): ${out.length}`);
  return dedupObjects(out, i => `${i.tipo}|${i.nombre}|${i.apellidos}|${normalizarTexto(i.descripcion)}|${i.fechas.join('|')}`);
}

// ───────────────────────── GCS ─────────────────────────
// Nueva heurística: agrupar por EMAIL + SLUG (nombre lógico del documento)
// Espera rutas tipo: facturas/{email}/{timestamp}-{slug}.pdf
function extractEmailFromPath(path){
  const m = String(path).match(/^facturas\/([^/]+)\//);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
}
function extractSlugFromPath(path){
  const m = String(path).match(/\/\d{10,}-([^/]+)\.pdf$/i);
  if (m) return m[1].toLowerCase();
  // fallback: nombre sin extensión
  const b = path.split('/').pop() || '';
  return b.replace(/\.pdf$/i,'').toLowerCase();
}

async function listarGcsEnVentana(){
  const minDate = startDate();
  const [files] = await storage.bucket(GCS_BUCKET).getFiles({ prefix: 'facturas/' });
  const rows = (files || []).map(f => {
    const updated = new Date(f.metadata?.updated || f.metadata?.timeCreated || 0);
    return {
      fuente: 'GCS',
      email: extractEmailFromPath(f.name),
      slug: extractSlugFromPath(f.name),
      numero: null,
      fecha: updated,
      fechaStr: fmtES(updated),
      file: f.name
    };
  }).filter(r => r.fecha && r.fecha >= minDate);

  log(`📥 GCS: ${rows.length} ficheros en ventana (${WINDOW_DAYS} días).`);
  return rows;
}

function detectarDuplicadosGcs(rows){
  // Incidencias por (email + slug) con >= 2 PDFs en la ventana
  const byKey = new Map();
  for (const r of rows){
    const key = `${r.email}||${r.slug}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  const out = [];
  for (const [key, arr] of byKey.entries()){
    if (!arr[0].email || !arr[0].slug) continue;
    if (arr.length >= 2){
      out.push({
        tipo: 'DUP_GCS_MULTI_PDF',
        email: arr[0].email,
        slug: arr[0].slug,
        count: arr.length,
        fechas: arr.map(x=>x.fechaStr).slice(0,20),
        files: arr.map(x=>x.file).slice(0,20),
        numerosFactura: []
      });
    }
  }
  log(`🔎 GCS duplicados por documento: ${out.length}`);
  return out;
}

// ───────────────────────── FACTURACITY ─────────────────────────
// Descubrimiento de endpoint (FacturaScripts): consulto índice y detecto recurso de facturas
async function discoverFacturaCityResource(){
  const candidates = ['', '/', '/index.php', '/?format=json'];
  const headersToTry = [
    { name: 'Token', build: v => ({ Token: v }) },
    { name: 'Authorization: Token', build: v => ({ Authorization: `Token ${v}` }) },
    { name: 'Authorization: Bearer', build: v => ({ Authorization: `Bearer ${v}` }) },
  ];
  for (const suffix of candidates){
    const url = `${FC_BASE}${suffix}`;
    for (const h of headersToTry){
      try{
        log(`🌐 FC INDEX GET ${url} [${h.name}]`);
        const r = await axios.get(url, { headers: { Accept: 'application/json', ...h.build(FC_KEY) }, timeout: 10000, validateStatus: () => true });
        if (r.status >= 200 && r.status < 300 && r.data){
          const text = JSON.stringify(r.data).toLowerCase();
          // Busca nombres típicos
          const matches = [];
          ['factura', 'facturas', 'ventas', 'ventas_facturas', 'facturacliente', 'crearFacturaCliente'.toLowerCase()].forEach(k=>{
            if (text.includes(k)) matches.push(k);
          });
          return { headers: h.build(FC_KEY), raw: r.data, indexUrl: url, matches };
        } else {
          warn(`FC INDEX ${url} → HTTP ${r.status} ${String(r.data).slice(0,200)}`);
        }
      }catch(e){
        warn(`FC INDEX error ${url}: ${e.message}`);
      }
    }
  }
  return null;
}

function buildFcAttempts(resourceHint){
  // Paths probables en FacturaScripts / factura.city
  const basePaths = [
    '/ventas_facturas', '/facturas', '/factura', '/facturacliente', '/api/ventas_facturas',
  ];
  // filtros posibles
  const filters = ({from, to}) => ([
    { method: 'GET',  qs: { desde: from, hasta: to } },
    { method: 'GET',  qs: { from, to } },
    { method: 'GET',  qs: { fecha_desde: from, fecha_hasta: to } },
    { method: 'POST', form: { desde: from, hasta: to } },
    { method: 'POST', form: { from, to } },
  ]);

  const hintPaths = [];
  const text = JSON.stringify(resourceHint||{}).toLowerCase();
  if (text.includes('ventas_facturas')) hintPaths.push('/ventas_facturas');
  if (text.includes('facturas')) hintPaths.push('/facturas');
  if (text.includes('facturacliente')) hintPaths.push('/facturacliente');

  const paths = Array.from(new Set([...hintPaths, ...basePaths]));
  return (from,to) => {
    const attempts = [];
    for (const p of paths){
      for (const f of filters({from,to})){
        attempts.push({ path: p, ...f });
      }
    }
    return attempts;
  };
}

async function fetchFacturaCityList(fromDate, toDate){
  if (!FC_BASE || !FC_KEY) {
    warn('FacturaCity desactivado: falta FACTURACITY_API_URL o FACTURACITY_API_KEY');
    return [];
  }
  const from = toYMD(fromDate);
  const to = toYMD(toDate);

  const discovery = await discoverFacturaCityResource();
  const headers = discovery?.headers || { Token: FC_KEY, Accept: 'application/json' };
  const attemptBuilder = buildFcAttempts(discovery?.raw);

  const attempts = attemptBuilder(from, to);

  for (const a of attempts){
    const url = `${FC_BASE}${a.path}`;
    try{
      let r;
      if (a.method === 'POST'){
        const body = new URLSearchParams(a.form || {});
        log(`🌐 FC POST ${url} [filters=${JSON.stringify(a.form)}]`);
        r = await axios.post(url, body.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
          timeout: 15000, validateStatus: () => true
        });
      } else {
        log(`🌐 FC GET  ${url} [qs=${JSON.stringify(a.qs)}]`);
        r = await axios.get(url, { params: a.qs, headers: { Accept: 'application/json', ...headers }, timeout: 15000, validateStatus: () => true });
      }

      if (r.status >= 200 && r.status < 300){
        const data = r.data;
        const list = Array.isArray(data) ? data
                   : Array.isArray(data?.items) ? data.items
                   : Array.isArray(data?.data) ? data.data
                   : Array.isArray(data?.result) ? data.result
                   : [];
        log(`✅ FacturaCity OK (${a.method} ${a.path}) → ${list.length} registros`);
        return list.map(mapFCItem).filter(i => i.fecha && i.fecha >= fromDate && i.fecha <= toDate);
      } else {
        warn(`FacturaCity ${a.method} ${a.path} → HTTP ${r.status} BODY=${(typeof r.data==='string'?r.data:JSON.stringify(r.data)).slice(0,240)}`);
      }
    }catch(e){
      warn(`FacturaCity ${a.method} ${a.path} error: ${e.message}`);
    }
  }

  warn('FacturaCity: no se pudo obtener listado tras intentos dinámicos.');
  return [];
}

function mapFCItem(x){
  const get = (keys)=> {
    for (const k of keys){
      if (x[k] != null) return x[k];
      const kk = Object.keys(x).find(n => n.toLowerCase() === String(k).toLowerCase());
      if (kk != null) return x[kk];
    }
    return undefined;
  };
  const numero = get(['numero','num','number','invoice_number','code','codigo']) || '';
  const fechaRaw = get(['fecha','created_at','date','issued_at','emitted_at','fecha_emision']);
  let fecha = fechaRaw ? new Date(fechaRaw) : null;
  if (fecha && isNaN(fecha.getTime())) {
    const m = String(fechaRaw).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) fecha = new Date(Date.UTC(+m[1], +m[2]-1, +m[3]));
    else fecha = null;
  }
  const email = (get(['cliente_email','email','customer_email']) || '').toLowerCase().trim();
  let nombre = get(['cliente_nombre','nombre','customer_name','cliente','razon_social']) || '';
  const apellidos = get(['cliente_apellidos','apellidos','surname','last_name']) || '';
  if (!apellidos && nombre.includes(' ')) {
    const parts = String(nombre).trim().split(/\s+/);
    nombre = parts.shift() || '';
  }
  const descripcion = get(['concepto','descripcion','description','detalle','notes']) || '';
  const total = Number(get(['total','importe','amount','grand_total','total_amount']) || 0);
  return {
    fuente: 'FC',
    numero: String(numero).trim(),
    fecha,
    fechaStr: fmtES(fecha), // solo fecha
    email,
    nombre: nombre || '', apellidos: apellidos || '',
    nombreN: normalizarTexto(nombre || ''), apellidosN: normalizarTexto(apellidos || ''),
    descripcion: descripcion || '', descN: normalizarTexto(descripcion || ''),
    importe: total,
    raw: x
  };
}

function detectarDuplicadosFacturaCity(items){
  const out = [];
  const byPerson = new Map();
  for (const it of items){
    const key = `${it.nombreN}||${it.apellidosN}`;
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(it);
  }
  for (const arr of byPerson.values()){
    arr.sort((a,b)=>a.fecha-b.fecha);
    const byDesc = new Map();
    for (const it of arr){
      if (!byDesc.has(it.descN)) byDesc.set(it.descN, []);
      byDesc.get(it.descN).push(it);
    }
    for (const [descK, g] of byDesc.entries()){
      if (descK && g.length >= 2){
        out.push({
          tipo: 'DUP_FACTURACITY_SAME_DESC',
          nombre: g[0].nombre, apellidos: g[0].apellidos, email: g[0].email,
          descripcion: g[0].descripcion,
          count: g.length,
          numerosFactura: g.map(x=>x.numero).filter(Boolean),
          fechas: g.map(x=>x.fechaStr)
        });
      }
    }
    const uniqDescs = Array.from(new Set(arr.map(x=>x.descN).filter(Boolean)));
    if (uniqDescs.length >= 2 && arr.length >= 2){
      out.push({
        tipo: 'DUP_FACTURACITY_DIFF_DESC',
        nombre: arr[0].nombre, apellidos: arr[0].apellidos, email: arr[0].email,
        descripciones: Array.from(new Set(arr.map(x=>x.descripcion))),
        count: arr.length,
        numerosFactura: arr.map(x=>x.numero).filter(Boolean),
        fechas: arr.map(x=>x.fechaStr)
      });
    }
  }
  log(`🔎 FacturaCity duplicados: ${out.length}`);
  return dedupObjects(out, i => `${i.tipo}|${i.nombre}|${i.apellidos}|${(i.descripcion||i.descripciones?.join('+'))}|${i.numerosFactura.join(',')}|${i.fechas.join('|')}`);
}

// ───────────────────────── AUDIT SHEET (A–F) ─────────────────────────
async function appendAuditRow({ countSheets, countGcs, countFc, emailsAfectados, fechasResumen }){
  const client = await sheetsAuth.getClient();
  const sheets = google.sheets({ version:'v4', auth: client });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: AUDIT_SHEET_ID });
  const tabName = meta.data.sheets?.[0]?.properties?.title || AUDIT_SHEET_TAB_DEFAULT;

  const fechaAuditoria = new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });

  const row = [
    fechaAuditoria,
    String(countSheets),
    String(countGcs),
    String(countFc),
    emailsAfectados.join('; ').slice(0, 1000),
    fechasResumen.join('; ').slice(0, 1000)
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: AUDIT_SHEET_ID,
    range: `${tabName}!A2`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });

  log(`📝 AuditSheet: fila añadida → A:${fechaAuditoria} B:${countSheets} C:${countGcs} D:${countFc}`);
}

// ───────────────────────── EMAIL ─────────────────────────
async function enviarInformeEmail({ fcDup, shDup, gcsDup, totales, resumen }){
  if (!process.env.SMTP2GO_API_KEY || !process.env.SMTP2GO_FROM_EMAIL) {
    warn('Email no enviado: faltan credenciales SMTP2GO');
    return;
  }

  const totalIncidencias = fcDup.length + shDup.length + gcsDup.length;

  const fmtList = (arr) => arr.map(i => {
    const base = `<b>${i.nombre || ''} ${i.apellidos || ''}</b> — ${i.email || ''}`;
    const fechas = i.fechas?.join(' | ') || '';
    if (i.tipo?.startsWith('DUP_FACTURACITY')) {
      const nums = i.numerosFactura?.length ? `Nºs: <code>${i.numerosFactura.join(', ')}</code><br/>` : '';
      const desc = i.descripcion ? `Desc: <i>${i.descripcion}</i><br/>` :
                   i.descripciones ? `Desc: <i>${i.descripciones.join(' · ')}</i><br/>` : '';
      return `<li>${base}<br/>${desc}${nums}Fechas: ${fechas}<br/>Coincidencias: ${i.count}</li>`;
    } else if (i.tipo?.startsWith('DUP_SHEETS')) {
      const desc = i.descripcion ? `Desc: <i>${i.descripcion}</i><br/>` : '';
      return `<li>${base}<br/>${desc}Fechas: ${fechas}<br/>Coincidencias: ${i.count}</li>`;
    } else {
      const files = i.files?.length ? `Ficheros: <code>${i.files.join(' | ')}</code><br/>` : '';
      // para GCS, mostramos slug también si existe
      const title = i.slug ? `<i>${i.slug}</i><br/>` : '';
      return `<li>${i.email || '—'}<br/>${title}${files}Fechas: ${fechas}<br/>Coincidencias: ${i.count}</li>`;
    }
  }).join('\n');

  const html = `
    <div style="font-family:Arial, sans-serif; font-size:14px; color:#333">
      <p><b>Auditoría diaria (ventana ${WINDOW_DAYS} días)</b></p>
      <p><b>Facturas emitidas (FacturaCity) en ${WINDOW_DAYS} días:</b> ${totales.fcEmitidas}</p>
      <p><b>Duplicados detectados</b> — Total incidencias: <b>${totalIncidencias}</b></p>
      <ul style="margin-top:0">
        <li>FacturaCity: <b>${fcDup.length}</b></li>
        <li>Google Sheets: <b>${shDup.length}</b></li>
        <li>GCS (por documento): <b>${gcsDup.length}</b></li>
      </ul>

      <h4>Resumen de fechas</h4>
      <p>${resumen.fechasResumen.length ? resumen.fechasResumen.join(' | ') : '—'}</p>

      <h3>Detalle</h3>
      ${fcDup.length ? `<h4>FacturaCity</h4><ul>${fmtList(fcDup)}</ul>` : '<h4>FacturaCity</h4><p>Sin incidencias.</p>'}
      ${shDup.length ? `<h4>Google Sheets</h4><ul>${fmtList(shDup)}</ul>` : '<h4>Google Sheets</h4><p>Sin incidencias.</p>'}
      ${gcsDup.length ? `<h4>GCS</h4><ul>${fmtList(gcsDup)}</ul>` : '<h4>GCS</h4><p>Sin incidencias.</p>'}
    </div>
  `;

  const text = [
    `Auditoría diaria (ventana ${WINDOW_DAYS} días)`,
    `Facturas emitidas (FacturaCity): ${totales.fcEmitidas}`,
    '',
    `Duplicados — total incidencias: ${totalIncidencias}`,
    `- FacturaCity: ${fcDup.length}`,
    `- Google Sheets: ${shDup.length}`,
    `- GCS (por documento): ${gcsDup.length}`,
    '',
    'Resumen de fechas:',
    resumen.fechasResumen.join(' | ') || '—',
  ].join('\n');

  await enviarEmailPersonalizado({
    to: EMAIL_DEST,
    subject: `📊 Auditoría diaria — Facturas ${totales.fcEmitidas} | Dups FC:${fcDup.length} SH:${shDup.length} GCS:${gcsDup.length}`,
    html,
    text
  });

  log(`📧 Informe enviado a ${EMAIL_DEST}`);
}

// ───────────────────────── RUNNER ─────────────────────────
(async () => {
  try{
    log(`🚀 Auditoría iniciada (ventana ${WINDOW_DAYS} días).`);

    // 1) Cargar fuentes
    const [shRows, gcsRows, fcRows] = await Promise.all([
      leerComprasDeSheets(),
      listarGcsEnVentana(),
      fetchFacturaCityList(startDate(), now())
    ]);

    const totales = { fcEmitidas: fcRows.length };

    // 2) Detectar duplicados
    const shDup = detectarDuplicadosSheets(shRows);
    const gcsDup = detectarDuplicadosGcs(gcsRows);
    const fcDup = detectarDuplicadosFacturaCity(fcRows);

    // 3) Completar nº de factura en incidencias de Sheets con FacturaCity
    if (fcRows.length && shDup.length){
      const byPersonFC = new Map();
      for (const it of fcRows){
        const key = `${it.nombreN}||${it.apellidosN}`;
        if (!byPersonFC.has(key)) byPersonFC.set(key, []);
        byPersonFC.get(key).push(it);
      }
      for (const inc of shDup){
        const key = `${normalizarTexto(inc.nombre)}||${normalizarTexto(inc.apellidos)}`;
        const cand = byPersonFC.get(key) || [];
        const nums = cand
          .filter(x => inc.descripcion && x.descN === normalizarTexto(inc.descripcion))
          .map(x => x.numero)
          .filter(Boolean);
        inc.numerosFactura = Array.from(new Set(nums));
      }
    }

    // 4) Emails afectados
    const emailsAfectados = Array.from(new Set([
      ...fcDup.map(i=>i.email).filter(Boolean),
      ...shDup.map(i=>i.email).filter(Boolean),
      ...gcsDup.map(i=>i.email).filter(Boolean),
    ]));

    // 5) Fechas resumen
    const fechasResumen = [
      ...fcDup.flatMap(i => i.fechas || []).slice(0,6),
      ...shDup.flatMap(i => i.fechas || []).slice(0,6),
      ...gcsDup.flatMap(i => i.fechas || []).slice(0,6),
    ];

    // 6) Email SIEMPRE
    await enviarInformeEmail({ fcDup, shDup, gcsDup, totales, resumen: { fechasResumen } });

    // 7) Registrar en hoja de auditorías
    await appendAuditRow({
      countSheets: shDup.length,
      countGcs: gcsDup.length,
      countFc: fcDup.length,
      emailsAfectados,
      fechasResumen
    });

    log('✅ Auditoría finalizada.');
  }catch(e){
    console.error('❌ Error auditoría:', e.stack || e.message || e);
    process.exit(1);
  }
})();
