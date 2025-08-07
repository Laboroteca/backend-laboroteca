// /entradas/google/sheetsAuth.js

const { google } = require('googleapis');

/**
 * Devuelve un cliente autenticado para usar Google Sheets API
 */
const auth = async () => {
  const authClient = new google.auth.GoogleAuth({
    credentials: JSON.parse(
      Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8')
    ),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  return authClient.getClient();
};

module.exports = { auth };
