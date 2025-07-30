const { google } = require('googleapis');
const { auth } = require('../../google/sheetsAuth'); // Asegúrate de que este archivo contiene tus credenciales

/**
 * Guarda una entrada en la hoja del evento correspondiente.
 * @param {Object} datos
 * @param {string} datos.sheetId - ID de la hoja del evento
 * @param {string} datos.comprador - Email del comprador
 * @param {string} datos.codigo - Código único de la entrada
 * @param {string} [datos.usado] - "NO" por defecto
 * @param {string} [datos.fecha] - ISO string (opcional, por defecto new Date())
 */
async function guardarEntradaEnSheet({ sheetId, comprador, codigo, usado = 'NO', fecha = null }) {
  try {
    const authClient = await auth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const fila = [
      fecha || new Date().toISOString().split('T')[0],
      comprador,
      codigo,
      usado
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'A:D',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [fila]
      }
    });

    console.log(`✅ Entrada registrada en hoja del evento (${sheetId}): ${codigo}`);
  } catch (err) {
    console.error(`❌ Error al guardar entrada en hoja (${sheetId}):`, err.message);
    throw err;
  }
}

module.exports = { guardarEntradaEnSheet };
