// scripts/auditarVentasMensuales.js
// Ejecuta: node scripts/auditarVentasMensuales.js  (o npm run audit:ventas)

const { google } = require('googleapis');
const admin = require('../firebase');               // ← Firebase Admin inicializado en tu proyecto
const firestore = admin.firestore();
const { enviarEmailPersonalizado } = require('../services/email');

// ───────── CONFIG ─────────
const COMPRAS_SHEET_ID = '1Mtffq42G7Q0y44ekzvy7IWPS8obvN4pNahA-08igdGk';
const COMPRAS_SHEET_TAB = 'Hoja 1'; // A: Nombre, B: Apellidos, C: DNI, D: Descripción, E: Importe, F: Fecha, G: Email

const STATS_SHEET_ID = '1NH7IW-I0XuDKoC5Kwwh2kpDCss-41YKLvntQeuybbgA';
const STATS_SHEET_TAB_DEFAULT = 'Hoja 1';

const EMAIL_DEST = 'laboroteca@gmail.com';
const EMAIL_CC   = 'ignacio.solsona@icacs.com';

// Auth Sheets
if (!process.env.GCP_CREDENTIALS_BASE64) throw new Error('❌ Falta GCP_CREDENTIALS_BASE64');
const credentials = JSON.parse(Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8'));
const sheetsAuth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ───────── Utils ─────────
const fmtEUR = (n) => {
  // Aseguramos coma como separador decimal y símbolo €
  // Intl ya lo hace en es-ES; reemplazamos NBSP por espacio normal por si acaso.
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' })
    .format(Number(n || 0)).replace(/\u00A0/g, ' ');
};

function monthLabelESFrom(year, month1) {
  const d = new Date(Date.UTC(year, month1 - 1, 1));
  return d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' });
}

function madridNowYearMonth() {
  const parts = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  return {
    year: Number(parts.find(p => p.type === 'year').value),
    month1: Number(parts.find(p => p.type === 'month').value)
  };
}

function previousYearMonth() {
  const { year, month1 } = madridNowYearMonth();
  return month1 === 1 ? { year: year - 1, month1: 12 } : { year, month1: month1 - 1 };
}

function yyyymmFrom(year, month1) { return `${year}-${String(month1).padStart(2, '0')}`; }

function parseFechaFromExcelNumber(n) {
  const ms = Math.round(n * 86400000);
  const date = new Date(Date.UTC(1899, 11, 30) + ms);
  const parts = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' }).formatToParts(date);
  const year = Number(parts.find(p => p.type === 'year').value);
  const month1 = Number(parts.find(p => p.type === 'month').value);
  return { date, year, month1, yyyymm: yyyymmFrom(year, month1) };
}

function parseFechaCell(fechaCell) {
  if (!fechaCell) return null;
  if (typeof fechaCell === 'number') return parseFechaFromExcelNumber(fechaCell);

  if (typeof fechaCell === 'string') {
    const s = fechaCell.trim();
    // Admite dd/m/yyyy o dd/mm/yyyy, con o sin cero inicial
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) {
      const day = +m[1], month1 = +m[2], yearRaw = +m[3];
      const year = yearRaw < 100 ? (2000 + yearRaw) : yearRaw; // soporte opcional a YY
      const date = new Date(Date.UTC(year, month1 - 1, day));
      return { date, year, month1, yyyymm: yyyymmFrom(year, month1) };
    }
    // ISO
    const dISO = new Date(s);
    if (!isNaN(dISO)) {
      const parts = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' }).formatToParts(dISO);
      const year = Number(parts.find(p => p.type === 'year').value);
      const month1 = Number(parts.find(p => p.type === 'month').value);
      return { date: dISO, year, month1, yyyymm: yyyymmFrom(year, month1) };
    }
    return null;
  }

  // Firestore Timestamp o Date
  if (fechaCell && typeof fechaCell === 'object') {
    // Timestamp de Firestore
    if (typeof fechaCell.toDate === 'function') {
      const d = fechaCell.toDate();
      const parts = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' }).formatToParts(d);
      const year = Number(parts.find(p => p.type === 'year').value);
      const month1 = Number(parts.find(p => p.type === 'month').value);
      return { date: d, year, month1, yyyymm: yyyymmFrom(year, month1) };
    }
    // Date nativo
    if (fechaCell instanceof Date && !isNaN(fechaCell)) {
      const parts = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' }).formatToParts(fechaCell);
      const year = Number(parts.find(p => p.type === 'year').value);
      const month1 = Number(parts.find(p => p.type === 'month').value);
      return { date: fechaCell, year, month1, yyyymm: yyyymmFrom(year, month1) };
    }
  }
  return null;
}

