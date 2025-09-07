/**
 * Archivo: routes/risk-events.js
 * Rutas:
 *   POST /login-ok   ← WP informa "login correcto" (requiere HMAC)
 *   POST /close-all  ← Node ordena a WP cerrar sesiones (firma HMAC hacia WP)
 *   GET  /ping       ← prueba rápida (sin HMAC)
 *
 * ENV necesarias:
 *   RISK_HMAC_SECRET
 *   WP_RISK_ENDPOINT, WP_RISK_SECRET
 *   WP_RISK_REQUIRE_RESET (opcional, para forzar cambio de contraseña)
 *   RISK_AUTO_ENFORCE=1   (aplica acciones automáticamente si se supera IPS24)
 *   RISK_IPS_24H, RISK_UAS_24H, RISK_LOGINS_15M (umbrales en utils/riskDecider)
 *
 *   === Email (SMTP2GO API HTTP) ===
 *   SMTP2GO_API_KEY=xxxxxxxxxxxxxxxx
 *   SMTP2GO_API_URL=https://api.smtp2go.com/v3/email/send
 *   SMTP2GO_FROM_EMAIL=laboroteca@laboroteca.es
 *   SMTP2GO_FROM_NAME=Laboroteca
 *   ADMIN_EMAIL=laboroteca@gmail.com
 *
 *   PUBLIC_SITE_URL=https://www.laboroteca.es
 *   USER_RESET_URL=https://www.laboroteca.es/recuperar-contrasena
 *
 *   === Normalización opcional de IPs ===
 *   RISK_COLLAPSE_IPV6_64=1  (por defecto 1)  → agrupa IPv6 por /64
 *   RISK_COLLAPSE_IPV4_24=1  (por defecto 0)  → agrupa IPv4 por /24
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const fetch   = require('node-fetch');

const { recordLogin } = require('../utils/riskDecider');
const { closeAllSessions, requirePasswordReset } = require('../utils/riskActions');

const router = express.Router();

const LAB_DEBUG         = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');
const RISK_HMAC_SECRET  = String(process.env.RISK_HMAC_SECRET || '').trim();
const RISK_AUTO_ENFORCE = (process.env.RISK_AUTO_ENFORCE === '1');

const PUBLIC_SITE_URL = (process.env.PUBLIC_SITE_URL || 'https://www.laboroteca.es').replace(/\/+$/,'');
const USER_RESET_URL  = (process.env.USER_RESET_URL  || `${PUBLIC_SITE_URL}/recuperar-contrasena`).replace(/\/+$/,'');

// SMTP2GO API HTTP
const SMTP2GO_API_KEY    = String(process.env.SMTP2GO_API_KEY || '').trim();
const SMTP2GO_API_URL    = String(process.env.SMTP2GO_API_URL || 'https://api.smtp2go.com/v3/email/send').trim();
const SMTP2GO_FROM_EMAIL = String(process.env.SMTP2GO_FROM_EMAIL || 'laboroteca@laboroteca.es').trim();
const SMTP2GO_FROM_NAME  = String(process.env.SMTP2GO_FROM_NAME  || 'Laboroteca').trim();
const ADMIN_EMAIL        = process.env.ADMIN_EMAIL || 'laboroteca@gmail.com';

// Normalización de IPs (reduce falsos positivos en móvil/IPv6)
const COLLAPSE_V6 = process.env.RISK_COLLAPSE_IPV6_64 !== '0'; // por defecto ON
const COLLAPSE_V4 = process.env.RISK_COLLAPSE_IPV4_24 === '1'; // por defecto OFF

/* ──────────────────────────────────────────────────────────
 * Email (SMTP2GO API HTTP)
 * ──────────────────────────────────────────────────────── */
async function sendMail({ to, subject, text, html }) {
  if (!SMTP2GO_API_KEY || !SMTP2GO_API_URL) {
    throw new Error('smtp_not_configured');
  }

  const payload = {
    api_key: SMTP2GO_API_KEY,
    to: Array.isArray(to) ? to : [to],
    sender: `${SMTP2GO_FROM_NAME} <${SMTP2GO_FROM_EMAIL}>`,
    subject: subject || '',
    ...(text ? { text_body: text } : {}),
    ...(html ? { html_body: html } : {}),
  };

  const { default: AbortController } = require('abort-controller');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const r = await fetch(SMTP2GO_API_URL, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok && data && data.data && data.data.succeeded === 1) return { ok:true };

    const errMsg = (data && data.data && data.data.error) || data.error || JSON.stringify(data);
    throw new Error(`smtp_send_failed: ${errMsg}`);
  } finally {
    clearTimeout(timer);
  }
}

