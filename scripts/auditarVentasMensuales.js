// scripts/auditarVentasMensuales.js
// Ejecuta: CLEAN_SHEET=1 node scripts/auditarVentasMensuales.js  (opcional CLEAN_SHEET)
//          npm run audit:ventas

const { google } = require('googleapis');
const { enviarEmailPersonalizado } = require('../services/email');

// ───────────────────────── CONFIG ─────────────────────────
const COMPRAS_SHEET_ID = '1ShSiaz_TtODbVkczI1mfqTBj5nHb3xSEywyB0E6BL9I';
const COMPRAS_SHEET_TAB = 'Hoja 1'; // A: Nombre, B: Apellidos, C: DNI, D: Descripción, E: Importe, F: Fecha, G: Email

const STATS_SHEET_ID = '1NH7IW-I0XuDKoC5Kwwh2kpDCss-41YKLvntQeuybbgA';
const STATS_SHEET_TAB_DEFAULT = 'Hoja 1';

const EMAIL_DEST = 'laboroteca@gmail.com';

// Auth
if (!process.env.GCP_CREDENTIALS_BASE64) {
  throw new Error('❌ Falta GCP_CREDENTIALS_BASE64');
}
const credentials = JSON.parse(Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8'));
const sheetsAuth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ───────────────────────── UTILIDADES ─────────────────────────
const fmtEUR = (n) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(Number(n || 0));

const log  = (m) => console.log(m);
const warn = (m) => console.warn(m);

// Limpia espacios e invisibles (incluye NBSP)
function cleanText(s = '') {
  return String(s).replace(/\u00A0/g, ' ').trim();
}

function monthLabelESFrom(year, month1) {
  const d = new Date(Date.UTC(year, month1 - 1, 1));
  return d.toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' });
}

function madridNowYearMonth() {
  const parts = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = Number(parts.find((p) => p.type === 'year').value);
  const m = Number(parts.find((p) => p.type === 'month').value);
  return { year: y, month1: m };
}

function previousYearMonth() {
  const { year, month1 } = madridNowYearMonth();
  if (month1 === 1) return { year: year - 1, month1: 12 };
  return { year, month1: month1 - 1 };
}

function yyyymmFrom(year, month1) {
  return `${year}-${String(month1).padStart(2, '0')}`;
}

// dd/mm/yyyy (opcional hh:mm) → {date, year, month1, yyyymm}
function parseFechaCell(fechaCell) {
  if (!fechaCell) return null;

  // 1) Número serial de Sheets
  if (typeof fechaCell === 'number') {
    const ms = Math.round(fechaCell * 24 * 60 * 60 * 1000);
    const date = new Date(Date.UTC(1899, 11, 30) + ms);
    const parts = new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(date);
    const year = Number(parts.find((p) => p.type === 'year').value);
    const month1 = Number(parts.find((p) => p.type === 'month').value);
    return { date, year, month1, yyyymm: yyyymmFrom(year, month1) };
  }

  // 2) Cadena "dd/mm/yyyy" (con o sin hora)
  if (typeof fechaCell === 'string') {
    const t = fechaCell.trim();
    const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return null;
    const day = Number(m[1]);
    const month1 = Number(m[2]);
    const year = Number(m[3]);
    const date = new Date(Date.UTC(year, month1 - 1, day));
    return { date, year, month1, yyyymm: yyyymmFrom(year, month1) };
  }

  return null;
}

function lastNMonthsYYYYMM(n, refYear, refMonth1) {
  const arr = [];
  let y = refYear;
  let m = refMonth1;
  for (let i = 0; i < n; i++) {
    arr.push({ year: y, month1: m, yyyymm: yyyymmFrom(y, m) });
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return arr; // reciente → antiguo
}

function parseImporteCell(importeCell) {
  if (typeof importeCell === 'number') return Number(importeCell);
  if (!importeCell) return 0;

  const s = String(importeCell).trim();

  // Quita símbolo €, espacios y separadores de miles (puntos solo si van antes de 3 dígitos), y usa punto como decimal
  const clean = s
    .replace(/[€]/g, '')
    .replace(/\s/g, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '') // elimina . si es miles
    .replace(',', '.');

  const n = Number(clean);
  return isNaN(n) ? 0 : n;
}

// ───────────────────────── LIMPIEZA HOJA COMPRAS ─────────────────────────
async function getSheetMeta(spreadsheetId) {
  const client = await sheetsAuth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  return { sheets, meta: meta.data };
}

async function detectarUltimaFilaReal({ sheets, meta, tabName }) {
  const sheet = meta.sheets.find((s) => s.properties.title === tabName);
  if (!sheet) throw new Error(`No existe la pestaña "${tabName}"`);
  const spreadsheetId = meta.spreadsheetId;

  // Conservador: miramos D (Descripción), F (Fecha) y G (Email)
  const rangos = ['D:D', 'F:F', 'G:G'];
  let last = 1; // header en fila 1
  for (const r of rangos) {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tabName}!${r}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    last = Math.max(last, (data.values || []).length);
  }
  return {
    sheetId: sheet.properties.sheetId,
    rowCount: sheet.properties.gridProperties.rowCount,
    lastDataRow: last,
  };
}

/** Elimina físicamente las filas por debajo de la última fila con datos reales */
async function compactarHojaCompras() {
  const { sheets, meta } = await getSheetMeta(COMPRAS_SHEET_ID);
  const { sheetId, rowCount, lastDataRow } = await detectarUltimaFilaReal({
    sheets,
    meta,
    tabName: COMPRAS_SHEET_TAB,
  });

  const firstRowToDelete0 = lastDataRow; // 0-based: borrar desde la (lastDataRow+1)
  if (firstRowToDelete0 >= rowCount) {
    log(`🧹 No hay filas extra para borrar. rowCount=${rowCount}, lastDataRow=${lastDataRow}`);
    return;
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: COMPRAS_SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: firstRowToDelete0, // inclusivo
              endIndex: rowCount,            // exclusivo
            },
          },
        },
      ],
    },
  });

  log(`🧹 Compactada la hoja de compras: eliminadas filas ${firstRowToDelete0 + 1}..${rowCount}`);
}

