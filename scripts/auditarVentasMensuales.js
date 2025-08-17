// scripts/auditarVentasMensuales.js
// Ejecuta: node scripts/auditarVentasMensuales.js

const { google } = require('googleapis');

// ───────────────────────── CONFIG ─────────────────────────
const COMPRAS_SHEET_ID = '1ShSiaz_TtODbVkczI1mfqTBj5nHb3xSEywyB0E6BL9I';
const COMPRAS_SHEET_TAB = 'Hoja 1'; // A: Nombre, B: Apellidos, C: DNI, D: Descripción, E: Importe, F: Fecha (es-ES), G: Email

// Registro “ESTADÍSTICAS” (ESCRITURA)
const STATS_SHEET_ID = '1NH7IW-I0XuDKoC5Kwwh2kpDCss-41YKLvntQeuybbgA';
const STATS_SHEET_TAB_DEFAULT = 'Hoja 1';

// Email
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
  if (s instanceof Date) return s;
  if (!s) return null;
  const t = String(s).replace(',', '');
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [_, d, mo, y, h='0', mi='0', se='0'] = m;
  return new Date(Date.UTC(+y, +mo-1, +d, +h, +mi, +se));
}

function fmtEUR(n){
  return new Intl.NumberFormat('es-ES', { style:'currency', currency:'EUR', minimumFractionDigits:2 }).format(Number(n||0));
}
function monthLabelES(d){
  return new Date(d).toLocaleDateString('es-ES', { month:'long', year:'numeric', timeZone:'Europe/Madrid' });
}
function yyyymm(d){ return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; }
function firstDayUTC(year, month0){ return new Date(Date.UTC(year, month0, 1, 0,0,0,0)); }
function lastDayUTC(year, month0){ return new Date(Date.UTC(year, month0+1, 0, 23,59,59,999)); }

// Devuelve { startPrev, endPrev, refMonthDate }
function previousMonthBounds(){
  const nowD = now();
  const y = nowD.getUTCFullYear();
  const m0 = nowD.getUTCMonth();
  const prevY = m0===0 ? y-1 : y;
  const prevM0 = m0===0 ? 11 : m0-1;
  return {
    startPrev: firstDayUTC(prevY, prevM0),
    endPrev: lastDayUTC(prevY, prevM0),
    refMonthDate: firstDayUTC(prevY, prevM0)
  };
}

function last12MonthsFrom(refMonthDate){
  // refMonthDate debe ser el primer día del mes de referencia (UTC)
  const arr = [];
  let y = refMonthDate.getUTCFullYear();
  let m0 = refMonthDate.getUTCMonth();
  for (let i=0;i<12;i++){
    const d = firstDayUTC(y, m0);
    arr.push(d);
    m0--;
    if (m0 < 0){ m0 = 11; y--; }
  }
  return arr; // orden: más reciente primero
}

// ───────────────────────── LECTURA SHEETS ─────────────────────────
async function leerComprasDeSheets(){
  const client = await sheetsAuth.getClient();
  const sheets = google.sheets({ version:'v4', auth: client });

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: COMPRAS_SHEET_ID,
    range: `${COMPRAS_SHEET_TAB}!A2:K`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });

  const rows = (data.values || []).map(r => {
    const [nombre, apellidos, dni, descripcion, importeRaw, fechaRaw, email] = r;
    const fecha = parseFechaESES(fechaRaw);
    let importe = 0;
    if (typeof importeRaw === 'number') importe = importeRaw;
    else if (typeof importeRaw === 'string') importe = Number(importeRaw.replace(/[€\s]/g,'').replace(',','.')) || 0;
    return {
      nombre: nombre || '',
      apellidos: apellidos || '',
      descripcion: descripcion || '',
      descN: normalizarTexto(descripcion || ''),
      importe,
      fecha,
      email: (email||'').toLowerCase().trim()
    };
  }).filter(r => r.fecha && !isNaN(r.fecha));

  log(`📥 Compras: ${rows.length} filas leídas de Sheets.`);
  return rows;
}

// ───────────────────────── ESTADÍSTICAS ─────────────────────────
function agruparPorDescripcion(rows){
  const map = new Map();
  for (const r of rows){
    const k = r.descN || '(sin descripcion)';
    if (!map.has(k)) map.set(k, { descripcion: r.descripcion || '(sin descripción)', count:0, total:0 });
    const it = map.get(k);
    it.count += 1;
    it.total += Number(r.importe||0);
  }
  // ORDEN POR IMPORTE (€) DESCENDENTE
  return Array.from(map.values()).sort((a,b) => b.total - a.total);
}