/* ──────────────────────────────────────────────────────────
 * Utils
 * ──────────────────────────────────────────────────────── */
function requireJson(req, res, next) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    return res.status(415).json({ ok:false, error:'UNSUPPORTED_MEDIA_TYPE' });
  }
  next();
}

/** HMAC WP → Node: HMAC_SHA256(secret, `${userId}.${ts}`) */
function requireRiskHmac(req, res, next) {
  if (!RISK_HMAC_SECRET) {
    return res.status(500).json({ ok:false, error:'server_missing_hmac_secret' });
  }
  const ts  = String(req.header('X-Risk-Ts')  || '');
  const sig = String(req.header('X-Risk-Sig') || '');
  const uid = String((req.body && req.body.userId) || req.query.userId || '');

  if (!ts || !sig || !uid) return res.status(401).json({ ok:false, error:'bad_hmac_params' });

  const skewOk = Math.abs(Math.floor(Date.now()/1000) - Number(ts)) <= 300;
  if (!skewOk) return res.status(403).json({ ok:false, error:'stale_ts' });

  const calc = crypto.createHmac('sha256', RISK_HMAC_SECRET).update(`${uid}.${ts}`).digest('hex');
  if (sig.length !== calc.length) {
    if (LAB_DEBUG) console.warn('[RISK HMAC] length mismatch');
    return res.status(403).json({ ok:false, error:'bad_hmac_len' });
  }
  const ok = crypto.timingSafeEqual(Buffer.from(calc, 'utf8'), Buffer.from(sig, 'utf8'));
  if (!ok) return res.status(403).json({ ok:false, error:'bad_hmac' });

  res.set('X-HMAC-Checked', '1');
  if (LAB_DEBUG) console.log('[RISK HMAC OK]', { uid, ts });
  next();
}

/* ──────────────────────────────────────────────────────────
 * IP/UA extracción y normalización
 * ──────────────────────────────────────────────────────── */
function collapseIPv6_64(ip) {
  // Agrupa por /64 para no disparar ip24 con privacy addresses
  try {
    if (!ip || ip.indexOf(':') === -1) return ip;
    const parts = ip.split(':');
    if (parts.length >= 4) return parts.slice(0,4).join(':') + '::/64';
    return ip;
  } catch { return ip; }
}

function collapseIPv4_24(ip) {
  try {
    if (!ip || ip.indexOf('.') === -1) return ip;
    const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.\d+$/);
    return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : ip;
  } catch { return ip; }
}

function extractClientIp(req) {
  const h = req.headers || {};
  const cf = (h['cf-connecting-ip'] || '').toString().trim();
  const xr = (h['x-real-ip'] || '').toString().trim();
  const xf = (h['x-forwarded-for'] || '').toString().trim();

  let ip = cf || xr;
  if (!ip) {
    if (xf) {
      // En proxies bien configurados, el último suele ser el cliente real.
      const parts = xf.split(',').map(s => s.trim()).filter(Boolean);
      ip = parts.length ? parts.pop() : '';
    }
  }
  if (!ip) ip = (req.ip || '').toString();

  // Normaliza opcionalmente para reducir ruido
  if (ip.includes(':') && COLLAPSE_V6) ip = collapseIPv6_64(ip);
  else if (ip.indexOf('.') !== -1 && COLLAPSE_V4) ip = collapseIPv4_24(ip);

  return ip;
}

/* ──────────────────────────────────────────────────────────
 * Enforcement hacia WP con backoff (cierre + require reset)
 * ──────────────────────────────────────────────────────── */
