const { google } = require('googleapis');

// Lee el contenido de las credenciales desde la variable de entorno
const credentialsJSON = process.env.GOOGLE_CREDENTIALS_JSON;

if (!credentialsJSON) {
  throw new Error('❌ Falta la variable de entorno GOOGLE_CREDENTIALS_JSON con las credenciales de Google');
}

// Crea el auth usando el contenido del JSON
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(credentialsJSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ID de la hoja (de la URL)
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
