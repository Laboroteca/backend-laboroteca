// utils/alertAdmin.js
'use strict';

const crypto = require('crypto');
const { enviarEmailPersonalizado } = require('../services/email');

// ───────────────────────── Config ─────────────────────────
const ADMIN_EMAIL = process.env.ADMIN_ALERTS_TO || 'laboroteca@gmail.com';

// ───────────────────── Utils locales seguras ─────────────
const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const hash12 = (e) =>
  crypto.createHash('sha256').update(String(e || '').toLowerCase()).digest('hex').slice(0, 12);

// Dedupe en memoria (TTL)
const _seen = new Map(); // key -> expiresAt (epoch ms)
const _TTL_MS = Number(process.env.ADMIN_ALERT_DEDUPE_TTL_MS || 10 * 60 * 1000); // 10 min

function _dedupeHit(key) {
  const now = Date.now();
  // limpia expirados ocasionalmente
  if (_seen.size > 500) {
    for (const [k, exp] of _seen.entries()) if (exp <= now) _seen.delete(k);
  }
  const exp = _seen.get(key);
  if (exp && exp > now) return true; // ya visto
  _seen.set(key, now + _TTL_MS);
  return false;
}

/**
 * Acepta:
 *   alertAdmin('mensaje', { area, email, err, meta, dedupeKey? })
 *   alertAdmin({ area, email, err|error|message, meta, dedupeKey? })
 */
async function alertAdmin(arg, legacyMeta = {}) {
  try {
    const payload =
      arg && typeof arg === 'object' && !Array.isArray(arg)
        ? arg
        : { message: String(arg || ''), ...(legacyMeta || {}) };

    const area = payload.area || 'general';
    const email = payload.email || '-';
    const err = payload.err ?? payload.error ?? payload.message ?? '-';
    const meta = payload.meta || {};
    const dedupeKey =
      payload.dedupeKey ||
      `alert:${String(area).toLowerCase()}:${hash12(String(email || '-'))}:${hash12(
        String(err && err.message ? err.message : err || '-')
      )}`;

    // Dedupe
    if (_dedupeHit(dedupeKey)) return;

    const E = (v) => escapeHtml(String(v ?? '-'));
    const T = (v) => String(v ?? '-');

    const subject = `🚨 FALLO ${T(area).toUpperCase()} — ${T(email)}`;
    const text = [
      `Área: ${T(area)}`,
      `Email: ${T(email)}`,
      `Error: ${T(err && err.message ? err.message : err || '-')}`,
      `Meta: ${T(JSON.stringify(meta))}`,
      `Entorno: ${T(process.env.NODE_ENV || 'dev')}`,
      ``,
      `ℹ️ Pega este email en ChatGPT para generar un comando y solucionarlo manualmente en PowerShell.`,
    ].join('\n');

    const html = `
      <h3>Fallo en ${E(area)}</h3>
      <ul>
        <li><strong>Email:</strong> ${E(email)}</li>
        <li><strong>Error:</strong> ${E(err && err.message ? err.message : err || '-')}</li>
        <li><strong>Entorno:</strong> ${E(process.env.NODE_ENV || 'dev')}</li>
      </ul>
      <pre style="white-space:pre-wrap">${E(JSON.stringify(meta, null, 2))}</pre>
      <p style="margin-top:15px;color:#444;font-size:14px">
        ℹ️ Pega este email en ChatGPT para generar un comando y solucionarlo manualmente en PowerShell.
      </p>
    `;

    await enviarEmailPersonalizado({ to: ADMIN_EMAIL, subject, text, html });
  } catch (e) {
    // Nunca lanzar: solo log seguro
    const msg = e && e.message ? e.message : e;
    console.error('⚠️ alertAdmin fallo:', msg);
  }
}

// Compat: export default y named
module.exports = alertAdmin;
module.exports.alertAdmin = alertAdmin;
