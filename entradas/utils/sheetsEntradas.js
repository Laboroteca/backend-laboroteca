const { google } = require('googleapis');
const { auth } = require('../google/sheetsAuth');

// MAPEO entre slugEvento y el ID real del Google Sheet
const SHEETS_EVENTOS = {
  'evento-1': '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
  'evento-2': '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
  'evento-3': '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
  'evento-4': '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
  'evento-5': '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc'
};

/** Fecha y hora actual en Madrid como: 14/08/2025 - 10:13h */
function fechaCompraES(d = new Date()) {
  const fecha = new Intl.DateTimeFormat('es-ES', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Madrid'
  }).format(d);
  const hora = new Intl.DateTimeFormat('es-ES', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Madrid'
  }).format(d);
  return `${fecha} - ${hora}h`;
}

/** Devuelve sheets client y sheetIdNum de la primera pestaña */
async function getSheetsAndSheetId(spreadsheetId) {
  const authClient = await auth();
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const spreadsheetData = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetIdNum = spreadsheetData.data.sheets?.[0]?.properties?.sheetId || 0;
  return { sheets, sheetIdNum };
}

/** Busca la fila (1-based) por código en la columna D (índice 3) */
async function findRowByCode({ sheets, spreadsheetId, codigo }) {
  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'A:F'
  });
  const filas = getRes.data.values || [];
  for (let i = 1; i < filas.length; i++) {
    const fila = filas[i];
    if (fila[3] && String(fila[3]).trim().toUpperCase() === String(codigo).trim().toUpperCase()) {
      return i + 1;
    }
  }
  return -1;
}

/**
 * Guarda una entrada en la hoja del evento correspondiente.
 * A = fecha, B = descripcionProducto, C = comprador, D = código, E/F = "NO"
 */
async function guardarEntradaEnSheet({ sheetId, comprador, descripcionProducto = '', codigo, fecha = null }) {
  try {
    const fechaVenta = fecha ? fechaCompraES(new Date(fecha)) : fechaCompraES();
    const fila = [fechaVenta, descripcionProducto, comprador, codigo, 'NO', 'NO'];

    const { sheets } = await getSheetsAndSheetId(sheetId);

    const appendRes = await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'A:F',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [fila] }
    });

    console.log(`✅ Entrada registrada en hoja (${sheetId}) código ${codigo}`);
  } catch (err) {
    console.error(`❌ Error al guardar entrada en hoja (${sheetId}):`, err.message);
    throw err;
  }
}

/**
 * VALIDAR ENTRADA (día del evento)
 * - Solo E = "SÍ". ❌ NO se toca F.
 * - Devuelve email (C) y descripcionProducto (B).
 */
async function marcarEntradaComoUsada(codigoEntrada, slugEvento) {
  try {
    const spreadsheetId = SHEETS_EVENTOS[slugEvento];
    if (!spreadsheetId) throw new Error('Slug de evento no válido.');

    let codigo = String(codigoEntrada || '').trim();
    if (codigo.startsWith('http')) {
      try {
        const url = new URL(codigoEntrada);
        codigo = url.searchParams.get('codigo') || codigoEntrada;
      } catch {}
    }

    const { sheets } = await getSheetsAndSheetId(spreadsheetId);

    const row1 = await findRowByCode({ sheets, spreadsheetId, codigo });
    if (row1 === -1) return { error: 'Código no encontrado en la hoja.' };

    // E (index 4) → "SÍ" (sin formato especial)
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `E${row1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['SÍ']] }
    });

    console.log(`🎟️ Entrada ${codigo} VALIDADA en fila ${row1}`);

    // obtener datos de la fila
    const getRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `A${row1}:F${row1}` });
    const fila = getRes.data.values?.[0] || [];
    const emailComprador  = fila[2] || '';
    const descripcionProd = fila[1] || '';

    return { ok: true, emailComprador, descripcionProd };
  } catch (err) {
    console.error('❌ Error al marcar entrada como usada:', err);
    return { error: `Error al actualizar la hoja: ${err.message}` };
  }
}

/**
 * CANJEAR POR LIBRO (cuando entregas el libro):
 * - F = "SÍ". E no se toca aquí.
 */
async function marcarEntradaComoCanjeadaPorLibro(codigoEntrada, slugEvento) {
  try {
    const spreadsheetId = SHEETS_EVENTOS[slugEvento];
    if (!spreadsheetId) throw new Error('Slug de evento no válido.');

    let codigo = String(codigoEntrada || '').trim();
    if (codigo.startsWith('http')) {
      try {
        const url = new URL(codigoEntrada);
        codigo = url.searchParams.get('codigo') || codigoEntrada;
      } catch {}
    }

    const { sheets } = await getSheetsAndSheetId(spreadsheetId);

    const row1 = await findRowByCode({ sheets, spreadsheetId, codigo });
    if (row1 === -1) return { error: 'Código no encontrado en la hoja.' };

    // F (index 5) → "SÍ" (sin formato especial)
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `F${row1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [['SÍ']] }
    });

    console.log(`📕 Entrada ${codigo} CANJEADA POR LIBRO en fila ${row1}`);
    return { ok: true };
  } catch (err) {
    console.error('❌ Error al marcar canje por libro:', err);
    return { error: `Error al actualizar la hoja: ${err.message}` };
  }
}

module.exports = {
  guardarEntradaEnSheet,
  marcarEntradaComoUsada,            // E = SÍ
  marcarEntradaComoCanjeadaPorLibro, // F = SÍ
  SHEETS_EVENTOS
};