function totalesPorMesTodos(rows){
  // devuelve Map 'YYYY-MM' -> total €
  const mp = new Map();
  for (const r of rows){
    const k = yyyymm(r.fecha);
    mp.set(k, (mp.get(k)||0) + Number(r.importe||0));
  }
  return mp;
}

// ───────────────────────── ESCRITURA STATS SHEET ─────────────────────────
async function appendStatsRows({ mesLabel, items }){
  // Totales para la fila resumen
  const totalCount = items.reduce((s, x) => s + x.count, 0);
  const totalAmount = items.reduce((s, x) => s + Number(x.total||0), 0);

  const client = await sheetsAuth.getClient();
  const sheets = google.sheets({ version:'v4', auth: client });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: STATS_SHEET_ID });
  const sheet = meta.data.sheets?.[0];
  const tabName = sheet?.properties?.title || STATS_SHEET_TAB_DEFAULT;
  const sheetId = sheet?.properties?.sheetId;

  // ¿Cuántas filas de datos hay ya (debajo del header)?
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: STATS_SHEET_ID,
    range: `${tabName}!A2:A`
  });
  const existingCount = (existing.data.values || []).length; // filas reales debajo del header

  // 1) Añadir desglose (orden descendente) + 2) Fila resumen en la siguiente fila
  const values = [
    ...items.map(it => [
      mesLabel,                 // A
      it.descripcion,           // B
      String(it.count),         // C
      Number(it.total || 0)     // D (numérico)
    ]),
    [
      mesLabel,                                                     // A
      `TOTAL VENTAS ${mesLabel.toUpperCase()}`,                     // B
      String(totalCount),                                           // C
      Number(totalAmount)                                           // D (numérico)
    ]
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: STATS_SHEET_ID,
    range: `${tabName}!A2`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });

  // 3) Dar formato gris claro a la fila resumen (A:D)
  if (sheetId != null) {
    // Índices 0-based para GridRange:
    // header está en la fila 0, por tanto A2 corresponde a rowIndex=1
    const resumenRowIndex0 = 1 /*A2*/ + existingCount + items.length; // fila recién añadida después del desglose
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: STATS_SHEET_ID,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: resumenRowIndex0,
                endRowIndex: resumenRowIndex0 + 1,
                startColumnIndex: 0,
                endColumnIndex: 4
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.95, green: 0.95, blue: 0.95 }
                }
              },
              fields: 'userEnteredFormat.backgroundColor'
            }
          }
        ]
      }
    });
  }

  log(`📝 StatsSheet: añadidas ${items.length} filas + 1 resumen para ${mesLabel}.`);
}

