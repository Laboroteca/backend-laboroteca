/**
 * Archivo: utils/riskActions.js
 * Función:
 * - closeAllSessions(userId, email?)
 * - requirePasswordReset(userId, email?)
 * - sendUserNotice(email) → email directo al usuario infractor (SMTP2GO API HTTP)
 */
'use strict';

const crypto = require('crypto');
const fetch  = require('node-fetch');

const WP_RISK_ENDPOINT       = String(process.env.WP_RISK_ENDPOINT || '').trim();
const WP_RISK_REQUIRE_RESET  = String(process.env.WP_RISK_REQUIRE_RESET || '').trim(); // opcional
const WP_RISK_SECRET         = String(process.env.WP_RISK_SECRET || '').trim();
const LAB_DEBUG              = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');

const SMTP2GO_API_KEY   = String(process.env.SMTP2GO_API_KEY || '').trim();
const SMTP2GO_API_URL   = String(process.env.SMTP2GO_API_URL || 'https://api.smtp2go.com/v3/email/send').trim();
const SMTP2GO_FROM_EMAIL= String(process.env.SMTP2GO_FROM_EMAIL || 'laboroteca@laboroteca.es').trim();
const SMTP2GO_FROM_NAME = String(process.env.SMTP2GO_FROM_NAME  || 'Laboroteca').trim();

const USER_RESET_URL = (process.env.USER_RESET_URL || 'https://www.laboroteca.es/recuperar-contrasena').replace(/\/+$/,'');

function _result(ok, status, data) {
  return { ok: !!ok, status: Number(status) || 0, data: data ?? {} };
}

async function _postSigned(url, userId, email) {
  if (!url || !WP_RISK_SECRET) {
    return _result(false, 500, { error: 'wp_hmac_not_configured' });
  }
  const ts  = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', WP_RISK_SECRET)
                    .update(`${userId}.${ts}`).digest('hex');

  const { default: AbortController } = require('abort-controller');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Accept'       : 'application/json',
        'User-Agent'   : 'LabRisk/1.0 (+node)',
        'X-Request-Id' : `risk_${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`
      },
      body: JSON.stringify({ userId: Number(userId), ts, sig, email: email || '' }),
      signal: controller.signal
    });

    const raw = await r.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; }
    catch { data = { _raw: raw }; }

    // Éxito si es 2xx ó 423 (ya bloqueado en WP)
    const ok = r.ok || r.status === 423;
    if (LAB_DEBUG) {
      console.log('[riskActions]', 'POST', url, r.status, ok ? 'ok' : (data?.error || 'fail'));
    }
    return _result(ok, r.status, data);
  } catch (err) {
    if (LAB_DEBUG) console.warn('[riskActions] ERROR', url, err?.name || '', err?.message || err);
    const code = err?.name === 'AbortError' ? 504 : 500;
    return _result(false, code, { error: err?.message || String(err) });
  } finally {
    clearTimeout(timer);
  }
}

async function closeAllSessions(userId, email) {
  return _postSigned(WP_RISK_ENDPOINT, userId, email);
}

async function requirePasswordReset(userId, email) {
  if (!WP_RISK_REQUIRE_RESET) {
    return _result(false, 500, { error: 'wp_reset_endpoint_not_configured' });
  }
  return _postSigned(WP_RISK_REQUIRE_RESET, userId, email);
}

/**
 * Envía email al usuario infractor para que cambie la contraseña (SMTP2GO API HTTP)
 */
async function sendUserNotice(email) {
  if (!email || !email.includes('@')) return { ok:false, error:'invalid_email' };

  if (!SMTP2GO_API_KEY || !SMTP2GO_API_URL) {
    // Mantener mensaje compatible con tus logs
    return { ok:false, error:'smtp_not_configured' };
  }

  const subject = 'Seguridad de tu cuenta — es necesario cambiar la contraseña';
  const text = `Hemos detectado actividad inusual en tu cuenta (accesos desde demasiadas direcciones IP).
Por seguridad, hemos cerrado todas las sesiones activas y debes cambiar tu contraseña para volver a acceder.

Cambia tu contraseña aquí: ${USER_RESET_URL}

Si no has sido tú, responde a este email.`;

  const html = `
<p>Hemos detectado <strong>actividad inusual</strong> en tu cuenta (accesos desde demasiadas direcciones IP).</p>
<p>Por seguridad, hemos cerrado todas las sesiones activas y <strong>debes cambiar tu contraseña</strong> para volver a acceder.</p>
<p><a href="${USER_RESET_URL}" target="_blank" rel="noopener noreferrer">Cambiar mi contraseña</a></p>
<p>Si no has sido tú, responde a este email.</p>
`.trim();

  const payload = {
    api_key: SMTP2GO_API_KEY,
    to: [ email ],
    sender: `${SMTP2GO_FROM_NAME} <${SMTP2GO_FROM_EMAIL}>`,
    subject,
    text_body: text,
    html_body: html
  };

  const { default: AbortController } = require('abort-controller');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(SMTP2GO_API_URL, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const data = await resp.json().catch(() => ({}));

    // Éxito según contrato SMTP2GO v3
    if (resp.ok && data?.data?.succeeded === 1) {
      if (LAB_DEBUG) console.log('[riskActions] Email enviado a usuario', email);
      return { ok:true };
    }

    const errMsg = data?.data?.error || data?.error || JSON.stringify(data);
    if (LAB_DEBUG) console.error('❌ [riskActions] smtp_send_failed:', errMsg);
    return { ok:false, error:`smtp_send_failed: ${errMsg}` };
  } catch (err) {
    if (LAB_DEBUG) console.error('❌ [riskActions] Error enviando email usuario:', err?.message || err);
    return { ok:false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  closeAllSessions,
  requirePasswordReset,
  sendUserNotice
};