async function enforceRiskActions({ userId, email }) {
  const maxRetries = 3;
  const baseDelayMs = 400;

  async function retry(fn, label) {
    let last = { ok:false, status:0, data:{ error:'no_call' } };
    for (let i = 0; i <= maxRetries; i++) {
      last = await fn();
      const ok2xx = last && last.ok === true;
      const ok423 = Number(last && last.status) === 423;
      if (ok2xx || ok423) return { ok:true, status:last.status, data:last.data, tries:i+1 };
      const delay = Math.floor(Math.pow(2, i) * baseDelayMs);
      if (LAB_DEBUG) console.warn(`[risk enforce] ${label} intento ${i+1} falló status=${last && last.status}. Reintentando en ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
    return { ok:false, status:(last && last.status) || 0, data:last && last.data, tries:maxRetries+1 };
  }

  const closeRes = await retry(() => closeAllSessions(userId, email), 'closeAllSessions');
  const resetRes = await retry(() => requirePasswordReset(userId, email), 'requirePasswordReset');

  const summary = {
    closeAll:     { ok: !!(closeRes && closeRes.ok), status: closeRes && closeRes.status, tries: closeRes && closeRes.tries, error: (closeRes && closeRes.data && closeRes.data.error) || null },
    requireReset: { ok: !!(resetRes && resetRes.ok), status: resetRes && resetRes.status, tries: resetRes && resetRes.tries, error: (resetRes && resetRes.data && resetRes.data.error) || null }
  };
  if (summary.closeAll.ok && summary.requireReset.ok) {
    console.log('[risk enforce] ✅ cierre+reset aplicados', summary);
  } else {
    console.warn('[risk enforce] ⚠️ acciones incompletas', summary);
  }
  return summary;
}

/* ──────────────────────────────────────────────────────────
 * Emails (ES)
 * ──────────────────────────────────────────────────────── */
async function emailAdminES({ userId, email, risk, enforce }) {
  const entorno = process.env.NODE_ENV || 'unknown';
  const subject = `🚨 Riesgo ALTO — posible compartición de credenciales · userId=${userId}`;

  const text =
`Se ha detectado actividad de ALTO RIESGO en una cuenta.

Motivo principal: ${risk.reasons.join(', ') || '—'}
Usuario: ${userId}${email ? ` · ${email}` : ''}

Métricas:
- IPs distintas (24h): ${risk.metrics.ip24}
- User-Agents (24h): ${risk.metrics.ua24}
- Logins (15 min): ${risk.metrics.logins15}
- Velocidad geográfica: ${risk.metrics.geoKmh} km/h

Muestras:
- IPs: ${risk.samples.ips.map(x => `${x.ip}(${x.n})`).join(', ')}
- UAs: ${risk.samples.uas.map(x => `${x.ua.slice(0,80)}…(${x.n})`).join(', ')}

Acciones aplicadas automáticamente:
- Cerrar sesiones: ${enforce && enforce.closeAll && enforce.closeAll.ok ? 'sí' : 'no'}
- Forzar cambio de contraseña: ${enforce && enforce.requireReset && enforce.requireReset.ok ? 'sí' : 'no'}

Entorno: ${entorno}`;

  const html =
`<h2>🚨 Riesgo ALTO: posible compartición de credenciales</h2>
<p><strong>Usuario:</strong> ${userId}${email ? ` · ${email}` : ''}</p>
<p><strong>Motivo:</strong> ${risk.reasons.join(', ') || '—'}</p>
<h3>Métricas</h3>
<ul>
  <li>IPs distintas (24h): <strong>${risk.metrics.ip24}</strong></li>
  <li>User-Agents (24h): <strong>${risk.metrics.ua24}</strong></li>
  <li>Logins (15 min): <strong>${risk.metrics.logins15}</strong></li>
  <li>Velocidad geográfica: <strong>${risk.metrics.geoKmh} km/h</strong></li>
</ul>
<h3>Muestras</h3>
<p><strong>IPs:</strong> ${risk.samples.ips.map(x => `${x.ip}(${x.n})`).join(', ')}</p>
<p><strong>UAs:</strong> ${risk.samples.uas.map(x => `${x.ua.slice(0,120)}…(${x.n})`).join(', ')}</p>
<h3>Acciones aplicadas</h3>
<ul>
  <li>Cerrar todas las sesiones en WP: <strong>${enforce && enforce.closeAll && enforce.closeAll.ok ? 'sí' : 'no'}</strong></li>
  <li>Forzar cambio de contraseña: <strong>${enforce && enforce.requireReset && enforce.requireReset.ok ? 'sí' : 'no'}</strong></li>
</ul>
<p style="color:#888">Entorno: ${entorno}</p>`;

  try {
    await sendMail({ to: ADMIN_EMAIL, subject, text, html });
    if (LAB_DEBUG) console.log('[mail → admin] OK');
  } catch (e) {
    console.warn('[mail → admin] ERROR:', e && e.message || e);
  }
}

/** Email al usuario (ES) — copia corregida (no obliga; recomienda) */
async function emailUserES({ email }) {
  if (!email || email.indexOf('@') === -1) return;
  const resetUrl = USER_RESET_URL;

  const subject = 'Seguridad de tu cuenta — actividad inusual detectada';
  const text =
`Hemos detectado actividad inusual en tu cuenta (accesos desde varias direcciones IP).
Por seguridad, hemos cerrado todas las sesiones activas. Te recomendamos cambiar tu contraseña.

Puedes cambiarla aquí:
${resetUrl}

Si no has sido tú, puedes contactarnos a través del buzón de incidencias:
https://www.laboroteca.es/incidencias/`;

  const html =
`<p>Hemos detectado <strong>actividad inusual</strong> en tu cuenta (accesos desde varias direcciones IP).</p>
<p>Por seguridad, hemos cerrado todas las sesiones activas. <strong>Te recomendamos cambiar tu contraseña.</strong></p>
<p><a href="${resetUrl}" target="_blank" rel="noopener noreferrer">Cambiar mi contraseña</a></p>
<p>Si no has sido tú, puedes contactarnos a través del <a href="https://www.laboroteca.es/incidencias/" target="_blank" rel="noopener noreferrer">buzón de incidencias</a>.</p>`;

  try {
    await sendMail({ to: email, subject, text, html });
    if (LAB_DEBUG) console.log('[mail → usuario] OK', email);
  } catch (e) {
    console.warn('[mail → usuario] ERROR:', e && e.message || e);
  }
}

/* ──────────────────────────────────────────────────────────
 * Helper: SOLO disparamos si se supera IPS24
 * ──────────────────────────────────────────────────────── */
function hasIps24Exceeded(reasons) {
  // Razón esperada: "ips24=7>5"
  if (!Array.isArray(reasons)) return false;
  return reasons.some(r => typeof r === 'string' && /^ips24=\d+>\d+$/.test(r));
}

/* ──────────────────────────────────────────────────────────
 * POST /login-ok
 * ──────────────────────────────────────────────────────── */
router.post('/login-ok', requireJson, requireRiskHmac, async (req, res) => {
  try {
    const body = req.body || {};
    const userId = String(body.userId || '');
    const email  = String(body.email  || '');
    const geo    = body.geo || null;

    // UA e IP robustos
    const ua = String(req.headers['user-agent'] || '').slice(0,180);
    let ip = extractClientIp(req);

    // Geo opcional
    const lat = (geo && Number.isFinite(geo.lat)) ? Number(geo.lat)
              : (Number.isFinite(Number(req.headers['x-geo-lat'])) ? Number(req.headers['x-geo-lat']) : undefined);
    const lon = (geo && Number.isFinite(geo.lon)) ? Number(geo.lon)
              : (Number.isFinite(Number(req.headers['x-geo-lon'])) ? Number(req.headers['x-geo-lon']) : undefined);
    const country = (geo && geo.country) ? String(geo.country)
                    : (req.headers['cf-ipcountry'] || req.headers['x-geo-country'] || '');

    // Registrar y decidir
    const risk = recordLogin(String(userId), { ip, ua, lat, lon, country });

    let enforceSummary = null;

    // 🔒 SOLO actuar si se supera IPS24 (nunca por 3er dispositivo ni por otras razones)
    const ipsExceeded = hasIps24Exceeded(risk.reasons);

    if (ipsExceeded && RISK_AUTO_ENFORCE) {
      enforceSummary = await enforceRiskActions({ userId, email }).catch(e => {
        console.warn('[risk enforce] error', e && e.message || e);
        return null;
      });

      // Emails SOLO si ips24 excedido
      await Promise.allSettled([
        emailAdminES({ userId, email, risk, enforce: enforceSummary }),
        emailUserES({ email })
      ]);
    }

    return res.json({ ok:true, userId, email, risk, enforce: enforceSummary });
  } catch (e) {
    console.error('❌ /login-ok error:', e && e.message || e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

/* ──────────────────────────────────────────────────────────
 * POST /close-all
 * ──────────────────────────────────────────────────────── */
router.post('/close-all', requireJson, async (req, res) => {
  try {
    const userId = Number((req.body && req.body.userId) || (req.query && req.query.userId) || 0);
    const email  = String((req.body && req.body.email) || '');
    if (!userId) return res.status(400).json({ ok:false, error:'missing_userId' });

    const summary = await enforceRiskActions({ userId, email });
    const ok = !!(summary && summary.closeAll && summary.closeAll.ok);
    return res.status(ok ? 200 : 502).json({ ok, enforce: summary });
  } catch (e) {
    console.error('❌ /close-all error:', e && e.message || e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

/* Ping */
router.get('/ping', (_req, res) => res.json({ ok:true, pong:true }));

module.exports = router;
