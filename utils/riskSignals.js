// utils/closeAllSessionsWP.js
'use strict';

const crypto = require('crypto');
const fetch = require('node-fetch');
const { default: AbortController } = require('abort-controller');

const LAB_DEBUG = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');

const WP_ENDPOINT      = String(process.env.WP_RISK_ENDPOINT || '').trim();
const WP_SECRET        = String(process.env.WP_RISK_SECRET   || '').trim();
const WP_TIMEOUT_MS    = Math.max(3000, Number(process.env.WP_RISK_TIMEOUT_MS || 8000));
const MAX_RETRIES      = Math.max(0, Number(process.env.WP_RISK_MAX_RETRIES || 3));
const BASE_DELAY_MS    = Math.max(100, Number(process.env.WP_RISK_BASE_DELAY_MS || 400));
const ALLOW_HTTP_WP    = (process.env.ALLOW_HTTP_WP === '1'); // permitir http en dev si es necesario

function hmac(secret, msg) {
  return crypto.createHmac('sha256', String(secret)).update(String(msg)).digest('hex');
}

function redact(str, keepEnd = 4) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= keepEnd) return '*'.repeat(s.length);
  return '*'.repeat(Math.max(4, s.length - keepEnd)) + s.slice(-keepEnd);
}

function sanitizeEmail(e) {
  const s = String(e || '').trim();
  if (!s) return '';
  if (s.length > 254) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return '';
  return s;
}

function isHttpsUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:';
  } catch { return false; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function abortPair(ms = WP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { controller, timer };
}

/**
 * Cierra todas las sesiones en WP (firmado con HMAC).
 * Éxito = respuesta 2xx. Reintenta en 0.4s, 0.8s, 1.6s… con jitter si falla.
 *
 * @param {number|string} userId
 * @param {string} [email]  // opcional, para logs del lado WP
 * @returns {Promise<{ok:boolean,status:number,data:any,tries:number,reqId:string}>}
 */
async function closeAllSessionsWP(userId, email = '') {
  // Config obligatoria
  if (!WP_ENDPOINT || !WP_SECRET) {
    if (LAB_DEBUG) console.error('[wpClose] not_configured', { haveEndpoint: !!WP_ENDPOINT, haveSecret: !!WP_SECRET });
    return { ok:false, status:500, data:{ error:'wp_hmac_not_configured' }, tries:0, reqId:'-' };
  }

  // HTTPS salvo override explícito
  if (!ALLOW_HTTP_WP && !isHttpsUrl(WP_ENDPOINT)) {
    if (LAB_DEBUG) console.error('[wpClose] endpoint_not_https');
    return { ok:false, status:500, data:{ error:'endpoint_not_https' }, tries:0, reqId:'-' };
  }

  // userId válido
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) {
    if (LAB_DEBUG) console.warn('[wpClose] bad_userId', { userId });
    return { ok:false, status:400, data:{ error:'bad_userId' }, tries:0, reqId:'-' };
  }

  const safeEmail = sanitizeEmail(email); // puede ser ''
  const reqId = `risk_${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;
  const idemKey = `wpClose:${uid}:${Date.now()}`.slice(0, 64); // para correlación e idempotencia

  async function once() {
    const ts  = Math.floor(Date.now() / 1000);
    const sig = hmac(WP_SECRET, `${uid}.${ts}`);

    const { controller, timer } = abortPair(WP_TIMEOUT_MS);
    try {
      const body = JSON.stringify({ userId: uid, ts, sig, email: safeEmail });
      const r = await fetch(WP_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type'      : 'application/json',
          'x-request-id'      : reqId,
          'x-idempotency-key' : idemKey,
          'x-risk-ts'         : String(ts),
          'x-risk-sig'        : sig, // mismo HMAC en header para facilitar validación en WP
        },
        body,
        signal: controller.signal
      });

      const raw = await r.text();
      let data; try { data = JSON.parse(raw); } catch { data = { _raw: raw }; }

      if (LAB_DEBUG) {
        console.log('[wpClose] resp', {
          status: r.status,
          ok: r.ok,
          safe: { uid, reqId, email: safeEmail || undefined },
          provider: (typeof data === 'object' ? Object.keys(data).slice(0,8) : typeof data)
        });
      }

      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      const status = (e?.name === 'AbortError') ? 504 : 500;
      if (LAB_DEBUG) console.error('[wpClose] exception', { status, msg: e?.message || String(e), uid, reqId });
      return { ok:false, status, data:{ error: e?.message || String(e) } };
    } finally {
      clearTimeout(timer);
    }
  }

  let last = { ok:false, status:0, data:null };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    last = await once();
    if (last.ok) {
      return { ok:true, status:last.status, data:last.data, tries:attempt+1, reqId };
    }
    // Reintentos solo para códigos transitorios: 423 (locked), 429, 5xx, 504 timeout
    const transitory = last.status === 423 || last.status === 429 || last.status === 504 || (last.status >= 500 && last.status <= 599);
    if (!transitory) break;

    // Backoff exponencial con jitter (±25%)
    const base = BASE_DELAY_MS * Math.pow(2, attempt);
    const jitter = base * (0.5 + Math.random() * 0.5) * 0.5; // ±25%
    const delay = Math.floor(base + jitter);
    if (LAB_DEBUG) console.log('[wpClose] retry', { attempt: attempt+1, delayMs: delay, status: last.status, uid, reqId });
    await sleep(delay);
  }

  return { ok:false, status:last.status || 0, data:last.data, tries:MAX_RETRIES+1, reqId };
}

module.exports = { closeAllSessionsWP };
