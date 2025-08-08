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

/**
 * Guarda una entrada en la hoja del evento correspondiente.
 */
async function guardarEntradaEnSheet({ sheetId, comprador, codigo, usado = 'NO', fecha = null }) {
  try {
    const fechaVenta = fecha || new Date().toISOString();
    const fila = [fechaVenta, comprador, codigo, usado];

    console.log('📤 Datos que se van a guardar en el sheet:', fila);

    const authClient = await auth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const result = await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'A:D',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [fila]
      }
    });

    console.log('✅ Resultado append:', result.statusText || result.status);
    console.log(`✅ Entrada registrada correctamente en la hoja (${sheetId}):`, codigo);
  } catch (err) {
    console.error(`❌ Error al guardar entrada en hoja (${sheetId}):`, err.message);
    throw err;
  }
}

/**
 * Marca una entrada como USADA en la hoja de Google Sheets y devuelve datos útiles.
 */
async function marcarEntradaComoUsada(codigoEntrada, slugEvento) {
  try {
    const spreadsheetId = SHEETS_EVENTOS[slugEvento];
    if (!spreadsheetId) throw new Error('Slug de evento no válido.');

    // Limpieza por si llega URL en vez de solo el código
    let codigo = codigoEntrada.trim();
    if (codigo.startsWith('http')) {
      try {
        const url = new URL(codigoEntrada);
        codigo = url.searchParams.get('codigo') || codigoEntrada;
        console.log('🔍 Código extraído de URL:', codigo);
      } catch (err) {
        console.warn('⚠️ Error al parsear código como URL. Se usará valor original.');
      }
    }

    const authClient = await auth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    // Obtener sheetIdNum real
    const spreadsheetData = await sheets.spreadsheets.get({ spreadsheetId });
    const sheetIdNum = spreadsheetData.data.sheets?.[0]?.properties?.sheetId || 0;

    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'A:D'
    });

    const filas = getRes.data.values || [];
    let filaEncontrada = -1;

    for (let i = 1; i < filas.length; i++) {
      const fila = filas[i];
      if (fila[2] && fila[2].trim() === codigo.trim()) {
        filaEncontrada = i + 1; // para A1 notation
        break;
      }
    }

    if (filaEncontrada === -1) {
      return { error: 'Código no encontrado en la hoja.' };
    }

    // 1. Marcar "SÍ" en columna D
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `D${filaEncontrada}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [['SÍ']]
      }
    });

    // 2. Aplicar estilo visual a celda D
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId: sheetIdNum,
                startRowIndex: filaEncontrada - 1,
                endRowIndex: filaEncontrada,
                startColumnIndex: 3,
                endColumnIndex: 4
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.2, green: 0.66, blue: 0.325 },
                  textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true }
                }
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)'
            }
          }
        ]
      }
    });

    const filaOriginal = filas[filaEncontrada - 1] || [];
    const emailComprador = filaOriginal[1] || '';
    const nombreAsistente = ''; // puedes completarlo si decides añadir la columna

    console.log(`🎟️ Entrada ${codigo} marcada como usada en fila ${filaEncontrada}`);
    return { emailComprador, nombreAsistente };
  } catch (err) {
    console.error('❌ Error al marcar entrada como usada:', err);
    return { error: `Error al actualizar la hoja: ${err.message}` };
  }
}

module.exports = {
  guardarEntradaEnSheet,
  marcarEntradaComoUsada
};
