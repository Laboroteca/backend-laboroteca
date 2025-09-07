/**
 * Archivo: utils/riskActions.js
 * Objetivo:
 *  - Cerrar TODAS las sesiones activas en WP cuando se dispare el riesgo.
 *  - Forzar "cambio de contraseña requerido" en WP.
 *  - Avisar al usuario por email (SMTP2GO API HTTP).
 *
 * Funciones exportadas:
 *  - closeAllSessions(userId, email?)
 *  - requirePasswordReset(userId, email?)
 *  - sendUserNotice(email)
 */
'use strict';

const crypto = require('crypto');
const fetch  = require('node-fetch');

/* ===================== Config / ENV ===================== */
const WP_RISK_ENDPOINT      = String(process.env.WP_RISK_ENDPOINT || '').trim();          // cerrar sesiones
const WP_RISK_REQUIRE_RESET = String(process.env.WP_RISK_REQUIRE_RESET || '').trim();     // marcar require-reset
const WP_RISK_SECRET        = String(process.env.WP_RISK_SECRET || '').trim();

const SMTP2GO_API_KEY       = String(process.env.SMTP2GO_API_KEY || '').trim();
const SMTP2GO_API_URL       = String(process.env.SMTP2GO_API_URL || 'https://api.smtp2go.com/v3/email/send').trim();
const SMTP2GO_FROM_EMAIL    = String(process.env.SMTP2GO_FROM_EMAIL || 'laboroteca@laboroteca.es').trim();
const SMTP2GO_FROM_NAME     = String(process.env.SMTP2GO_FROM_NAME  || 'Laboroteca').trim();

const USER_RESET_URL        = (process.env.USER_RESET_URL || 'https://www.laboroteca.es/recuperar-contrasena').replace(/\/+$/,'');
const LAB_DEBUG             = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');

/* Pequeña validación de arranque para detectar mal config en producción */
function _assertServerConfig() {
  const errs = [];
  if (!WP_RISK_SECRET) errs.push('WP_RISK_SECRET vacío');
  if (!WP_RISK_ENDPOINT) errs.push('WP_RISK_ENDPOINT vacío');
  if (!SMTP2GO_API_KEY) errs.push('SMTP2GO_API_KEY vacío (solo afecta a emails)');
  if (errs.length && LAB_DEBUG) {
    console.warn('[riskActions] Advertencia de configuración:', errs.join(' | '));
  }
}
_assertServerConfig();

/* ===================== Utilidades comunes ===================== */
function _result(ok, status, data) {
  return { ok: !!ok, status: Number(status) || 0, data: data ?? {} };
}

function _makeSig(userId, ts, secret) {
  return crypto.createHmac('sha256', secret).update(`${userId}.${ts}`).digest('hex');
}

function _abortPair(ms = 10000) {
  const { default: AbortController } = require('abort-controller');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer };
}

/**
 * POST firmado hacia WP (firma en BODY y también en HEADERS por compat).
 * Reintenta con backoff exponencial (3 intentos + el primero = 4 máximo).
 * Éxito si HTTP 2xx o 423 (usuario ya bloqueado/expulsado).
 */
