// utils/unsubToken.js
'use strict';

const crypto = require('crypto');

const SECRET = process.env.MKT_UNSUB_SECRET || 'change_me_secret';

/**
 * Genera un token seguro de baja de newsletter.
 * @param {string} email - Email del destinatario
 * @param {number} ttlDays - Tiempo de validez en días (por defecto 365)
 * @returns {string} token firmado
 */
function generarUnsubToken(email, ttlDays = 365) {
  const head = Buffer.from(JSON.stringify({ alg:'HS256', typ:'LSIG' })).toString('base64url');

  const now = Math.floor(Date.now() / 1000);
  const exp = now + (ttlDays * 24 * 60 * 60);

  const body = Buffer.from(JSON.stringify({
    email: String(email).toLowerCase().trim(),
    scope: 'newsletter',
    act: 'unsubscribe',
    iat: now,
    exp
  })).toString('base64url');

  const sig = crypto
    .createHmac('sha256', SECRET)
    .update(`${head}.${body}`)
    .digest('base64url');

  return `${head}.${body}.${sig}`;
}

/**
 * Construye la URL completa de baja
 * @param {string} email
 * @returns {string} URL
 */
function generarUnsubUrl(email) {
  const token = generarUnsubToken(email);
  return `https://www.laboroteca.es/unsubscribe?token=${encodeURIComponent(token)}`;
}

module.exports = { generarUnsubToken, generarUnsubUrl };
