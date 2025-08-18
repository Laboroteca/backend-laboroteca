// scripts/auditarFacturas.js
// Ejecuta: node scripts/auditarFacturas.js

const { google } = require('googleapis');
const { Storage } = require('@google-cloud/storage');

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
              numerosFactura: []
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
// Heurística: agrupar por EMAIL + SLUG (nombre lógico del documento)
// Espera rutas tipo: facturas/{email}/{timestamp}-{slug}.pdf
function extractEmailFromPath(path){
  const m = String(path).match(/^facturas\/([^/]+)\//);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
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
  for (const arr of byKey.values()){
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
async function enviarInformeEmail({ shDup, gcsDup, totales, resumen }){
  if (!process.env.SMTP2GO_API_KEY || !process.env.SMTP2GO_FROM_EMAIL) {
    warn('Email no enviado: faltan credenciales SMTP2GO');
    return;
  }

  const totalIncidencias = shDup.length + gcsDup.length;

  const fmtList = (arr) => arr.map(i => {
    const base = `<b>${i.nombre || ''} ${i.apellidos || ''}</b> — ${i.email || ''}`;
    const fechas = i.fechas?.join(' | ') || '';
    if (i.tipo?.startsWith('DUP_SHEETS')) {
      const desc = i.descripcion ? `Desc: <i>${i.descripcion}</i><br/>` : '';
      return `<li>${base}<br/>${desc}Fechas: ${fechas}<br/>Coincidencias: ${i.count}</li>`;
    } else {
      const files = i.files?.length ? `Ficheros: <code>${i.files.join(' | ')}</code><br/>` : '';
      const title = i.slug ? `<i>${i.slug}</i><br/>` : '';
      return `<li>${i.email || '—'}<br/>${title}${files}Fechas: ${fechas}<br/>Coincidencias: ${i.count}</li>`;
    }
  }).join('\n');

  const html = `
    <div style="font-family:Arial, sans-serif; font-size:14px; color:#333">
      <p><b>Auditoría diaria (ventana ${WINDOW_DAYS} días)</b></p>

      <p><b>Facturas emitidas (según GCS) en ${WINDOW_DAYS} días:</b> ${totales.gcsEmitidas}</p>
      <p><b>Facturas emitidas (según Sheets) en ${WINDOW_DAYS} días:</b> ${totales.sheetsEmitidas}</p>

      <p><b>Duplicados detectados</b> — Total incidencias: <b>${totalIncidencias}</b></p>
      <ul style="margin-top:0">
        <li>Google Sheets: <b>${shDup.length}</b></li>
        <li>GCS (por documento): <b>${gcsDup.length}</b></li>
      </ul>

      <p><b style="color:#c00">Para máxima seguridad, revisa Facturacity.</b></p>

      <h4>Resumen de fechas</h4>
      <p>${resumen.fechasResumen.length ? resumen.fechasResumen.join(' | ') : '—'}</p>

      <h3>Detalle</h3>
      ${shDup.length ? `<h4>Google Sheets</h4><ul>${fmtList(shDup)}</ul>` : '<h4>Google Sheets</h4><p>Sin incidencias.</p>'}
      ${gcsDup.length ? `<h4>GCS</h4><ul>${fmtList(gcsDup)}</ul>` : '<h4>GCS</h4><p>Sin incidencias.</p>'}
    </div>
  `;

  const text = [
    `Auditoría diaria (ventana ${WINDOW_DAYS} días)`,
    `Facturas emitidas (según GCS) en ${WINDOW_DAYS} días: ${totales.gcsEmitidas}`,
    `Facturas emitidas (según Sheets) en ${WINDOW_DAYS} días: ${totales.sheetsEmitidas}`,
    '',
    `Duplicados — total incidencias: ${totalIncidencias}`,
    `- Google Sheets: ${shDup.length}`,
    `- GCS (por documento): ${gcsDup.length}`,
    '',
    '*** Para máxima seguridad, revisa Facturacity. ***',
    '',
    'Resumen de fechas:',
    resumen.fechasResumen.join(' | ') || '—',
  ].join('\n');

  await enviarEmailPersonalizado({
    to: EMAIL_DEST,
    subject: `📊 Auditoría diaria — GCS:${totales.gcsEmitidas} | Sheets:${totales.sheetsEmitidas} | Dups SH:${shDup.length} GCS:${gcsDup.length}`,
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
    const [shRows, gcsRows] = await Promise.all([
      leerComprasDeSheets(),
      listarGcsEnVentana()
    ]);

    // Totales de facturas emitidas según cada fuente (en la ventana)
    const totales = {
      gcsEmitidas: gcsRows.length,
      sheetsEmitidas: shRows.length
    };

    // 2) Detectar duplicados
    const shDup = detectarDuplicadosSheets(shRows);
    const gcsDup = detectarDuplicadosGcs(gcsRows);

    // 3) Emails afectados (unión)
    const emailsAfectados = Array.from(new Set([
      ...shDup.map(i=>i.email).filter(Boolean),
      ...gcsDup.map(i=>i.email).filter(Boolean),
    ]));

    // 4) Fechas resumen (tomamos las primeras de cada incidencia)
    const fechasResumen = [
      ...shDup.flatMap(i => i.fechas || []).slice(0,6),
      ...gcsDup.flatMap(i => i.fechas || []).slice(0,6),
    ];

    // 5) Enviar email SIEMPRE
    await enviarInformeEmail({
      shDup, gcsDup, totales,
      resumen: { fechasResumen }
    });

    // 6) Registrar en hoja de auditorías (manteniendo esquema)
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