async function _postSigned(url, { userId, email = '' }, { timeoutMs = 8000, label = 'wp-call' } = {}) {
  if (!url || !WP_RISK_SECRET) {
    if (LAB_DEBUG) console.error('[riskActions]', label, 'config incompleta: url/secret');
    return _result(false, 500, { error: 'wp_hmac_not_configured' });
  }

  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return _result(false, 400, { error: 'invalid_userId' });
  }

  const maxRetries = 3;
  const baseDelay  = 400; // ms

  let last = _result(false, 0, { error: 'no_call' });

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ts  = Math.floor(Date.now() / 1000);
    const sig = _makeSig(uid, ts, WP_RISK_SECRET);

    const body = {
      userId: uid,
      email: email || '',
      ts,
      sig
    };

    const { controller, timer } = _abortPair(timeoutMs);
    const reqId = `risk_${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;

    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type'  : 'application/json',
          'Accept'        : 'application/json',
          'User-Agent'    : 'LabRisk/1.0 (+node)',
          'X-Request-Id'  : reqId,
          // Firma también en cabeceras por compatibilidad con distintos handlers
          'X-Risk-Ts'     : String(ts),
          'X-Risk-Sig'    : sig
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const raw = await r.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = { _raw: raw }; }

      const ok = r.ok || r.status === 423; // 423: ya estaba bloqueado
      last = _result(ok, r.status, data);

      if (LAB_DEBUG) {
        console.log(`[riskActions] ${label} → ${url} :: status=${r.status} ok=${ok ? 'yes' : 'no'} id=${reqId}`);
        if (!ok) console.warn(`[riskActions] ${label} respuesta:`, data);
      }

      if (ok) {
        clearTimeout(timer);
        return last;
      }

      // Si no ok, reintentar con backoff
      clearTimeout(timer);
      if (attempt < maxRetries) {
        const delay = Math.floor(baseDelay * Math.pow(2, attempt));
        if (LAB_DEBUG) console.warn(`[riskActions] ${label} intento ${attempt+1} falló; reintento en ${delay}ms…`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      } else {
        break;
      }
    } catch (err) {
      clearTimeout(timer);
      const code = err?.name === 'AbortError' ? 504 : 500;
      last = _result(false, code, { error: err?.message || String(err) });
      if (LAB_DEBUG) console.warn(`[riskActions] ${label} ERROR:`, last.data.error);
      if (attempt < maxRetries) {
        const delay = Math.floor(baseDelay * Math.pow(2, attempt));
        await new Promise(r => setTimeout(r, delay));
        continue;
      } else {
        break;
      }
    }
  }

  return last;
}

/* ===================== Acciones hacia WP ===================== */

/**
 * Cierra TODAS las sesiones en WordPress para el usuario indicado.
 * Devuelve ok=true si WP responde 2xx o 423.
 */
async function closeAllSessions(userId, email) {
  return _postSigned(WP_RISK_ENDPOINT, { userId, email }, { label: 'closeAllSessions' });
}

/**
 * Marca el usuario con "require password reset" en WordPress.
 * Devuelve ok=true si WP responde 2xx o 423.
 */
async function requirePasswordReset(userId, email) {
  if (!WP_RISK_REQUIRE_RESET) {
    if (LAB_DEBUG) console.error('[riskActions] requirePasswordReset sin WP_RISK_REQUIRE_RESET');
    return _result(false, 500, { error: 'wp_reset_endpoint_not_configured' });
  }
  return _postSigned(WP_RISK_REQUIRE_RESET, { userId, email }, { label: 'requirePasswordReset' });
}

/* ===================== Email al usuario (SMTP2GO) ===================== */
/**
 * Envía email informativo al usuario (actividad inusual + enlace a reset).
 * No bloquea la lógica de expulsión/reset; si falla el email, retorna ok=false.
 */
async function sendUserNotice(email) {
  if (!email || !email.includes('@')) return { ok:false, error:'invalid_email' };
  if (!SMTP2GO_API_KEY || !SMTP2GO_API_URL) return { ok:false, error:'smtp_not_configured' };

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

  const { controller, timer } = _abortPair(10000);

  try {
    const resp = await fetch(SMTP2GO_API_URL, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data?.data?.succeeded === 1) {
      if (LAB_DEBUG) console.log('[riskActions] Email enviado a', email);
      clearTimeout(timer);
      return { ok:true };
    }
    const errMsg = data?.data?.error || data?.error || JSON.stringify(data);
    if (LAB_DEBUG) console.error('❌ [riskActions] smtp_send_failed:', errMsg);
    clearTimeout(timer);
    return { ok:false, error:`smtp_send_failed: ${errMsg}` };
  } catch (err) {
    if (LAB_DEBUG) console.error('❌ [riskActions] Error enviando email usuario:', err?.message || err);
    return { ok:false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/* ===================== Exports ===================== */
module.exports = {
  closeAllSessions,
  requirePasswordReset,
  sendUserNotice
};
