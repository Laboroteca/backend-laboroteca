// scripts/auditarFacturas.js
// Ejecuta: node scripts/auditarFacturas.js

const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');
const fetch = require('node-fetch');

// ───────────────────────── CONFIG ─────────────────────────
const WINDOW_DAYS = 25;

// Compras (LECTURA)
const COMPRAS_SHEET_ID = '1ShSiaz_TtODbVkczI1mfqTBj5nHb3xSEywyB0E6BL9I';
const COMPRAS_SHEET_TAB = 'Hoja 1'; // A: Nombre, B: Apellidos, C: DNI, D: Descripción, E: Importe, F: Fecha (es-ES), G: Email

// Registro auditorías (ESCRITURA)
const AUDIT_SHEET_ID = '1P39jEoMGO3fxFmFGDKKECxa9sV4xk_N3rv1wXrJyYJM';
// si no sabes el nombre de la pestaña, usa la primera. Aquí usamos "Hoja 1" por defecto.
const AUDIT_SHEET_TAB_DEFAULT = 'Hoja 1';

// GCS PDFs
const GCS_BUCKET = process.env.GCS_BUCKET || 'laboroteca-facturas';

// FacturaCity
const FC_BASE = (process.env.FACTURACITY_API_URL || '').replace(/\/+$/,'');
const FC_KEY  = process.env.FACTURACITY_API_KEY || '';

// Email (usamos tu helper SMTP2GO)
const { enviarEmailPersonalizado } = require('../services/email');
const EMAIL_DEST = 'laboroteca@gmail.com';

// Google Auth (mismas credenciales que ya usas)
if (!process.env.GCP_CREDENTIALS_BASE64) {
  throw new Error('❌ Falta GCP_CREDENTIALS_BASE64');
}
const credentials = JSON.parse(
  Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8')
);
const sheetsAuth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const storage = new Storage({ credentials });

// ───────────────────────── UTILS ─────────────────────────
const now = () => new Date();
const utcISO = d => new Date(d).toISOString();
const esNow = () =>
  new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

function log(msg, extra=''){ console.log(`[${utcISO(Date.now())}] ${msg}${extra?' '+extra:''}`); }
function warn(msg, extra=''){ console.warn(`[${utcISO(Date.now())}] ${msg}${extra?' '+extra:''}`); }

function normalizarTexto(str=''){
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,' ')
    .trim();
}

function parseFechaESES(s){
  if (!s) return null;
  const t = String(s).replace(',', '');
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [_, d, mo, y, h, mi, se] = m;
  // interpretamos como Europe/Madrid ~ UTC (suficiente para ventana de 25 días)
  return new Date(Date.UTC(+y, +mo-1, +d, +h, +mi, +(se||0)));
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
      importe, fecha, fechaStr: fechaStr || ''
    };
  }).filter(r => r.fecha && r.fecha >= minDate);

  log(`📥 Sheets: ${rows.length} registros en ventana de ${WINDOW_DAYS} días.`);
  return rows;
}