function parseImporteCell(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  // Quita € y espacios, quita separadores de miles y usa coma como decimal si viniera así
  const n = Number(String(v).trim().replace(/[€\s]/g,'').replace(/\.(?=\d{3}(\D|$))/g,'').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function lastNMonthsYYYYMM(n, y, m1) {
  const out = []; let Y=y, M=m1;
  for(let i=0;i<n;i++){ out.push({year:Y, month1:M, yyyymm: yyyymmFrom(Y,M)}); M--; if(M===0){M=12; Y--;} }
  return out;
}

function agruparPorDescripcion(rowsDelMes) {
  const map = new Map();
  for (const r of rowsDelMes) {
    const key = (r.descripcion || '').trim();
    if (!key) continue;
    if (!map.has(key)) map.set(key, { descripcion: key, count: 0, total: 0 });
    const it = map.get(key);
    it.count += 1;
    it.total += Number(r.importe || 0);
  }
  return Array.from(map.values()).sort((a,b) => b.total - a.total);
}

function totalesPorMesTodos(rows) {
  const mp = new Map();
  for (const r of rows) {
    const k = r.fecha?.yyyymm;
    if (!k) continue;
    mp.set(k, (mp.get(k)||0) + Number(r.importe||0));
  }
  return mp;
}

// ───────── Lectura compras (Sheets) ─────────
async function leerComprasDeSheets() {
  const client = await sheetsAuth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: COMPRAS_SHEET_ID,
    range: `${COMPRAS_SHEET_TAB}!A2:K`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const rows = (data.values || []).map(r => {
    const [nombre, apellidos, dni, desc, impRaw, fechaRaw, email] = r;
    return {
      descripcion: (desc || '').toString().trim(),
      importe: parseImporteCell(impRaw),
      fecha: parseFechaCell(fechaRaw), // {yyyymm,...} o null
      email: (email || '').toLowerCase().trim(),
    };
  }).filter(r => r.fecha && r.fecha.yyyymm && r.descripcion);

  return rows;
}

// ───────── Lectura compras (FIREBASE) ─────────
// Colección: "facturas" con campos que esperamos:
//   - descripcionProducto (string)
//   - fecha / fechaISO / fechaTexto (acepto cualquiera; parseo genérico)
//   - importeTotalIVA (number o string con punto)
async function leerComprasDeFirebase() {
  const snap = await firestore.collection('facturas').get();

  const rows = [];
  snap.forEach(doc => {
    const d = doc.data() || {};
    const desc = (d.descripcionProducto || d.descripcion || '').toString().trim();
    const importe = (typeof d.importeTotalIVA === 'number')
      ? d.importeTotalIVA
      : parseImporteCell(d.importeTotalIVA);

    // fecha puede venir en: d.fecha, d.fechaISO, d.fechaTexto, o Timestamp d.fechaTS
    const fechaVal = d.fecha ?? d.fechaISO ?? d.fechaTexto ?? d.fechaTS ?? d.fechaTimestamp;
    const fecha = parseFechaCell(fechaVal);

    if (desc && fecha && fecha.yyyymm) {
      rows.push({ descripcion: desc, importe: Number(importe || 0), fecha });
    }
  });

  return rows;
}

// ───────── Escritura hoja “ESTADÍSTICAS” (Sheets) ─────────
async function appendStatsRows({ mesLabel, items }) {
  const totalCount = items.reduce((s, x) => s + x.count, 0);
  const totalAmount = items.reduce((s, x) => s + Number(x.total || 0), 0);

  const client = await sheetsAuth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: STATS_SHEET_ID });
  const sheet = meta.data.sheets?.[0];
  const tabName = sheet?.properties?.title || STATS_SHEET_TAB_DEFAULT;
  const sheetId = sheet?.properties?.sheetId;

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: STATS_SHEET_ID,
    range: `${tabName}!A2:A`
  });
  const existingCount = (existing.data.values || []).length;

  const values = [
    ...items.map(it => [ mesLabel, it.descripcion, String(it.count), Number(it.total) ]),
    [ '', `TOTAL VENTAS ${mesLabel.toUpperCase()}`, String(totalCount), Number(totalAmount) ],
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: STATS_SHEET_ID,
    range: `${tabName}!A2`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  if (sheetId == null) return;

  const startRow = 1 + existingCount;
  const endRow   = startRow + values.length;
  const totalRow = endRow - 1;

  const requests = [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: 0, endColumnIndex: 4 },
        cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 }, textFormat: { bold: false } } },
        fields: 'userEnteredFormat(backgroundColor,textFormat.bold)',
      }
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: 3, endColumnIndex: 4 },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00 €' }, horizontalAlignment: 'RIGHT' } },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      }
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: totalRow, endRowIndex: totalRow + 1, startColumnIndex: 0, endColumnIndex: 4 },
        cell: { userEnteredFormat: { backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 }, textFormat: { bold: true } } },
        fields: 'userEnteredFormat(backgroundColor,textFormat.bold)',
      }
    }
  ];

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: STATS_SHEET_ID,
    requestBody: { requests },
  });
}