// ───────────────────────── LECTURA COMPRAS ─────────────────────────
async function leerComprasDeSheets() {
  const client = await sheetsAuth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  // Detectar última fila real mirando columna D
  const probe = await sheets.spreadsheets.values.get({
    spreadsheetId: COMPRAS_SHEET_ID,
    range: `${COMPRAS_SHEET_TAB}!D:D`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const lastRow = (probe.data.values || []).length;

  if (lastRow < 2) {
    log('📥 Compras: 0 filas con datos.');
    return [];
  }

  // Leer solo hasta la última fila real
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: COMPRAS_SHEET_ID,
    range: `${COMPRAS_SHEET_TAB}!A2:K${lastRow}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  // Mapear y filtrar filas válidas (evita filas fantasma)
  const rows = (data.values || [])
    .map((r) => {
      const [nombre, apellidos, dni, descripcion, importeRaw, fechaRaw, email] = r;
      const fecha = parseFechaCell(fechaRaw);
      const importe = parseImporteCell(importeRaw);
      const descOriginal = cleanText(descripcion || '');
      return {
        nombre: cleanText(nombre || ''),
        apellidos: cleanText(apellidos || ''),
        dni: cleanText(dni || ''),
        descripcion: descOriginal,
        importe,
        fecha, // {date, year, month1, yyyymm}
        email: (email || '').toLowerCase().trim(),
      };
    })
    .filter(
      (r) =>
        r.fecha &&
        r.fecha.yyyymm &&
        r.importe > 0 &&
        r.descripcion &&
        r.descripcion.trim() !== ''
    );

  log(`📥 Compras: ${rows.length} filas válidas leídas de Sheets (hasta fila ${lastRow}).`);
  return rows;
}

// ───────────────────────── ESTADÍSTICAS ─────────────────────────
function agruparPorDescripcion(rowsDelMes) {
  const map = new Map();
  for (const r of rowsDelMes) {
    const desc = (r.descripcion || '(sin descripción)').trim();
    if (!map.has(desc)) map.set(desc, { descripcion: desc, count: 0, total: 0 });
    const it = map.get(desc);
    it.count += 1; // 1 fila = 1 venta
    it.total += Number(r.importe || 0);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total); // importe DESC
}

function totalesPorMesTodos(rows) {
  const mp = new Map(); // 'YYYY-MM' -> total €
  for (const r of rows) {
    const k = r.fecha.yyyymm;
    mp.set(k, (mp.get(k) || 0) + Number(r.importe || 0));
  }
  return mp;
}

// ───────────────────────── ESCRITURA EN “ESTADÍSTICAS” ─────────────────────────
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
    range: `${tabName}!A2:A`,
  });
  const existingCount = (existing.data.values || []).length;

  // Filas a insertar (detalles + TOTAL)
  const values = [
    ...items.map((it) => [
      mesLabel,       // A
      it.descripcion, // B
      String(it.count), // C
      Number(it.total), // D (numérico)
    ]),
    [
      '',                                          // A (vacía, pedido explícito)
      `TOTAL VENTAS ${mesLabel.toUpperCase()}`,    // B
      String(totalCount),                          // C
      Number(totalAmount),                         // D
    ],
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: STATS_SHEET_ID,
    range: `${tabName}!A2`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });

  if (sheetId != null) {
    const startRowIndex0 = 1 + existingCount;            // A2 = index 1
    const endRowIndex0   = startRowIndex0 + values.length;
    const resumenRowIndex0 = endRowIndex0 - 1;           // última fila insertada

    const requests = [
      // D: formato moneda
      {
        repeatCell: {
          range: { sheetId, startRowIndex: startRowIndex0, endRowIndex: endRowIndex0, startColumnIndex: 3, endColumnIndex: 4 },
          cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '#,##0.00 €' }, horizontalAlignment: 'RIGHT' } },
          fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
        },
      },
      // Detalles: fondo blanco y NO negrita
      {
        repeatCell: {
          range: { sheetId, startRowIndex: startRowIndex0, endRowIndex: resumenRowIndex0, startColumnIndex: 0, endColumnIndex: 4 },
          cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 }, textFormat: { bold: false } } },
          fields: 'userEnteredFormat(backgroundColor,textFormat.bold)',
        },
      },
      // TOTAL: fondo gris en A:D
      {
        repeatCell: {
          range: { sheetId, startRowIndex: resumenRowIndex0, endRowIndex: resumenRowIndex0 + 1, startColumnIndex: 0, endColumnIndex: 4 },
          cell: { userEnteredFormat: { backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 } } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      },
      // TOTAL: toda la fila en negrita
      {
        repeatCell: {
          range: { sheetId, startRowIndex: resumenRowIndex0, endRowIndex: resumenRowIndex0 + 1, startColumnIndex: 0, endColumnIndex: 4 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      },
    ];

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: STATS_SHEET_ID,
      requestBody: { requests },
    });
  }

  log(`📝 StatsSheet: añadidas ${items.length} filas + TOTAL para ${mesLabel}.`);
}

// ───────────────────────── EMAIL ─────────────────────────
async function enviarInformeEmail({ monthLabel, totalMes, desglose, tablaComparativa, serie12Meses }) {
  if (!process.env.SMTP2GO_API_KEY || !process.env.SMTP2GO_FROM_EMAIL) {
    warn('Email no enviado: faltan credenciales SMTP2GO');
    return;
  }

  const filasDesglose = desglose.map(
    (it) => `
      <tr>
        <td style="padding:6px 8px;border:1px solid #ddd;">${it.descripcion}</td>
        <td style="padding:6px 8px;border:1px solid #ddd;text-align:center;">${it.count}</td>
        <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${fmtEUR(it.total)}</td>
      </tr>`
  ).join('');

  const filasComparativa = tablaComparativa.map(
    (row) => `
      <tr>
        <td style="padding:6px 8px;border:1px solid #ddd;">${row.mesActual}</td>
        <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${row.totalActual === null ? '-' : fmtEUR(row.totalActual)}</td>
        <td style="padding:6px 8px;border:1px solid #ddd;">${row.mesPrevio}</td>
        <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${row.totalPrevio === null ? '-' : fmtEUR(row.totalPrevio)}</td>
      </tr>`
  ).join('');

  // Barras (12 meses)
  const maxVal = Math.max(...serie12Meses.map((x) => x.total || 0), 1);
  const barras = serie12Meses.map((x) => {
    const h = Math.round(((x.total || 0) / maxVal) * 140);
    return `
      <div style="display:inline-block;width:28px;margin:0 6px;vertical-align:bottom;text-align:center;">
        <div title="${x.label}: ${fmtEUR(x.total || 0)}" style="height:${h}px;background:#4F46E5;"></div>
        <div style="font-size:10px;margin-top:4px;white-space:nowrap;">${x.short}</div>
      </div>`;
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
    `Desglose por producto:`,
    ...desglose.map((it) => `- ${it.descripcion}: ${it.count} uds → ${fmtEUR(it.total)}`),
  ].join('\n');

  await enviarEmailPersonalizado({
    to: EMAIL_DEST,
    subject: `📈 Ventas ${monthLabel} — Total ${fmtEUR(totalMes)}`,
    html,
    text,
  });

  log(`📧 Informe mensual enviado a ${EMAIL_DEST}`);
}

// ───────────────────────── RUNNER ─────────────────────────
(async () => {
  try {
    log('🚀 Informe mensual de ventas — inicio');

    // 0) (opcional) Compactar la hoja de compras para eliminar filas fantasma
    if (process.env.CLEAN_SHEET === '1') {
      await compactarHojaCompras();
    }

    // 1) Leer todas las compras válidas
    const rows = await leerComprasDeSheets();

    // 2) Mes objetivo = mes anterior (Europe/Madrid)
    const { year: prevYear, month1: prevMonth1 } = previousYearMonth();
    const targetYYYYMM = yyyymmFrom(prevYear, prevMonth1);
    const monthLabel = monthLabelESFrom(prevYear, prevMonth1);

    const prevRows = rows.filter((r) => r.fecha.yyyymm === targetYYYYMM);

    // 3) Total del mes y desglose por descripción
    const totalMes = prevRows.reduce((acc, r) => acc + Number(r.importe || 0), 0);
    const desglose = agruparPorDescripcion(prevRows);

    // 4) Comparativa y serie 12 meses
    const totalsMap = totalesPorMesTodos(rows);
    const meses = lastNMonthsYYYYMM(12, prevYear, prevMonth1); // reciente → antiguo

    const tablaComparativa = meses.map(({ year, month1, yyyymm }) => {
      const actual = totalsMap.has(yyyymm) ? totalsMap.get(yyyymm) : 0;
      const prev = totalsMap.get(yyyymmFrom(year - 1, month1)) ?? null;
      return {
        mesActual: monthLabelESFrom(year, month1),
        totalActual: actual,
        mesPrevio: monthLabelESFrom(year - 1, month1),
        totalPrevio: prev,
      };
    });

    const serie12Meses = meses.map(({ year, month1, yyyymm }) => ({
      label: monthLabelESFrom(year, month1),
      short: new Date(Date.UTC(year, month1 - 1, 1)).toLocaleDateString('es-ES', {
        month: 'short',
        timeZone: 'Europe/Madrid',
      }),
      total: totalsMap.get(yyyymm) || 0,
    }));

    // 5) Enviar email
    await enviarInformeEmail({ monthLabel, totalMes, desglose, tablaComparativa, serie12Meses });

    // 6) Registrar en “ESTADÍSTICAS” con formato pedido
    await appendStatsRows({ mesLabel: monthLabel, items: desglose });

    log('✅ Informe mensual de ventas — fin');
  } catch (e) {
    console.error('❌ Error informe mensual:', e.stack || e.message || e);
    process.exit(1);
  }
})();
