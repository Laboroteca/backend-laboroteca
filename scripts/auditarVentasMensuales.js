// scripts/auditarVentasMensuales.js
// Ejecuta: node scripts/auditarVentasMensuales.js  (o npm run audit:ventas)

const { google } = require('googleapis');
const { enviarEmailPersonalizado } = require('../services/email');

// ───────── CONFIG ─────────
const COMPRAS_SHEET_ID = '1ShSiaz_TtODbVkczI1mfqTBj5nHb3xSEywyB0E6BL9I';
const COMPRAS_SHEET_TAB = 'Hoja 1'; // A: Nombre, B: Apellidos, C: DNI, D: Descripción, E: Importe, F: Fecha, G: Email

const STATS_SHEET_ID = '1NH7IW-I0XuDKoC5Kwwh2kpDCss-41YKLvntQeuybbgA';
const STATS_SHEET_TAB_DEFAULT = 'Hoja 1';

const EMAIL_DEST = 'laboroteca@gmail.com';

// Auth
if (!process.env.GCP_CREDENTIALS_BASE64) throw new Error('❌ Falta GCP_CREDENTIALS_BASE64');
const credentials = JSON.parse(Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8'));
const sheetsAuth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ───────── Utils ─────────
const fmtEUR = (n) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(Number(n || 0));

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

function parseFechaCell(fechaCell) {
  if (!fechaCell) return null;
  if (typeof fechaCell === 'number') {
    const ms = Math.round(fechaCell * 86400000);
    const date = new Date(Date.UTC(1899, 11, 30) + ms);
    const parts = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit' }).formatToParts(date);
    const year = Number(parts.find(p => p.type === 'year').value);
    const month1 = Number(parts.find(p => p.type === 'month').value);
    return { date, year, month1, yyyymm: yyyymmFrom(year, month1) };
  }
  if (typeof fechaCell === 'string') {
    const m = fechaCell.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return null;
    const day = +m[1], month1 = +m[2], year = +m[3];
    const date = new Date(Date.UTC(year, month1 - 1, day));
    return { date, year, month1, yyyymm: yyyymmFrom(year, month1) };
  }
  return null;
}

function parseImporteCell(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const n = Number(String(v).trim().replace(/[€\s]/g,'').replace(/\.(?=\d{3}(\D|$))/g,'').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function lastNMonthsYYYYMM(n, y, m1) {
  const out = []; let Y=y, M=m1;
  for(let i=0;i<n;i++){ out.push({year:Y, month1:M, yyyymm: yyyymmFrom(Y,M)}); M--; if(M===0){M=12; Y--;}}
  return out;
}

// ───────── Lectura compras ─────────
async function leerComprasDeSheets() {
  const client = await sheetsAuth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  // Leemos todo A2:K (simple, sin “limpiezas”)
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

// ───────── Estadísticas ─────────
function agruparPorDescripcion(rowsDelMes) {
  const map = new Map();
  for (const r of rowsDelMes) {
    const key = r.descripcion.trim();
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
    const k = r.fecha.yyyymm;
    mp.set(k, (mp.get(k)||0) + Number(r.importe||0));
  }
  return mp;
}

// ───────── Escritura hoja “ESTADÍSTICAS” ─────────
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

  // 1) Append
  await sheets.spreadsheets.values.append({
    spreadsheetId: STATS_SHEET_ID,
    range: `${tabName}!A2`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  if (sheetId == null) return;

  // Índices 0-based de las filas recién añadidas
  const startRow = 1 + existingCount;               // A2 => index 1
  const endRow   = startRow + values.length;        // no inclusivo
  const totalRow = endRow - 1;                      // última (TOTAL)

  // 2) Asegurar primero que TODO el bloque (desglose + total) queda blanco y sin negrita
  //    (esto “resetea” cualquier formato previo del sheet).
  const requests = [
    {
      repeatCell: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: 0, endColumnIndex: 4 },
        cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 }, textFormat: { bold: false } } },
        fields: 'userEnteredFormat(backgroundColor,textFormat.bold)',
      }
    },
    // 3) Formato moneda en D para todo el bloque
    {
      repeatCell: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: 3, endColumnIndex: 4 },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00 €' }, horizontalAlignment: 'RIGHT' } },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      }
    },
    // 4) SOLO la FILA TOTAL: fondo gris + negrita
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
async function enviarInformeEmail({ monthLabel, totalMes, desglose, tablaComparativa, serie12Meses }) {
  if (!process.env.SMTP2GO_API_KEY || !process.env.SMTP2GO_FROM_EMAIL) return;

  const filasDesglose = desglose.map(it => `
    <tr>
      <td style="padding:6px 8px;border:1px solid #ddd;">${it.descripcion}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:center;">${it.count}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${fmtEUR(it.total)}</td>
    </tr>`).join('');

  const maxVal = Math.max(...serie12Meses.map(x => x.total || 0), 1);
  const barras = serie12Meses.map(x => {
    const h = Math.round(((x.total || 0) / maxVal) * 140);
    return `<div style="display:inline-block;width:28px;margin:0 6px;vertical-align:bottom;text-align:center;">
      <div title="${x.label}: ${fmtEUR(x.total || 0)}" style="height:${h}px;background:#4F46E5;"></div>
      <div style="font-size:10px;margin-top:4px;white-space:nowrap;">${x.short}</div>
    </div>`;
  }).join('');

  const html = `
    <div style="font-family:Arial, sans-serif; font-size:14px; color:#333;">
      <h2 style="margin:0 0 12px 0; font-size:20px;">Informe de ventas — ${monthLabel}</h2>
      <p style="font-size:18px; font-weight:bold;">Total ingresos ${monthLabel}: ${fmtEUR(totalMes)}</p>
      <h3 style="margin:18px 0 8px;">Desglose por producto (ordenado por importe, desc.)</h3>
      <table role="table" cellpadding="0" cellspacing="0" style="border-collapse:collapse;min-width:420px;">
        <thead><tr>
          <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Descripción</th>
          <th style="text-align:center;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Cantidad</th>
          <th style="text-align:right;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Total (€)</th>
        </tr></thead>
        <tbody>${filasDesglose || `<tr><td colspan="3" style="padding:8px;border:1px solid #ddd;">Sin ventas registradas.</td></tr>`}</tbody>
      </table>
      <h3 style="margin:22px 0 8px;">Gráfica de barras — últimos 12 meses</h3>
      <div style="border:1px solid #eee;padding:12px 8px 4px;height:180px;">
        <div style="display:flex;align-items:flex-end;height:160px;">${barras}</div>
      </div>
    </div>
  `;

  await enviarEmailPersonalizado({
    to: EMAIL_DEST,
    subject: `📈 Ventas ${monthLabel} — Total ${fmtEUR(totalMes)}`,
    html,
    text: `Ventas ${monthLabel}: ${fmtEUR(totalMes)}`
  });
}

// ───────── Runner ─────────
(async () => {
  try {
    console.log('🚀 Informe mensual de ventas — inicio');

    // 1) Leer compras
    const rows = await leerComprasDeSheets();

    // 2) Mes objetivo = mes anterior (Europe/Madrid)
    const { year: targetYear, month1: targetMonth1 } = previousYearMonth();
    const targetYYYYMM = yyyymmFrom(targetYear, targetMonth1);
    const monthLabel = monthLabelESFrom(targetYear, targetMonth1);

    const targetRows = rows.filter(r => r.fecha.yyyymm === targetYYYYMM);

    // 3) Desglose + totales
    const desglose = agruparPorDescripcion(targetRows);
    const totalMes = targetRows.reduce((s, r) => s + Number(r.importe || 0), 0);

    // 4) Serie 12 meses (para gráfico y por si quieres comparar)
    const totalsMap = totalesPorMesTodos(rows);
    const meses = lastNMonthsYYYYMM(12, targetYear, targetMonth1);
    const serie12Meses = meses.map(({year, month1, yyyymm}) => ({
      label: monthLabelESFrom(year, month1),
      short: new Date(Date.UTC(year, month1 - 1, 1)).toLocaleDateString('es-ES', { month:'short', timeZone:'Europe/Madrid' }),
      total: totalsMap.get(yyyymm) || 0
    }));

    // 5) Email
    await enviarInformeEmail({ monthLabel, totalMes, desglose, serie12Meses });

    // 6) Hoja ESTADÍSTICAS (desgloses blancos, TOTAL gris y en negrita, col A del total vacía)
    await appendStatsRows({ mesLabel: monthLabel, items: desglose });

    console.log('✅ Informe mensual de ventas — fin');
  } catch (e) {
    console.error('❌ Error informe mensual:', e.stack || e.message || e);
    process.exit(1);
  }
})();