// ───────── Email ─────────
function htmlTablaDesglose(desglose) {
  const filas = desglose.map(it => `
    <tr>
      <td style="padding:6px 8px;border:1px solid #ddd;">${it.descripcion}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:center;">${it.count}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${fmtEUR(it.total)}</td>
    </tr>`).join('');
  return `
    <table role="table" cellpadding="0" cellspacing="0" style="border-collapse:collapse;min-width:420px;">
      <thead><tr>
        <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Descripción</th>
        <th style="text-align:center;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Cantidad</th>
        <th style="text-align:right;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Total (€)</th>
      </tr></thead>
      <tbody>${filas || `<tr><td colspan="3" style="padding:8px;border:1px solid #ddd;">Sin ventas registradas.</td></tr>`}</tbody>
    </table>
  `;
}

function htmlBarras12m(serie12Meses) {
  const maxVal = Math.max(...serie12Meses.map(x => x.total || 0), 1);
  const barras = serie12Meses.map(x => {
    const h = Math.round(((x.total || 0) / maxVal) * 140);
    return `<div style="display:inline-block;width:28px;margin:0 6px;vertical-align:bottom;text-align:center;">
      <div title="${x.label}: ${fmtEUR(x.total || 0)}" style="height:${h}px;background:#4F46E5;"></div>
      <div style="font-size:10px;margin-top:4px;white-space:nowrap;">${x.short}</div>
    </div>`;
  }).join('');
  return `
    <div style="border:1px solid #eee;padding:12px 8px 4px;height:180px;">
      <div style="display:flex;align-items:flex-end;height:160px;">${barras}</div>
    </div>
  `;
}

