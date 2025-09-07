/**
 * Archivo: utils/riskActions.js
 * Función:
 * - closeAllSessions(userId, email?)
 * - requirePasswordReset(userId, email?)
 * - sendUserNotice(email) → email directo al usuario (SMTP2GO API HTTP)
 * - Predicados y helpers para ENFORCEMENT/EMAILS solo si se supera IPS24
 */

'use strict';

const crypto = require('crypto');
const fetch  = require('node-fetch');

const WP_RISK_ENDPOINT       = String(process.env.WP_RISK_ENDPOINT || '').trim();
const WP_RISK_REQUIRE_RESET  = String(process.env.WP_RISK_REQUIRE_RESET || '').trim(); // opcional
const WP_RISK_SECRET         = String(process.env.WP_RISK_SECRET || '').trim();
const LAB_DEBUG              = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');

const SMTP2GO_API_KEY    = String(process.env.SMTP2GO_API_KEY || '').trim();
const SMTP2GO_API_URL    = String(process.env.SMTP2GO_API_URL || 'https://api.smtp2go.com/v3/email/send').trim();
const SMTP2GO_FROM_EMAIL = String(process.env.SMTP2GO_FROM_EMAIL || 'laboroteca@laboroteca.es').trim();
const SMTP2GO_FROM_NAME  = String(process.env.SMTP2GO_FROM_NAME  || 'Laboroteca').trim();

const USER_RESET_URL = (process.env.USER_RESET_URL || 'https://www.laboroteca.es/recuperar-contrasena').replace(/\/+$/,'');

/* ──────────────────────────────────────────────────────────
 * Utils
 * ──────────────────────────────────────────────────────── */
function _result(ok, status, data) {
  return { ok: !!ok, status: Number(status) || 0, data: data ?? {} };
}

function _hasIps24Exceeded(reasons) {
  // Razón esperada: "ips24=7>5"
  if (!Array.isArray(reasons)) return false;
  return reasons.some(r => typeof r === 'string' && /^ips24=\d+>\d+$/.test(r));
}

/** Políticas: SOLO actuamos/avisamos si se supera ips24 */
function shouldEnforceWP(risk) {
  return !!(risk && Array.isArray(risk.reasons) && _hasIps24Exceeded(risk.reasons));
}
function shouldNotifyUser(risk) {
  return shouldEnforceWP(risk); // mismo criterio: solo ips24
}
function shouldNotifyAdmin(risk) {
  return shouldEnforceWP(risk); // mismo criterio: solo ips24
}

/* ──────────────────────────────────────────────────────────
 * Petición firmada a WP (HMAC)
 * ──────────────────────────────────────────────────────── */
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

/* ──────────────────────────────────────────────────────────
 * Acciones WP
 * ──────────────────────────────────────────────────────── */
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
 * Enforcement con reintentos/backoff (cierre + require reset).
 * Llama a los endpoints de WP para:
 *  - cerrar todas las sesiones del usuario
 *  - marcar el flag de "require reset" (tu plugin WP ya bloquea el login y fuerza reset)
 */
async function enforceWithBackoff(userId, email) {
  const maxRetries = 3;
  const baseDelayMs = 400;

  async function retry(fn, label) {
    let last = { ok:false, status:0, data:{ error:'no_call' } };
    for (let i = 0; i <= maxRetries; i++) {
      last = await fn();
      const ok2xx = last && last.ok === true;
      const ok423 = Number(last?.status) === 423;
      if (ok2xx || ok423) return { ok:true, status:last.status, tries:i+1, data:last.data };
      const delay = Math.floor(Math.pow(2, i) * baseDelayMs);
      if (LAB_DEBUG) console.warn(`[risk enforce] ${label} intento ${i+1} falló status=${last?.status}. Reintentando en ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
    return { ok:false, status:last?.status || 0, tries:maxRetries+1, data:last?.data };
  }

  const closeRes = await retry(() => closeAllSessions(userId, email), 'closeAllSessions');
  const resetRes = await retry(() => requirePasswordReset(userId, email), 'requirePasswordReset');

  const summary = {
    closeAll:     { ok: closeRes.ok, status: closeRes.status, tries: closeRes.tries, error: closeRes.data?.error || null },
    requireReset: { ok: resetRes.ok, status: resetRes.status, tries: resetRes.tries, error: resetRes.data?.error || null }
  };

  if (summary.closeAll.ok && summary.requireReset.ok) {
    console.log('[risk enforce] ✅ cierre+reset aplicados', summary);
  } else {
    console.warn('[risk enforce] ⚠️ acciones incompletas', summary);
  }
  return summary;
}

/* ──────────────────────────────────────────────────────────
 * Email usuario (SMTP2GO API HTTP) — SOLO cuando ips24 excedido
 * ──────────────────────────────────────────────────────── */
async function sendUserNotice(email) {
  if (!email || !email.includes('@')) return { ok:false, error:'invalid_email' };

  if (!SMTP2GO_API_KEY || !SMTP2GO_API_URL) {
    // Mantener mensaje compatible con tus logs
    return { ok:false, error:'smtp_not_configured' };
  }

  const subject = 'Seguridad de tu cuenta — actividad inusual detectada';
  const text = `Hemos detectado actividad inusual en tu cuenta (accesos desde varias direcciones IP).
Por seguridad, hemos cerrado todas las sesiones activas. Te recomendamos cambiar tu contraseña.

Puedes cambiarla aquí: ${USER_RESET_URL}

Si no has sido tú, puedes contactarnos a través del buzón de incidencias:
https://www.laboroteca.es/incidencias/`;

  const html = `
<p>Hemos detectado <strong>actividad inusual</strong> en tu cuenta (accesos desde varias direcciones IP).</p>
<p>Por seguridad, hemos cerrado todas las sesiones activas. <strong>Te recomendamos cambiar tu contraseña.</strong></p>
<p><a href="${USER_RESET_URL}" target="_blank" rel="noopener noreferrer">Cambiar mi contraseña</a></p>
<p>Si no has sido tú, puedes contactarnos a través del <a href="https://www.laboroteca.es/incidencias/" target="_blank" rel="noopener noreferrer">buzón de incidencias</a>.</p>
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
  // Acciones WP
  closeAllSessions,
  requirePasswordReset,
  enforceWithBackoff,

  // Emails
  sendUserNotice,

  // Predicados para que la RUTA decida correctamente
  shouldEnforceWP,
  shouldNotifyUser,
  shouldNotifyAdmin,
};
