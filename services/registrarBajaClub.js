const { google } = require('googleapis'); 

// Validar credenciales
const credentialsBase64 = process.env.GCP_CREDENTIALS_BASE64;
if (!credentialsBase64) {
  throw new Error('❌ Falta la variable GCP_CREDENTIALS_BASE64');
}

let auth;
try {
  const credentials = JSON.parse(Buffer.from(credentialsBase64, 'base64').toString('utf8'));
  auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
} catch (err) {
  throw new Error('❌ Error al parsear credenciales de Google Cloud: ' + err.message);
}

// ID de la hoja de bajas del Club Laboroteca
const spreadsheetId = '1qM9pM-qkPlR6yCeX7eC8i2wBWmAOI1WIDncf8I7pHMM';
const rangoDestino = 'A2';

/**
 * Registra una baja del Club Laboroteca en Google Sheets.
 * Se usa en bajas voluntarias y por impago.
 * 
 * @param {Object} opciones
 * @param {string} opciones.email - Email del usuario
 * @param {string} [opciones.nombre] - Nombre del usuario
 * @param {string} [opciones.motivo] - Motivo de la baja ("impago", "baja voluntaria", etc.)
 */
async function registrarBajaClub({ email, nombre = '', motivo = 'desconocido' }) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    console.warn('⚠️ Email inválido al registrar baja en Sheets:', email);
    return;
  }

  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const fecha = new Date().toLocaleString('es-ES', {
      timeZone: 'Europe/Madrid',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    const fila = [
      email.trim().toLowerCase(),
      nombre.trim() || '-',
      fecha,
      motivo.trim().toLowerCase()
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: rangoDestino,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [fila] }
    });

console.log(`📉 Baja registrada en Sheets: ${email} (${motivo})`);

  } catch (error) {
    console.error('❌ Error al registrar baja en Sheets:', error.message);
  }
}

module.exports = { registrarBajaClub };