async function enviarInformeEmailDoble(payload) {
  if (!process.env.SMTP2GO_API_KEY || !process.env.SMTP2GO_FROM_EMAIL) return;

  const {
    monthLabel,
    // FIREBASE
    totalMesFB, desgloseFB, serie12MesesFB,
    // SHEETS
    totalMesSH, desgloseSH, serie12MesesSH,
  } = payload;

  const htmlFB = `
    <h2 style="margin:0 0 12px 0; font-size:20px;">
      Informe de ventas — ${monthLabel} según <span style="color:#c62828;font-weight:bold;">FIREBASE</span>
    </h2>
    <p style="font-size:18px; font-weight:bold;">Total ingresos ${monthLabel}: ${fmtEUR(totalMesFB)}</p>
    <h3 style="margin:18px 0 8px;">Desglose por producto (ordenado por importe, desc.)</h3>
    ${htmlTablaDesglose(desgloseFB)}
    <h3 style="margin:22px 0 8px;">Gráfica de barras — últimos 12 meses</h3>
    ${htmlBarras12m(serie12MesesFB)}
  `;

    const htmlSH = `
    <h2 style="margin:28px 0 12px 0; font-size:20px;">
      Informe de ventas — ${monthLabel} según <span style="color:#188038;font-weight:bold;">GOOGLE SHEETS</span>
    </h2>
    <p style="font-size:18px; font-weight:bold;">Total ingresos ${monthLabel}: ${fmtEUR(totalMesSH)}</p>
    <h3 style="margin:18px 0 8px;">Desglose por producto (ordenado por importe, desc.)</h3>
    ${htmlTablaDesglose(desgloseSH)}
    <h3 style="margin:22px 0 8px;">Gráfica de barras — últimos 12 meses</h3>
    ${htmlBarras12m(serie12MesesSH)}
  `;

  const html = `<div style="font-family:Arial, sans-serif; font-size:14px; color:#333;">${htmlFB}<hr style="margin:24px 0;border:none;border-top:1px solid #eee;">${htmlSH}</div>`;
  const subject = `📈 Ventas ${monthLabel} — FB ${fmtEUR(totalMesFB)} | Sheets ${fmtEUR(totalMesSH)}`;

  // Envío a ambos destinatarios (dos llamadas para máxima compatibilidad)
  await enviarEmailPersonalizado({ to: EMAIL_DEST, subject, html, text: `Ventas ${monthLabel}` });
  await enviarEmailPersonalizado({ to: EMAIL_CC,   subject, html, text: `Ventas ${monthLabel}` });
}

// ───────── Runner ─────────
(async () => {
  try {
    console.log('🚀 Informe mensual de ventas (FIREBASE + Sheets) — inicio');

    // 1) Leer datos
    const [rowsSH, rowsFB] = await Promise.all([
      leerComprasDeSheets(),
      leerComprasDeFirebase(),
    ]);

    // 2) Mes objetivo = mes anterior (Europe/Madrid)
    const { year: targetYear, month1: targetMonth1 } = previousYearMonth();
    const targetYYYYMM = yyyymmFrom(targetYear, targetMonth1);
    const monthLabel = monthLabelESFrom(targetYear, targetMonth1);

    const targetRowsSH = rowsSH.filter(r => r.fecha.yyyymm === targetYYYYMM);
    const targetRowsFB = rowsFB.filter(r => r.fecha.yyyymm === targetYYYYMM);

    // 3) Desglose + totales
    const desgloseSH = agruparPorDescripcion(targetRowsSH);
    const totalMesSH = targetRowsSH.reduce((s, r) => s + Number(r.importe || 0), 0);

    const desgloseFB = agruparPorDescripcion(targetRowsFB);
    const totalMesFB = targetRowsFB.reduce((s, r) => s + Number(r.importe || 0), 0);

    // 4) Series 12 meses
    const totalsMapSH = totalesPorMesTodos(rowsSH);
    const totalsMapFB = totalesPorMesTodos(rowsFB);
    const meses = lastNMonthsYYYYMM(12, targetYear, targetMonth1);

    const serie12MesesSH = meses.map(({year, month1, yyyymm}) => ({
      label: monthLabelESFrom(year, month1),
      short: new Date(Date.UTC(year, month1 - 1, 1)).toLocaleDateString('es-ES', { month:'short', timeZone:'Europe/Madrid' }),
      total: totalsMapSH.get(yyyymm) || 0
    }));

    const serie12MesesFB = meses.map(({year, month1, yyyymm}) => ({
      label: monthLabelESFrom(year, month1),
      short: new Date(Date.UTC(year, month1 - 1, 1)).toLocaleDateString('es-ES', { month:'short', timeZone:'Europe/Madrid' }),
      total: totalsMapFB.get(yyyymm) || 0
    }));

    // 5) Email doble (FIREBASE primero, luego Sheets)
    await enviarInformeEmailDoble({
      monthLabel,
      totalMesFB, desgloseFB, serie12MesesFB,
      totalMesSH, desgloseSH, serie12MesesSH,
    });

    // 6) Hoja ESTADÍSTICAS (SOLO Sheets, como hasta ahora)
    await appendStatsRows({ mesLabel: monthLabel, items: desgloseSH });

    console.log('✅ Informe mensual de ventas (FIREBASE + Sheets) — fin');
  } catch (e) {
    console.error('❌ Error informe mensual:', e.stack || e.message || e);
    process.exit(1);
  }
})();
