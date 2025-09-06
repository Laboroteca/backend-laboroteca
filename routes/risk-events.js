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
 *   RISK_AUTO_ENFORCE=1   (aplica acciones automáticamente si risk.level === 'high')
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

const SMTP2GO_API_KEY    = String(process.env.SMTP2GO_API_KEY || '').trim();
const SMTP2GO_API_URL    = String(process.env.SMTP2GO_API_URL || 'https://api.smtp2go.com/v3/email/send').trim();
const SMTP2GO_FROM_EMAIL = String(process.env.SMTP2GO_FROM_EMAIL || 'laboroteca@laboroteca.es').trim();
const SMTP2GO_FROM_NAME  = String(process.env.SMTP2GO_FROM_NAME  || 'Laboroteca').trim();
const ADMIN_EMAIL        = process.env.ADMIN_EMAIL || 'laboroteca@gmail.com';

/* ──────────────────────────────────────────────────────────
 * Mailer (SMTP2GO API HTTP)
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
    // SMTP2GO v3 admite text_body y/o html_body:
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

    if (r.ok && data?.data?.succeeded === 1) {
      return { ok:true };
    }
    const errMsg = data?.data?.error || data?.error || JSON.stringify(data);
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

/**
 * Enforce robusto en WP (cierre + reset) con reintentos y backoff.
 */
async function enforceRiskActions({ userId, email }) {
  const maxRetries = 3;
  const baseDelayMs = 400;

  async function retry(fn, label) {
    let last = { ok:false, status:0, data:{ error:'no_call' } };
    for (let i = 0; i <= maxRetries; i++) {
      last = await fn();
      const ok2xx = last && last.ok === true;
      const ok423 = Number(last?.status) === 423;
      if (ok2xx || ok423) return { ok:true, status:last.status, data:last.data, tries:i+1 };
      const delay = Math.floor(Math.pow(2, i) * baseDelayMs);
      if (LAB_DEBUG) console.warn(`[risk enforce] ${label} intento ${i+1} falló status=${last?.status}. Reintentando en ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
    return { ok:false, status:last?.status || 0, data:last?.data, tries:maxRetries+1 };
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

/** Email al admin (ES) */
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
- Cerrar sesiones: ${enforce?.closeAll?.ok ? 'sí' : 'no'}
- Forzar cambio de contraseña: ${enforce?.requireReset?.ok ? 'sí' : 'no'}

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
  <li>Cerrar todas las sesiones en WP: <strong>${enforce?.closeAll?.ok ? 'sí' : 'no'}</strong></li>
  <li>Forzar cambio de contraseña: <strong>${enforce?.requireReset?.ok ? 'sí' : 'no'}</strong></li>
</ul>
<p style="color:#888">Entorno: ${entorno}</p>`;

  try {
    await sendMail({ to: ADMIN_EMAIL, subject, text, html });
    if (LAB_DEBUG) console.log('[mail → admin] OK');
  } catch (e) {
    console.warn('[mail → admin] ERROR:', e?.message || e);
  }
}

/** Email al usuario infractor (ES) */
async function emailUserES({ email }) {
  if (!email || !email.includes('@')) return;
  const resetUrl = USER_RESET_URL;

  const subject = 'Seguridad de tu cuenta — es necesario cambiar la contraseña';
  const text =
`Hemos detectado actividad inusual en tu cuenta (accesos desde demasiadas direcciones IP).
Por seguridad, hemos cerrado todas las sesiones activas y debes cambiar tu contraseña para volver a acceder.

Cambia tu contraseña aquí:
${resetUrl}

Si no has sido tú, responde a este email.`;

  const html =
`<p>Hemos detectado <strong>actividad inusual</strong> en tu cuenta (accesos desde demasiadas direcciones IP).</p>
<p>Por seguridad, hemos cerrado todas las sesiones activas y <strong>debes cambiar tu contraseña</strong> para volver a acceder.</p>
<p><a href="${resetUrl}" target="_blank" rel="noopener noreferrer">Cambiar mi contraseña</a></p>
<p>Si no has sido tú, responde a este email.</p>`;

  try {
    await sendMail({ to: email, subject, text, html });
    if (LAB_DEBUG) console.log('[mail → usuario] OK', email);
  } catch (e) {
    console.warn('[mail → usuario] ERROR:', e?.message || e);
  }
}

/* ──────────────────────────────────────────────────────────
 * POST /login-ok
 * ──────────────────────────────────────────────────────── */
router.post('/login-ok', requireJson, requireRiskHmac, async (req, res) => {
  try {
    const { userId = '', email = '', geo = null } = (req.body || {});

    // IP y UA
    const ipHdr = (req.headers['x-forwarded-for'] || req.ip || '').toString();
    const ip = ipHdr.split(',')[0].trim();
    const ua = String(req.headers['user-agent'] || '').slice(0,180);

    // Geo opcional
    const lat = geo && Number.isFinite(geo.lat) ? Number(geo.lat)
               : (Number.isFinite(Number(req.headers['x-geo-lat'])) ? Number(req.headers['x-geo-lat']) : undefined);
    const lon = geo && Number.isFinite(geo.lon) ? Number(geo.lon)
               : (Number.isFinite(Number(req.headers['x-geo-lon'])) ? Number(req.headers['x-geo-lon']) : undefined);
    const country = (geo && geo.country) ? String(geo.country)
                    : (req.headers['cf-ipcountry'] || req.headers['x-geo-country'] || '');

    // Registrar y decidir
    const risk = recordLogin(String(userId), { ip, ua, lat, lon, country });

    let enforceSummary = null;

    if (risk.level === 'high' && RISK_AUTO_ENFORCE) {
      enforceSummary = await enforceRiskActions({ userId, email }).catch(e => {
        console.warn('[risk enforce] error', e?.message || e);
        return null;
      });

      await Promise.allSettled([
        emailAdminES({ userId, email, risk, enforce: enforceSummary }),
        emailUserES({ email })
      ]);
    }

    return res.json({ ok:true, userId, email, risk, enforce: enforceSummary });
  } catch (e) {
    console.error('❌ /login-ok error:', e?.message || e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

/* ──────────────────────────────────────────────────────────
 * POST /close-all
 * ──────────────────────────────────────────────────────── */
router.post('/close-all', requireJson, async (req, res) => {
  try {
    const userId = Number(req.body?.userId || req.query?.userId || 0);
    const email  = String(req.body?.email || '');
    if (!userId) return res.status(400).json({ ok:false, error:'missing_userId' });

    const summary = await enforceRiskActions({ userId, email });
    const ok = !!(summary && summary.closeAll && summary.closeAll.ok);
    return res.status(ok ? 200 : 502).json({ ok, enforce: summary });
  } catch (e) {
    console.error('❌ /close-all error:', e?.message || e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

/* Ping */
router.get('/ping', (_req, res) => res.json({ ok:true, pong:true }));

module.exports = router;
