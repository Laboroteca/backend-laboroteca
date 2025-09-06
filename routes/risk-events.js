/**
 * Archivo: routes/risk-events.js
 * Rutas:
 *   POST /risk/login-ok   ← WP informa "login correcto" (requiere HMAC)
 *   POST /risk/close-all  ← Node ordena a WP cerrar todas las sesiones (firma HMAC hacia WP)
 *   GET  /risk/ping       ← prueba rápida (sin HMAC)
 *
 * ENV requeridas:
 *   RISK_HMAC_SECRET        (HMAC que firma WP → Node)
 *   WP_RISK_ENDPOINT        (p.ej. https://www.laboroteca.es/wp-admin/admin-ajax.php?action=lab_risk_close_all)
 *   WP_RISK_SECRET          (HMAC que firma Node → WP)
 *   WP_RISK_REQUIRE_RESET   (opcional; p.ej. https://www.laboroteca.es/wp-admin/admin-ajax.php?action=lab_risk_require_reset)
 *
 * Umbrales (override por ENV):
 *   RISK_MAX_IPS_24=8
 *   RISK_MAX_UA_24=6
 *   RISK_MAX_LOGINS_15=10
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const fetch   = require('node-fetch');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const router = express.Router();

const LAB_DEBUG = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');

// ───────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────
const RISK_HMAC_SECRET      = String(process.env.RISK_HMAC_SECRET || '').trim();

const WP_RISK_ENDPOINT      = String(process.env.WP_RISK_ENDPOINT || '').trim();
const WP_RISK_SECRET        = String(process.env.WP_RISK_SECRET   || '').trim();
const WP_RISK_REQUIRE_RESET = String(process.env.WP_RISK_REQUIRE_RESET || '').trim(); // opcional

const MAX_IPS_24     = Number(process.env.RISK_MAX_IPS_24     || 8);
const MAX_UA_24      = Number(process.env.RISK_MAX_UA_24      || 6);
const MAX_LOGINS_15  = Number(process.env.RISK_MAX_LOGINS_15  || 10);

// ───────────────────────────────────────────────────────────
// Almacenamiento en memoria de señales (suficiente para empezar)
//   mem[userId] = [{ t, ip, ua }]
// ───────────────────────────────────────────────────────────
const mem = new Map();

function pushLogin(userId, ip, ua) {
  const now = Date.now();
  const arr = mem.get(userId) || [];
  arr.push({ t: now, ip, ua });
  // Conservar solo 24h
  const cutoff = now - 24*60*60*1000;
  const trimmed = arr.filter(e => e.t >= cutoff);
  mem.set(userId, trimmed);
  return trimmed;
}

function evalRisk(events) {
  const now = Date.now();
  const ipSet = new Set(events.map(e => e.ip).filter(Boolean));
  const uaSet = new Set(events.map(e => e.ua).filter(Boolean));
  const last15 = events.filter(e => e.t >= (now - 15*60*1000)).length;

  const reasons = [];
  if (ipSet.size > MAX_IPS_24)     reasons.push(`ips24=${ipSet.size}`);
  if (uaSet.size > MAX_UA_24)      reasons.push(`uas24=${uaSet.size}`);
  if (last15 > MAX_LOGINS_15)      reasons.push(`logins15=${last15}`);

  const level = reasons.length ? 'high' : 'normal';
  return {
    level,
    ip24: ipSet.size,
    ua24: uaSet.size,
    logins15: last15,
    reasons
  };
}

// ───────────────────────────────────────────────────────────
// Middleware HMAC (WP -> Node).
// Firma esperada: HMAC_SHA256(secret, `${userId}.${ts}`)
// Headers: X-Risk-Ts, X-Risk-Sig
// ───────────────────────────────────────────────────────────
function requireRiskHmac(req, res, next) {
  if (!RISK_HMAC_SECRET) {
    return res.status(500).json({ ok:false, error:'server_missing_hmac_secret' });
  }
  const ts  = String(req.header('X-Risk-Ts')  || '');
  const sig = String(req.header('X-Risk-Sig') || '');
  const uid = String((req.body && req.body.userId) || req.query.userId || '');

  if (!ts || !sig || !uid) {
    return res.status(401).json({ ok:false, error:'bad_hmac_params' });
  }

  // Tolerancia ±5 minutos
  const skewOk = Math.abs(Math.floor(Date.now()/1000) - Number(ts)) <= 300;
  if (!skewOk) return res.status(403).json({ ok:false, error:'stale_ts' });

  const calc = crypto.createHmac('sha256', RISK_HMAC_SECRET).update(`${uid}.${ts}`).digest('hex');

  // Evita DoS con timingSafeEqual si longitudes no coinciden
  if (sig.length !== calc.length) {
    if (LAB_DEBUG) console.warn('[RISK HMAC] length mismatch', { got: sig.length, exp: calc.length });
    return res.status(403).json({ ok:false, error:'bad_hmac_len' });
  }

  const ok = crypto.timingSafeEqual(Buffer.from(calc, 'utf8'), Buffer.from(sig, 'utf8'));
  if (!ok) return res.status(403).json({ ok:false, error:'bad_hmac' });

  res.set('X-HMAC-Checked', '1');
  if (LAB_DEBUG) console.log('[RISK HMAC OK]', { uid, ts });
  next();
}

// ───────────────────────────────────────────────────────────
// Helper: POST a WP con HMAC (Node → WP)
// body = { userId, ts, sig, email? }
// ───────────────────────────────────────────────────────────
async function postToWP(url, userId, email) {
  if (!url || !WP_RISK_SECRET) return { ok:false, status:500, data:{ error:'wp_hmac_not_configured' } };
  const ts  = Math.floor(Date.now()/1000);
  const sig = crypto.createHmac('sha256', WP_RISK_SECRET).update(`${userId}.${ts}`).digest('hex');

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify({ userId: Number(userId), ts, sig, email: email || '' })
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { ok: r.ok, status: r.status, data };
}

// ───────────────────────────────────────────────────────────
// POST /risk/login-ok   (WP → Node con HMAC)
// - Registra señal (memoria)
// - Evalúa riesgo con umbrales
// - Si 'high': cierra sesiones en WP y (si está configurado) fuerza reset envío email
// - Notifica al admin con razones
// ───────────────────────────────────────────────────────────
router.post('/login-ok', requireRiskHmac, async (req, res) => {
  try {
    const { userId = '', email = '' } = (req.body || {});
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const ua = String(req.headers['user-agent'] || '').slice(0, 180);

    // Guarda y evalúa
    const events = pushLogin(String(userId), ip, ua);
    const risk   = evalRisk(events);

    if (LAB_DEBUG) console.log('🟢 /risk/login-ok', { userId, ip, risk });

    // Acciones ante riesgo alto
    if (risk.level === 'high') {
      // 1) Cerrar sesiones
      if (WP_RISK_ENDPOINT) {
        try { await postToWP(WP_RISK_ENDPOINT, userId, email); }
        catch (e) { console.warn('close_all error', e?.message || e); }
      }
      // 2) Forzar cambio de contraseña + email reset (si definiste el endpoint en WP)
      if (WP_RISK_REQUIRE_RESET) {
        try { await postToWP(WP_RISK_REQUIRE_RESET, userId, email); }
        catch (e) { console.warn('require_reset error', e?.message || e); }
      }
      // 3) Aviso a admin con razones
      try {
        const reasons = risk.reasons.join(', ');
        await alertAdmin(`🚨 Riesgo ALTO en login · userId=${userId} ${email ? '· ' + email : ''} · ${reasons}`);
      } catch (_) {}
    }

    return res.json({ ok:true, userId, email, risk });
  } catch (e) {
    console.error('❌ /risk/login-ok error:', e?.message || e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

// ───────────────────────────────────────────────────────────
// POST /risk/close-all  (Node → WP)
// Cierra todas las sesiones del usuario indicado (firma HMAC hacia WP).
// ───────────────────────────────────────────────────────────
router.post('/close-all', async (req, res) => {
  try {
    const userId = Number(req.body?.userId || req.query?.userId || 0);
    const email  = String(req.body?.email || '');
    if (!userId) return res.status(400).json({ ok:false, error:'missing_userId' });

    if (!WP_RISK_ENDPOINT || !WP_RISK_SECRET) {
      return res.status(500).json({ ok:false, error:'wp_risk_not_configured' });
    }

    const out = await postToWP(WP_RISK_ENDPOINT, userId, email);
    return res.status(out.status).json({ ok: out.ok, wp: out.data });
  } catch (e) {
    console.error('❌ /risk/close-all error:', e?.message || e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

// Ping
router.get('/ping', (_req, res) => res.json({ ok:true, pong:true }));

module.exports = router;