// ───────────────────────── EMAIL ─────────────────────────
async function enviarInformeEmail({ monthLabel, totalMes, desglose, tablaComparativa, serie12Meses }){
  if (!process.env.SMTP2GO_API_KEY || !process.env.SMTP2GO_FROM_EMAIL) {
    warn('Email no enviado: faltan credenciales SMTP2GO');
    return;
  }

  const filasDesglose = desglose.map(it =>
    `<tr>
      <td style="padding:6px 8px;border:1px solid #ddd;">${it.descripcion}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:center;">${it.count}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${fmtEUR(it.total)}</td>
    </tr>`
  ).join('');

  const filasComparativa = tablaComparativa.map(row =>
    `<tr>
      <td style="padding:6px 8px;border:1px solid #ddd;">${row.mesActual}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${row.totalActual === null ? '-' : fmtEUR(row.totalActual)}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${row.mesPrevio}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${row.totalPrevio === null ? '-' : fmtEUR(row.totalPrevio)}</td>
    </tr>`
  ).join('');

  // Gráfica (barras DIV, 12 meses, orden más reciente → más antiguo)
  const maxVal = Math.max(...serie12Meses.map(x=>x.total||0), 1);
  const barras = serie12Meses.map(x => {
    const h = Math.round((x.total||0) / maxVal * 140);
    return `
      <div style="display:inline-block;width:28px;margin:0 6px;vertical-align:bottom;text-align:center;">
        <div title="${x.label}: ${fmtEUR(x.total||0)}" style="background:#4F46E5;height:${h}px;"></div>
        <div style="font-size:10px;margin-top:4px;white-space:nowrap;">${x.short}</div>
      </div>
    `;
  }).join('');

  const html = `
    <div style="font-family:Arial, sans-serif; font-size:14px; color:#333; line-height:1.45">
      <h2 style="margin:0 0 12px 0; font-size:20px;">Informe de ventas — ${monthLabel}</h2>

      <p style="font-size:18px; font-weight:bold; margin:8px 0;">
        Total ingresos ${monthLabel}: ${fmtEUR(totalMes)}
      </p>

      <h3 style="margin:18px 0 8px;">Desglose por producto (ordenado por importe, desc.)</h3>
      <table role="table" cellpadding="0" cellspacing="0" style="border-collapse:collapse;min-width:420px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Descripción</th>
            <th style="text-align:center;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Cantidad</th>
            <th style="text-align:right;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Total (€)</th>
          </tr>
        </thead>
        <tbody>${filasDesglose || `<tr><td colspan="3" style="padding:8px;border:1px solid #ddd;">Sin ventas registradas.</td></tr>`}</tbody>
      </table>

      <h3 style="margin:22px 0 8px;">Comparativa últimos 12 meses vs mismo mes año anterior</h3>
      <table role="table" cellpadding="0" cellspacing="0" style="border-collapse:collapse;min-width:520px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Mes</th>
            <th style="text-align:right;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Total mes</th>
            <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Mismo mes año previo</th>
            <th style="text-align:right;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Total año previo</th>
          </tr>
        </thead>
        <tbody>${filasComparativa}</tbody>
      </table>

      <h3 style="margin:22px 0 8px;">Gráfica de barras — últimos 12 meses</h3>
      <div style="border:1px solid #eee;padding:12px 8px 4px;height:180px;">
        <div style="display:flex;align-items:flex-end;height:160px;">${barras}</div>
      </div>
    </div>
  `;

  const text = [
    `Informe de ventas — ${monthLabel}`,
    `Total ingresos ${monthLabel}: ${fmtEUR(totalMes)}`,
    ``,
    `Desglose por producto (importe desc.):`,
    ...desglose.map(it => `- ${it.descripcion}: ${it.count} uds → ${fmtEUR(it.total)}`),
  ].join('\n');

  await enviarEmailPersonalizado({
    to: EMAIL_DEST,
    subject: `📈 Ventas ${monthLabel} — Total ${fmtEUR(totalMes)}`,
    html,
    text
  });

  log(`📧 Informe mensual enviado a ${EMAIL_DEST}`);
}

// ───────────────────────── RUNNER ─────────────────────────
(async () => {
  try {
    log('🚀 Informe mensual de ventas — inicio');

    // 1) Leer todas las compras
    const rows = await leerComprasDeSheets();

    // 2) Ventana del mes anterior
    const { startPrev, endPrev, refMonthDate } = previousMonthBounds();
    const monthLabel = monthLabelES(refMonthDate);

    const prevRows = rows.filter(r => r.fecha >= startPrev && r.fecha <= endPrev);

    // 3) Total del mes anterior + desglose por producto (orden importe desc)
    const totalMes = prevRows.reduce((acc,r) => acc + Number(r.importe||0), 0);
    const desglose = agruparPorDescripcion(prevRows);

    // 4) Comparativa 12 meses (desc), y serie para gráfica
    const totalsMap = totalesPorMesTodos(rows);
    const meses = last12MonthsFrom(refMonthDate); // más reciente primero

    const tablaComparativa = meses.map(d => {
      const keyAct = yyyymm(d);
      const act = totalsMap.has(keyAct) ? totalsMap.get(keyAct) : 0;

      const prevY = d.getUTCFullYear() - 1;
      const prevM0 = d.getUTCMonth();
      const dPrev = firstDayUTC(prevY, prevM0);
      const keyPrev = yyyymm(dPrev);
      const prev = totalsMap.has(keyPrev) ? totalsMap.get(keyPrev) : null; // null = “-”

      return {
        mesActual: monthLabelES(d),
        totalActual: act,
        mesPrevio: monthLabelES(dPrev),
        totalPrevio: prev
      };
    });

    const serie12Meses = meses.map(d => ({
      label: monthLabelES(d),
      short: d.toLocaleDateString('es-ES', { month:'short', timeZone:'Europe/Madrid' }),
      total: totalsMap.get(yyyymm(d)) || 0
    }));

    // 5) Email SIEMPRE
    await enviarInformeEmail({ monthLabel, totalMes, desglose, tablaComparativa, serie12Meses });

    // 6) Registrar en hoja “ESTADÍSTICAS”: desglose + fila resumen con fondo gris
    await appendStatsRows({
      mesLabel: monthLabel,
      items: desglose
    });

    log('✅ Informe mensual de ventas — fin');
  } catch (e) {
    console.error('❌ Error informe mensual:', e.stack || e.message || e);
    process.exit(1);
  }
})();
