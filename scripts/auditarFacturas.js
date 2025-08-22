// scripts/auditarFacturas.js
// Ejecuta: node scripts/auditarFacturas.js

const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');
const admin = require('../firebase');
const db = admin.firestore();

// ───────────────────────── CONFIG ─────────────────────────
const WINDOW_DAYS = 25;

// Compras (LECTURA)
const COMPRAS_SHEET_ID = '1Mtffq42G7Q0y44ekzvy7IWPS8obvN4pNahA-08igdGk';
const COMPRAS_SHEET_TAB = 'Hoja 1'; // A: Nombre, B: Apellidos, C: DNI, D: Descripción, E: Importe, F: Fecha (es-ES), G: Email

// Registro auditorías (ESCRITURA)
const AUDIT_SHEET_ID = '1P39jEoMGO3fxFmFGDKKECxa9sV4xk_N3rv1wXrJyYJM';
const AUDIT_SHEET_TAB_DEFAULT = 'Hoja 1';

// GCS PDFs
const GCS_BUCKET = process.env.GOOGLE_CLOUD_BUCKET || 'laboroteca-facturas';

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

// ───────────────────────── FIRESTORE (FACTURAS) ─────────────────────────
const FB_REQUIRED_FIELDS = [
  'descripcionProducto','email','fechaISO','fechaTexto','idfactura',
  'importeTotalIVA','insertadoEn','invoiceId','moneda','numeroFactura','tipo'
];
// Estos campos pueden ser null y se consideran "presentes"
const FB_NULL_OK = new Set(['invoiceId','tipo']);

function _isMissingField(doc, key){
  if (!(key in doc)) return true;
  const v = doc[key];
  if (v === undefined) return true;
  if (v === null) return !FB_NULL_OK.has(key);
  if (typeof v === 'string' && v.trim() === '') return true;
  return false;
}

async function leerFacturasDeFirestore(){
  const minDate = startDate();
  const minISO = minDate.toISOString();

  // Intentamos filtrar por fechaISO >= minISO (ISO lexicográfico)
  let snap;
  try {
    snap = await db.collection('facturas').where('fechaISO', '>=', minISO).get();
  } catch (_e) {
    // Fallback sin filtro (menos eficiente)
    snap = await db.collection('facturas').get();
  }

  const rows = [];
  const incompletas = [];

  snap.forEach(doc => {
    const f = doc.data() || {};
    const fechaISO = f.fechaISO || f.insertadoEn || null;
    const d = fechaISO ? new Date(fechaISO) : null;
    if (!d || d < minDate) return;

    const email = String(f.email || '').toLowerCase().trim();
    const descripcion = String(f.descripcionProducto || '');
    const descN = normalizarTexto(descripcion);
    const day = (fechaISO || '').slice(0,10);
    const importe = Number(f.importeTotalIVA || 0);
    const numeroFactura = (f.numeroFactura !== undefined && f.numeroFactura !== null) ? String(f.numeroFactura) : '';

    // chequeo de completitud de campos requeridos
    const missing = FB_REQUIRED_FIELDS.filter(k => _isMissingField(f, k));
    if (missing.length) {
      incompletas.push({
        id: doc.id,
        email,
        numeroFactura,
        faltan: missing,
        fechaISO
      });
    }

    rows.push({
      fuente: 'FIREBASE',
      id: doc.id,
      email,
      descripcion,
      descN,
      day,
      importe,
      numeroFactura,
      fechaISO,
      fechaStr: fmtES(fechaISO),
      invoiceId: (f.invoiceIdStripe || f.invoiceId || null)
    });
  });

  log(`📥 Firebase (facturas): ${rows.length} registros en ventana de ${WINDOW_DAYS} días. Incompletas: ${incompletas.length}`);
  return { rows, incompletas };
}

function detectarDuplicadosFirebase(rows){
  // regla: agrupar por invoiceId (si existe), si no por email+descN+importe+day
  const grupos = new Map();
  for (const r of rows){
    const key = r.invoiceId
      ? `inv:${String(r.invoiceId)}`
      : `e=${r.email}|d=${r.descN}|i=${r.importe.toFixed(2)}|day=${r.day}`;

    if (!grupos.has(key)) grupos.set(key, { numeros: new Set(), filas: [] });
    const g = grupos.get(key);
    if (r.numeroFactura) g.numeros.add(r.numeroFactura);
    g.filas.push(r);
  }

  const out = [];
  for (const [key, g] of grupos.entries()){
    if (g.numeros.size > 1) {
      const filas = g.filas.slice().sort((a,b)=>String(a.fechaISO||'').localeCompare(String(b.fechaISO||'')));
      out.push({
        tipo: 'DUP_FIREBASE_MULTI_NUM',
        key,
        email: filas[0]?.email || '',
        descripcion: filas[0]?.descripcion || '',
        day: filas[0]?.day || '',
        importe: filas[0]?.importe || 0,
        count: filas.length,
        numerosFactura: Array.from(g.numeros),
        fechas: filas.map(x => x.fechaStr),
        docs: filas.map(x => x.id)
      });
    }
  }
  log(`🔎 Firebase duplicados por compra (múltiples números de factura): ${out.length}`);
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
              numerosFactura: [] // no disponible en Sheets
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
// Heurística: agrupar por EMAIL/identificador + SLUG (nombre lógico del documento)
// Soporta tanto email real como hash en la ruta.
function extractKeyFromPath(path){
  const m = String(path).match(/^facturas\/([^/]+)\//);
  return m ? decodeURIComponent(m[1]).toLowerCase() : ''; // puede ser email o hash
}
function extractSlugFromPath(path){
  const m = String(path).match(/\/\d{10,}-([^/]+)\.pdf$/i);
  if (m) return m[1].toLowerCase();
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
      key: extractKeyFromPath(f.name),     // email o hash
      slug: extractSlugFromPath(f.name),
      fecha: updated,
      fechaStr: fmtES(updated),
      file: f.name
    };
  }).filter(r => r.fecha && r.fecha >= minDate);

  log(`📥 GCS: ${rows.length} ficheros en ventana (${WINDOW_DAYS} días).`);
  return rows;
}