function detectarDuplicadosSheets(rows){
  const out = [];
  // agrupar por persona
  const byPerson = new Map();
  for (const r of rows) {
    const key = `${r.nombreN}||${r.apellidosN}`;
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(r);
  }
  for (const [key, arr] of byPerson.entries()){
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
        // misma descripción
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
              numerosFactura: [] // Sheets no tiene nº factura; lo completamos con FacturaCity si hay match
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
async function listarGcsEnVentana(){
  const minDate = startDate();
  const [files] = await storage.bucket(GCS_BUCKET).getFiles({ prefix: 'facturas/' });
  const rows = (files || []).map(f => {
    const updated = new Date(f.metadata?.updated || f.metadata?.timeCreated || 0);
    // email por ruta: facturas/{email}/...
    const m = f.name.match(/^facturas\/([^/]+)\//);
    const email = m ? decodeURIComponent(m[1]).toLowerCase() : '';
    return {
      fuente: 'GCS',
      email,
      nombre: '', apellidos: '', nombreN: '', apellidosN: '',
      descripcion: '', descN: '',
      numero: null,
      fecha: updated, fechaStr: updated ? updated.toISOString().replace('T',' ').slice(0,19) : '',
      file: f.name
    };
  }).filter(r => r.fecha && r.fecha >= minDate);

  log(`📥 GCS: ${rows.length} ficheros en ventana (${WINDOW_DAYS} días).`);
  return rows;
}

function detectarDuplicadosGcs(rows){
  // Heurística: más de 1 PDF por email en la ventana → indicio
  const byEmail = new Map();
  for (const r of rows){
    if (!byEmail.has(r.email)) byEmail.set(r.email, []);
    byEmail.get(r.email).push(r);
  }
  const out = [];
  for (const [email, arr] of byEmail.entries()){
    if (email && arr.length >= 2){
      out.push({
        tipo: 'DUP_GCS_MULTI_PDF',
        email,
        count: arr.length,
        fechas: arr.map(x=>x.fechaStr).slice(0,6),
        files: arr.map(x=>x.file).slice(0,6),
        numerosFactura: [] // no disponible en GCS
      });
    }
  }
  log(`🔎 GCS indicios de duplicado (multi-PDF por email): ${out.length}`);
  return out;
}

// ───────────────────────── FACTURACITY ─────────────────────────
async function fetchFacturaCityList(fromDate, toDate){
  if (!FC_BASE || !FC_KEY) {
    warn('FacturaCity desactivado: falta FACTURACITY_API_URL o FACTURACITY_API_KEY');
    return [];
  }
  const from = toYMD(fromDate), to = toYMD(toDate);
  const tryCalls = [
    { path: '/facturas', headers: { 'Authorization': `Bearer ${FC_KEY}` } },
    { path: '/invoices', headers: { 'Authorization': `Bearer ${FC_KEY}` } },
    { path: '/facturas', headers: { 'X-API-KEY': FC_KEY } },
    { path: '/invoices', headers: { 'X-API-KEY': FC_KEY } },
  ];
  for (const t of tryCalls){
    const url = `${FC_BASE}${t.path}?from=${from}&to=${to}`;
    try{
      log(`🌐 FacturaCity GET ${url} [${Object.keys(t.headers)[0]}]`);
      const r = await fetch(url, { headers: { Accept:'application/json', ...t.headers } });
      if (!r.ok) { warn(`FacturaCity ${t.path} → HTTP ${r.status}`); continue; }
      const data = await r.json();
      const list = Array.isArray(data) ? data
                 : Array.isArray(data?.items) ? data.items
                 : Array.isArray(data?.data) ? data.data
                 : [];
      log(`✅ FacturaCity OK (${t.path}): ${list.length} registros`);
      return list.map(mapFCItem).filter(i => i.fecha && i.fecha >= fromDate && i.fecha <= toDate);
    }catch(e){
      warn(`FacturaCity error (${t.path}): ${e.message}`);
    }
  }
  warn('FacturaCity: no se pudo obtener listado con rutas/headers probados.');
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
  const numero = get(['numero','num','number','invoice_number','code']) || '';
  const fechaRaw = get(['fecha','created_at','date','issued_at','emitted_at']);
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
    // intenta separar
    const parts = String(nombre).trim().split(/\s+/);
    nombre = parts.shift() || '';
    // resto como apellidos
  }
  const descripcion = get(['concepto','descripcion','description','detalle','notes']) || '';
  const total = Number(get(['total','importe','amount','grand_total','total_amount']) || 0);
  return {
    fuente: 'FC',
    numero: String(numero).trim(),
    fecha,
    fechaStr: fecha ? fecha.toISOString().slice(0,19).replace('T',' ') : '',
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
  // por persona
  const byPerson = new Map();
  for (const it of items){
    const key = `${it.nombreN}||${it.apellidosN}`;
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(it);
  }
  for (const [key, arr] of byPerson.entries()){
    arr.sort((a,b)=>a.fecha-b.fecha);
    // misma descripción (grupos con descN)
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
    // descripciones distintas (prueba fuerte)
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

  // Obtener primera pestaña si no sabemos el nombre
  const meta = await sheets.spreadsheets.get({ spreadsheetId: AUDIT_SHEET_ID });
  const tabName = meta.data.sheets?.[0]?.properties?.title || AUDIT_SHEET_TAB_DEFAULT;

  const fechaAuditoria = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

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
async function enviarInformeEmail({ fcDup, shDup, gcsDup }){
  if (!process.env.SMTP2GO_API_KEY || !process.env.SMTP2GO_FROM_EMAIL) {
    warn('Email no enviado: faltan credenciales SMTP2GO');
    return;
  }
  const totalIncidencias = fcDup.length + shDup.length + gcsDup.length;
  if (totalIncidencias === 0) {
    log('📧 No se envía email: 0 incidencias.');
    return;
  }

  const fmtList = (arr) => arr.map(i => {
    const base = `<b>${i.nombre || ''} ${i.apellidos || ''}</b> — ${i.email || ''}`;
    const fechas = i.fechas?.join(' | ') || '';
    if (i.tipo.startsWith('DUP_FACTURACITY')) {
      const nums = i.numerosFactura?.length ? `Nºs: <code>${i.numerosFactura.join(', ')}</code><br/>` : '';
      const desc = i.descripcion ? `Desc: <i>${i.descripcion}</i><br/>` :
                   i.descripciones ? `Desc: <i>${i.descripciones.join(' · ')}</i><br/>` : '';
      return `<li>${base}<br/>${desc}${nums}Fechas: ${fechas}<br/>Coincidencias: ${i.count}</li>`;
    } else if (i.tipo.startsWith('DUP_SHEETS')) {
      const desc = i.descripcion ? `Desc: <i>${i.descripcion}</i><br/>` : '';
      return `<li>${base}<br/>${desc}Fechas: ${fechas}<br/>Coincidencias: ${i.count}</li>`;
    } else {
      // GCS
      const files = i.files?.length ? `Ficheros: <code>${i.files.join(' | ')}</code><br/>` : '';
      return `<li>${base}<br/>${files}Fechas: ${fechas}<br/>Coincidencias: ${i.count}</li>`;
    }
  }).join('\n');

  const html = `
    <div style="font-family:Arial, sans-serif; font-size:14px; color:#333">
      <p><b>Auditoría de duplicados (ventana ${WINDOW_DAYS} días)</b></p>
      <p>Total incidencias: <b>${totalIncidencias}</b></p>

      ${fcDup.length ? `<h4>FacturaCity</h4><ul>${fmtList(fcDup)}</ul>` : '<h4>FacturaCity</h4><p>Sin incidencias.</p>'}
      ${shDup.length ? `<h4>Google Sheets</h4><ul>${fmtList(shDup)}</ul>` : '<h4>Google Sheets</h4><p>Sin incidencias.</p>'}
      ${gcsDup.length ? `<h4>GCS</h4><ul>${fmtList(gcsDup)}</ul>` : '<h4>GCS</h4><p>Sin incidencias.</p>'}
    </div>
  `;

  const text = [
    `Auditoría duplicados (ventana ${WINDOW_DAYS} días)`,
    `Total incidencias: ${totalIncidencias}`,
    '',
    'FacturaCity:',
    ...fcDup.map(i => `- ${i.nombre||''} ${i.apellidos||''} | ${i.email||''} | ${i.descripcion||i.descripciones?.join(' · ')||''} | nums=${(i.numerosFactura||[]).join(',')} | fechas=${i.fechas?.join(' | ')||''} | x${i.count}`),
    '',
    'Google Sheets:',
    ...shDup.map(i => `- ${i.nombre||''} ${i.apellidos||''} | ${i.email||''} | ${i.descripcion||''} | fechas=${i.fechas?.join(' | ')||''} | x${i.count}`),
    '',
    'GCS:',
    ...gcsDup.map(i => `- ${i.email||''} | files=${(i.files||[]).join(' | ')} | fechas=${i.fechas?.join(' | ')||''} | x${i.count}`)
  ].join('\n');

  await enviarEmailPersonalizado({
    to: EMAIL_DEST,
    subject: `⚠️ Informe duplicados (Sheets+GCS+FacturaCity) — ${totalIncidencias} casos`,
    html,
    text
  });

  log(`📧 Informe enviado a ${EMAIL_DEST}`);
}

// ───────────────────────── HELPERS ─────────────────────────
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

    // 2) Detectar duplicados en cada fuente
    const shDup = detectarDuplicadosSheets(shRows);
    const gcsDup = detectarDuplicadosGcs(gcsRows);
    const fcDup = detectarDuplicadosFacturaCity(fcRows);

    // 3) Completar nº de factura en incidencias de Sheets con FacturaCity (si coincide persona)
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
        // dentro de ventana y misma descripción
        const nums = cand
          .filter(x => inc.descripcion && x.descN === normalizarTexto(inc.descripcion))
          .map(x => x.numero)
          .filter(Boolean);
        inc.numerosFactura = Array.from(new Set(nums));
      }
    }

    // 4) Emails afectados (unión)
    const emailsAfectados = Array.from(new Set([
      ...fcDup.map(i=>i.email).filter(Boolean),
      ...shDup.map(i=>i.email).filter(Boolean),
      ...gcsDup.map(i=>i.email).filter(Boolean),
    ]));

    // 5) Fechas resumen (tomamos las primeras de cada incidencia)
    const fechasResumen = [
      ...fcDup.flatMap(i => i.fechas || []).slice(0,6),
      ...shDup.flatMap(i => i.fechas || []).slice(0,6),
      ...gcsDup.flatMap(i => i.fechas || []).slice(0,6),
    ];

    // 6) Email informe si hay incidencias
    await enviarInformeEmail({ fcDup, shDup, gcsDup });

    // 7) Registrar en hoja de auditorías A–F
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
