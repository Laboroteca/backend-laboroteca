// /services/googleSheets.js

const { google } = require('googleapis');

const credentialsBase64 = process.env.GCP_CREDENTIALS_BASE64;
if (!credentialsBase64) {
  throw new Error('❌ Falta la variable de entorno GCP_CREDENTIALS_BASE64 con las credenciales de Google');
}

const credentials = JSON.parse(Buffer.from(credentialsBase64, 'base64').toString('utf8'));

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const spreadsheetId = '1ShSiaz_TtODbVkczI1mfqTBj5nHb3xSEywyB0E6BL9I';

async function guardarEnGoogleSheets(datos) {
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });

    const email = (datos.email || '').trim().toLowerCase();

    const fila = [
      datos.nombre || '',
      datos.apellidos || '',
      datos.dni || '',
      datos.descripcionProducto || datos.nombreProducto || '',
      typeof datos.importe === 'number' ? datos.importe.toFixed(2) : '',
      now,
      email,
      datos.direccion || '',
      datos.ciudad || '',
      datos.cp || '',
      datos.provincia || ''
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'Hoja 1!A2',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [fila],
      },
    });

    console.log(`✅ Compra registrada en Sheets para ${email}`);
  } catch (error) {
    console.error('❌ Error al guardar en Google Sheets:', error);
    throw error;
  }
}

module.exports = { guardarEnGoogleSheets };
