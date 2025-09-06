/**
 * Archivo: utils/riskActions.js
 * Función: acciones hacia WordPress firmadas con HMAC.
 *   - closeAllSessions(userId, email?)
 *   - requirePasswordReset(userId, email?)
 */

'use strict';

const crypto = require('crypto');
const fetch  = require('node-fetch');

const WP_RISK_ENDPOINT      = String(process.env.WP_RISK_ENDPOINT || '').trim();
const WP_RISK_REQUIRE_RESET = String(process.env.WP_RISK_REQUIRE_RESET || '').trim(); // opcional
const WP_RISK_SECRET        = String(process.env.WP_RISK_SECRET || '').trim();
const LAB_DEBUG             = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');

async function _postSigned(url, userId, email) {
  if (!url || !WP_RISK_SECRET) {
    return { ok:false, status:500, data:{ error:'wp_hmac_not_configured' } };
  }
  const ts  = Math.floor(Date.now()/1000);
  const sig = crypto.createHmac('sha256', WP_RISK_SECRET).update(`${userId}.${ts}`).digest('hex');

  const controller = new (require('abort-controller'))();
  const timer = setTimeout(()=>controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type':'application/json',
        'x-request-id': `risk_${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`
      },
      body: JSON.stringify({ userId: Number(userId), ts, sig, email: email || '' }),
      signal: controller.signal
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
    if (LAB_DEBUG) console.log('[riskActions] POST', url, r.status, data?.error || 'ok');
    return { ok: r.ok, status: r.status, data };
  } finally {
    clearTimeout(timer);
  }
}

async function closeAllSessions(userId, email) {
  return _postSigned(WP_RISK_ENDPOINT, userId, email);
}
async function requirePasswordReset(userId, email) {
  if (!WP_RISK_REQUIRE_RESET) {
    return { ok:false, status:500, data:{ error:'wp_reset_endpoint_not_configured' } };
  }
  return _postSigned(WP_RISK_REQUIRE_RESET, userId, email);
}

module.exports = {
  closeAllSessions,
  requirePasswordReset,
};
