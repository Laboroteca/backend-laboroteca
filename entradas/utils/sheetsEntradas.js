// 📄 entradas/services/sheetsEntradas.js
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

// 🎨 Colores (RGB 0–1)
const COLOR_VERDE = { red: 0.20, green: 0.66, blue: 0.33 };
const COLOR_ROJO  = { red: 0.90, green: 0.13, blue: 0.13 };
const TEXTO_BLANCO_BOLD = { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true };

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

/** Aplica valor y formato a una celda (fila 1-based, col 0-based) */
async function setCellValueAndFormat({ sheets, spreadsheetId, sheetIdNum, row1, col0, value, bgColor }) {
  const colLetter = String.fromCharCode('A'.charCodeAt(0) + col0);

  // Valor
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${colLetter}${row1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] }
  });

  // Formato
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId: sheetIdNum,
            startRowIndex: row1 - 1,
            endRowIndex: row1,
            startColumnIndex: col0,
            endColumnIndex: col0 + 1
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: bgColor,
              textFormat: TEXTO_BLANCO_BOLD
            }
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)'
        }
      }]
    }
  });
}

/** Busca la fila (1-based) por código en la columna C */
async function findRowByCode({ sheets, spreadsheetId, codigo }) {
  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'A:E'
  });
  const filas = getRes.data.values || [];
  for (let i = 1; i < filas.length; i++) {
    const fila = filas[i];
    if (fila[2] && String(fila[2]).trim().toUpperCase() === String(codigo).trim().toUpperCase()) return i + 1;
  }
  return -1;
}

/**
 * Guarda una entrada en la hoja del evento correspondiente.
 * A = "14/08/2025 - 10:13h", B = comprador, C = código, D/E = "NO" (verde)
 */
async function guardarEntradaEnSheet({ sheetId, comprador, codigo, fecha = null }) {
  try {
    const fechaVenta = fecha ? fechaCompraES(new Date(fecha)) : fechaCompraES();
    const fila = [fechaVenta, comprador, codigo, 'NO', 'NO'];

    const { sheets, sheetIdNum } = await getSheetsAndSheetId(sheetId);

    const appendRes = await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'A:E',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [fila] }
    });

    // Intentar deducir la fila insertada
    let row1 = -1;
    const updatedRange = appendRes.data?.updates?.updatedRange || '';
    // Ejemplos posibles: 'Hoja 1'!A10:E10  |  Hoja1!A10:E10  |  A10:E10
    const m = updatedRange.match(/!?[A-Za-zÀ-ÿ0-9 '._-]*!?([A-Z]+)(\d+):[A-Z]+(\d+)/);
    if (m) row1 = parseInt(m[2], 10);
    if (row1 <= 0) row1 = await findRowByCode({ sheets, spreadsheetId: sheetId, codigo });

    if (row1 > 0) {
  // Reafirmamos el valor “NO” por si el append no lo dejó
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `D${row1}:E${row1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['NO', 'NO']] }
  });

  // Y aplicamos formato a D y E en una sola llamada
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId: sheetIdNum,
            startRowIndex: row1 - 1,
            endRowIndex: row1,
            startColumnIndex: 3, // D
            endColumnIndex: 5    // hasta E (exclusivo)
          },
          cell: {
            userEnteredFormat: {
              backgroundColor: COLOR_VERDE,
              textFormat: TEXTO_BLANCO_BOLD
            }
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)'
        }
      }]
    }
  });
}


    console.log(`✅ Entrada registrada en hoja (${sheetId}) → fila ${row1} código ${codigo}`);
  } catch (err) {
    console.error(`❌ Error al guardar entrada en hoja (${sheetId}):`, err.message);
    throw err;
  }
}

/**
 * VALIDAR ENTRADA (día del evento)
 * - Solo D = "SÍ" (rojo). ❌ NO tocar E.
 * - Devuelve email (B) y nombre (A) por si se quiere registrar en Firestore.
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
        console.log('🔍 Código extraído de URL:', codigo);
      } catch {
        console.warn('⚠️ No se pudo parsear la URL, se usa el valor original.');
      }
    }

    const { sheets, sheetIdNum } = await getSheetsAndSheetId(spreadsheetId);

    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'A:E'
    });
    const filas = getRes.data.values || [];

    let row1 = -1;
    let filaEncontrada = null;
    for (let i = 1; i < filas.length; i++) {
      if (filas[i][2] && String(filas[i][2]).trim() === codigo) {
        row1 = i + 1;
        filaEncontrada = filas[i];
        break;
      }
    }

    if (row1 === -1 || !filaEncontrada) {
      return { error: 'Código no encontrado en la hoja.' };
    }

    // D (index 3) → "SÍ" rojo (NO tocar E)
    await setCellValueAndFormat({
      sheets,
      spreadsheetId,
      sheetIdNum,
      row1,
      col0: 3,
      value: 'SÍ',
      bgColor: COLOR_ROJO
    });

    console.log(`🎟️ Entrada ${codigo} VALIDADA en fila ${row1}`);

    // A = fecha (no es el nombre), B = comprador (email), C = código
    const emailComprador  = filaEncontrada[1] || ''; // Columna B → email
    const nombreAsistente = ''; // No está en la hoja con el esquema actual

    return { ok: true, emailComprador, nombreAsistente };
  } catch (err) {
    console.error('❌ Error al marcar entrada como usada:', err);
    return { error: `Error al actualizar la hoja: ${err.message}` };
  }
}

/**
 * CANJEAR POR LIBRO (cuando entregas el libro):
 * - E = "SÍ" (rojo). D no se toca aquí.
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

    const { sheets, sheetIdNum } = await getSheetsAndSheetId(spreadsheetId);

    const row1 = await findRowByCode({ sheets, spreadsheetId, codigo });
    if (row1 === -1) {
      return { error: 'Código no encontrado en la hoja.' };
    }

    // E (index 4) → "SÍ" rojo
    await setCellValueAndFormat({
      sheets,
      spreadsheetId,
      sheetIdNum,
      row1,
      col0: 4,
      value: 'SÍ',
      bgColor: COLOR_ROJO
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
  marcarEntradaComoUsada,            // D = SÍ (rojo)
  marcarEntradaComoCanjeadaPorLibro, // E = SÍ (rojo)
  SHEETS_EVENTOS
};
