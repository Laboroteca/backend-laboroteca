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
const HOJA = 'Hoja 1';

async function guardarEnGoogleSheets(datos) {
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const now = new Date();
    const nowString = now.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
    const email = (datos.email || '').trim().toLowerCase();
    const descripcionFija = 'Suscripción mensual al Club Laboroteca';
    const importe = typeof datos.importe === 'number'
      ? `${datos.importe.toFixed(2)} €`
      : (datos.importe || '');

    // Leer filas existentes
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${HOJA}!A2:K`,
    });

    const filas = res.data.values || [];

    const yaExiste = filas.some(fila => {
      const [,, , descripcion, imp, fecha, em] = fila;
      return (
        (em || '').toLowerCase() === email &&
        (descripcion || '').toLowerCase().includes('club laboroteca') &&
        (imp || '').includes('4.99') &&
        (fecha || '').slice(0, 16) === nowString.slice(0, 16) // HH:MM
      );
    });

    if (yaExiste) {
      console.log(`🔁 Registro duplicado evitado en Sheets para ${email}`);
      return;
    }

    // Preparar fila
    const fila = [
      datos.nombre || '',
      datos.apellidos || '',
      datos.dni || '',
      descripcionFija,
      importe,
      nowString,
      email,
      datos.direccion || '',
      datos.ciudad || '',
      datos.cp || '',
      datos.provincia || ''
    ];

    // Insertar fila
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${HOJA}!A2`,
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
