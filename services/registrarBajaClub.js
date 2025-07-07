// /services/registrarBajaClub.js

const { google } = require('googleapis');

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
  throw new Error('❌ Error al parsear las credenciales de Google Cloud: ' + err.message);
}

// ID de la hoja específica para bajas del Club Laboroteca
const spreadsheetId = '1qM9pM-qkPlR6yCeX7eC8i2wBWmAOI1WIDncf8I7pHMM';
const rangoDestino = 'A2'; // Insertar en la primera fila libre

/**
 * Registra una baja del Club Laboroteca en Google Sheets.
 * Se ejecuta siempre que el usuario solicita la baja,
 * incluso si Stripe o MemberPress fallan después.
 * 
 * @param {Object} opciones
 * @param {string} opciones.email - Email del usuario
 * @param {string} [opciones.nombre] - Nombre (opcional)
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

    const fila = [email.trim().toLowerCase(), nombre.trim(), fecha, motivo.trim()];

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: rangoDestino,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [fila],
      },
    });

    console.log(`📉 Baja registrada en Google Sheets: ${email} (${motivo})`);

  } catch (error) {
    console.error('❌ Error al registrar baja en Google Sheets:', error.message);
  }
}

module.exports = { registrarBajaClub };
