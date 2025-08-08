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
    const sheetId = SHEETS_EVENTOS[slugEvento];
    if (!sheetId) {
      throw new Error('Slug de evento no válido.');
    }

    const authClient = await auth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const getRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'A:D'
    });

    const filas = getRes.data.values || [];
    let filaEncontrada = -1;

    for (let i = 1; i < filas.length; i++) {
      const fila = filas[i];
      if (fila[2] && fila[2].trim() === codigoEntrada.trim()) {
        filaEncontrada = i + 1; // las filas en A1 notation son 1-based
        break;
      }
    }

    if (filaEncontrada === -1) {
      return { error: 'Código no encontrado en la hoja.' };
    }

    // Marcar como usada (columna D)
    const updateRes = await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `D${filaEncontrada}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [['SÍ']]
      }
    });

    const filaOriginal = filas[filaEncontrada - 1] || [];
    const emailComprador = filaOriginal[1] || '';
    const nombreAsistente = ''; // puedes añadirlo si lo incluyes en futuras columnas

    console.log(`🎟️ Entrada ${codigoEntrada} marcada como usada en fila ${filaEncontrada}`);
    return { emailComprador, nombreAsistente };
  } catch (err) {
    console.error('❌ Error al marcar entrada como usada:', err.message);
    return { error: 'Error al actualizar la hoja.' };
  }
}

module.exports = {
  guardarEntradaEnSheet,
  marcarEntradaComoUsada
};
