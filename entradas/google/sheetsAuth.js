// /entradas/google/sheetsAuth.js

'use strict';

const { google } = require('googleapis');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

/**
 * Devuelve un cliente autenticado para usar Google Sheets API.
 * - Alerta al admin si faltan credenciales, están mal formadas o falla GoogleAuth.
 * - No expone secretos en logs/alertas.
 */
const auth = async (opts = {}) => {
  const userEmail = typeof opts.email === 'string' && opts.email.trim() ? opts.email.trim() : '-';
  let alerted = false;

  try {
    const b64 = (process.env.GCP_CREDENTIALS_BASE64 || '').trim();
    if (!b64) {
      const err = new Error('GCP_CREDENTIALS_BASE64 ausente');
      try {
        await alertAdmin({
          area: 'sheetsAuth',
          email: userEmail,
          err,
          meta: { hasCreds: false, b64len: 0, scopes: SCOPES }
        });
        alerted = true;
      } catch (_) {}
      throw err;
    }

    let credsJson;
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      credsJson = JSON.parse(decoded);
    } catch (e) {
      const err = new Error('Credenciales GCP mal formadas (base64/JSON)');
      try {
        await alertAdmin({
          area: 'sheetsAuth',
          email: userEmail,
          err,
          meta: { hasCreds: true, b64len: b64.length, parseError: String(e?.message || e), scopes: SCOPES }
        });
        alerted = true;
      } catch (_) {}
      throw err;
    }

    const authClient = new google.auth.GoogleAuth({
      credentials: credsJson,
      scopes: SCOPES
    });

    return await authClient.getClient();
  } catch (err) {
    // Fallback de alerta general si no se alertó aún
    if (!alerted) {
      try {
        await alertAdmin({
          area: 'sheetsAuth',
          email: userEmail,
          err,
          meta: { note: 'Fallo al obtener GoogleAuth client', env: process.env.NODE_ENV || 'dev', scopes: SCOPES }
        });
      } catch (_) {}
    }
    throw err;
  }
};

module.exports = { auth };
