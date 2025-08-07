const { google } = require('googleapis');
const { auth } = require('../../google/sheetsAuth');

/**
 * Guarda una entrada en la hoja del evento correspondiente.
 */
async function guardarEntradaEnSheet({ sheetId, comprador, codigo, usado = 'NO', fecha = null }) {
  try {
    const fechaVenta = fecha || new Date().toISOString().split('T')[0];
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

module.exports = { guardarEntradaEnSheet };