function detectarDuplicadosGcs(rows){
  // Incidencias por (key + slug) con >= 2 PDFs en la ventana
  const byKey = new Map();
  for (const r of rows){
    const k = `${r.key}||${r.slug}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const out = [];
  for (const arr of byKey.values()){
    if (!arr[0].key || !arr[0].slug) continue;
    if (arr.length >= 2){
      out.push({
        tipo: 'DUP_GCS_MULTI_PDF',
        key: arr[0].key,
        slug: arr[0].slug,
        count: arr.length,
        fechas: arr.map(x=>x.fechaStr).slice(0,20),
        files: arr.map(x=>x.file).slice(0,20),
        numerosFactura: [] // no disponible
      });
    }
  }
  log(`🔎 GCS duplicados por documento: ${out.length}`);
  return out;
}

// ───────────────────────── AUDIT SHEET (A–F) ─────────────────────────
async function appendAuditRow({ countSheets, countGcs, emailsAfectados, fechasResumen }){
  const client = await sheetsAuth.getClient();
  const sheets = google.sheets({ version:'v4', auth: client });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: AUDIT_SHEET_ID });
  const tabName = meta.data.sheets?.[0]?.properties?.title || AUDIT_SHEET_TAB_DEFAULT;

  const fechaAuditoria = new Date().toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' });

  // Conservamos el esquema A–F (con D como 0 para compatibilidad histórica)
  const row = [
    fechaAuditoria,               // A
    String(countSheets),          // B (dups Sheets)
    String(countGcs),             // C (dups GCS)
    '0',                          // D (antes FacturaCity)
    emailsAfectados.join('; ').slice(0, 1000), // E
    fechasResumen.join('; ').slice(0, 1000)    // F
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: AUDIT_SHEET_ID,
    range: `${tabName}!A2`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] }
  });

  log(`📝 AuditSheet: fila añadida → A:${fechaAuditoria} B:${countSheets} C:${countGcs} D:0`);
}

// ───────────────────────── EMAIL ─────────────────────────
async function enviarInformeEmail({ fbDup, shDup, gcsDup, totales, resumen, fbComplecion }){
  if (!process.env.SMTP2GO_API_KEY || !process.env.SMTP2GO_FROM_EMAIL) {
    warn('Email no enviado: faltan credenciales SMTP2GO');
    return;
  }

  const totalIncidencias = fbDup.length + shDup.length + gcsDup.length;

  const fmtListFB = (arr) => arr.map(i => {
    const persona = i.email || '—';
    const desc = i.descripcion ? `Desc: <i>${i.descripcion}</i><br/>` : '';
    const numeros = i.numerosFactura?.length ? `Nº factura: <b>${i.numerosFactura.join(', ')}</b><br/>` : '';
    const fechas = i.fechas?.length ? `Fechas: ${i.fechas.join(' | ')}<br/>` : '';
    return `<li><b>${persona}</b><br/>${desc}${numeros}${fechas}Coincidencias: ${i.count}</li>`;
  }).join('\n');

  const fmtListSH = (arr) => arr.map(i => {
    const base = `<b>${i.nombre || ''} ${i.apellidos || ''}</b> — ${i.email || ''}`;
    const fechas = i.fechas?.join(' | ') || '';
    const desc = i.descripcion ? `Desc: <i>${i.descripcion}</i><br/>` : '';
    return `<li>${base}<br/>${desc}Fechas: ${fechas}<br/>Coincidencias: ${i.count}</li>`;
  }).join('\n');

  const fmtListGCS = (arr) => arr.map(i => {
    const files = i.files?.length ? `Ficheros: <code>${i.files.join(' | ')}</code><br/>` : '';
    const title = i.slug ? `<i>${i.slug}</i><br/>` : '';
    return `<li>${i.key || '—'}<br/>${title}${files}Fechas: ${i.fechas?.join(' | ') || ''}<br/>Coincidencias: ${i.count}</li>`;
  }).join('\n');

  const fbAviso = fbComplecion.completo
    ? `<span style="color:#080">Constan todos los datos necesarios</span>`
    : `<span style="color:#c00">Faltan datos por registrar</span> (${fbComplecion.faltantes.length} documentos)`;

  const html = `
    <div style="font-family:Arial, sans-serif; font-size:14px; color:#333">
      <p><b>Auditoría (ventana ${WINDOW_DAYS} días)</b></p>

      <p><b>Facturas emitidas (según Firebase):</b> ${totales.firebaseEmitidas}<br/>
         ${fbAviso}
      </p>
      <p><b>Facturas emitidas (según Sheets):</b> ${totales.sheetsEmitidas}</p>
      <p><b>Facturas emitidas (según GCS):</b> ${totales.gcsEmitidas}</p>

      <p><b>Duplicados detectados</b> — Total incidencias: <b>${totalIncidencias}</b></p>
      <ul style="margin-top:0">
        <li>Firebase: <b>${fbDup.length}</b></li>
        <li>Google Sheets: <b>${shDup.length}</b></li>
        <li>GCS (por documento): <b>${gcsDup.length}</b></li>
      </ul>

      <h4>Resumen de fechas</h4>
      <p>${resumen.fechasResumen.length ? resumen.fechasResumen.join(' | ') : '—'}</p>

      <h3>Detalle</h3>
      ${fbDup.length ? `<h4>Firebase</h4><ul>${fmtListFB(fbDup)}</ul>` : '<h4>Firebase</h4><p>Sin incidencias.</p>'}
      ${shDup.length ? `<h4>Google Sheets</h4><ul>${fmtListSH(shDup)}</ul>` : '<h4>Google Sheets</h4><p>Sin incidencias.</p>'}
      ${gcsDup.length ? `<h4>GCS</h4><ul>${fmtListGCS(gcsDup)}</ul>` : '<h4>GCS</h4><p>Sin incidencias.</p>'}
    </div>
  `;

  const text = [
    `Auditoría (ventana ${WINDOW_DAYS} días)`,
    `Facturas emitidas (Firebase): ${totales.firebaseEmitidas} — ${fbComplecion.completo ? 'Constan todos los datos necesarios' : `Faltan datos por registrar (${fbComplecion.faltantes.length})`}`,
    `Facturas emitidas (Sheets): ${totales.sheetsEmitidas}`,
    `Facturas emitidas (GCS): ${totales.gcsEmitidas}`,
    '',
    `Duplicados — total incidencias: ${totalIncidencias}`,
    `- Firebase: ${fbDup.length}`,
    `- Google Sheets: ${shDup.length}`,
    `- GCS (por documento): ${gcsDup.length}`,
    '',
    'Resumen de fechas:',
    resumen.fechasResumen.join(' | ') || '—',
  ].join('\n');

  await enviarEmailPersonalizado({
    to: EMAIL_DEST,
    subject:
      `📊 Auditoría — FB:${totales.firebaseEmitidas} SH:${totales.sheetsEmitidas} GCS:${totales.gcsEmitidas} | Dups FB:${fbDup.length} SH:${shDup.length} GCS:${gcsDup.length}`,
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
    const [{ rows: fbRows, incompletas: fbIncompletas }, shRows, gcsRows] = await Promise.all([
      leerFacturasDeFirestore(),
      leerComprasDeSheets(),
      listarGcsEnVentana()
    ]);

    // Totales en la ventana
    const totales = {
      firebaseEmitidas: fbRows.length,
      sheetsEmitidas: shRows.length,
      gcsEmitidas: gcsRows.length
    };

    // 2) Detectar duplicados
    const fbDup = detectarDuplicadosFirebase(fbRows);
    const shDup = detectarDuplicadosSheets(shRows);
    const gcsDup = detectarDuplicadosGcs(gcsRows);

    // 3) Compleción Firebase
    const fbComplecion = {
      completo: fbIncompletas.length === 0,
      faltantes: fbIncompletas.slice(0, 25) // mostramos (si quisiéramos loguear o usar después)
    };

    // 4) Fechas resumen (tomamos las primeras de cada incidencia)
    const fechasResumen = [
      ...fbDup.flatMap(i => i.fechas || []).slice(0,6),
      ...shDup.flatMap(i => i.fechas || []).slice(0,6),
      ...gcsDup.flatMap(i => i.fechas || []).slice(0,6),
    ];

    // 5) Enviar email SIEMPRE (Firebase → Sheets → GCS)
    await enviarInformeEmail({
      fbDup, shDup, gcsDup, totales,
      resumen: { fechasResumen },
      fbComplecion
    });

    // 6) Registrar en hoja de auditorías (manteniendo esquema antiguo)
    const emailsAfectados = Array.from(new Set([
      ...fbDup.map(i=>i.email).filter(Boolean),
      ...shDup.map(i=>i.email).filter(Boolean),
      ...gcsDup.map(i=>i.key).filter(Boolean),
    ]));

    await appendAuditRow({
      countSheets: shDup.length,
      countGcs: gcsDup.length,
      emailsAfectados,
      fechasResumen
    });

    log('✅ Auditoría finalizada.');
  }catch(e){
    console.error('❌ Error auditoría:', e.stack || e.message || e);
    process.exit(1);
  }
})();
