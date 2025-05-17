const { google } = require('googleapis');
const path = require('path');

// Autenticación con Google
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, '../google/credenciales-sheets.json'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ID de tu hoja de cálculo (lo sacas de la URL)
const spreadsheetId = '1ShSiaz_TtODbVkczI1mfqTBj5nHb3xSEywyB0E6BL9I';

async function guardarEnGoogleSheets(datos) {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const now = new Date().toLocaleString('es-ES');

  const fila = [
    datos.nombre || '',
    datos.apellidos || '',
    datos.dni || '',
    datos.importe || '',
    now,
    datos.email || '',
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

  console.log('📊 Datos guardados en Google Sheets');
}

module.exports = { guardarEnGoogleSheets };
