/**
 * Archivo: routes/risk-events.js
 * Rutas:
 *   POST /risk/login-ok   ← WP informa "login correcto" (requiere HMAC)
 *   POST /risk/close-all  ← Node ordena a WP cerrar sesiones (firma HMAC hacia WP)
 *   GET  /risk/ping       ← prueba rápida (sin HMAC)
 *
 * ENV necesarias:
 *   RISK_HMAC_SECRET
 *   WP_RISK_ENDPOINT, WP_RISK_SECRET
 *   WP_RISK_REQUIRE_RESET (opcional, para forzar cambio de contraseña)
 *   RISK_AUTO_ENFORCE=1   (aplica acciones automáticamente si risk.level === 'high')
 *   RISK_IPS_24H=8, RISK_UAS_24H=6, RISK_LOGINS_15M=10, RISK_GEO_KMH_MAX=500
 */

'use strict';

const express = require('express');
const crypto  = require('crypto');
const { recordLogin } = require('../utils/riskDecider');
const { closeAllSessions, requirePasswordReset } = require('../utils/riskActions');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const router = express.Router();

const LAB_DEBUG        = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');
const RISK_HMAC_SECRET = String(process.env.RISK_HMAC_SECRET || '').trim();
const RISK_AUTO_ENFORCE= (process.env.RISK_AUTO_ENFORCE === '1');

// Requiere JSON "de verdad"
function requireJson(req, res, next) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    return res.status(415).json({ ok:false, error:'UNSUPPORTED_MEDIA_TYPE' });
  }
  next();
}

// ───────────────────────────────────────────────────────────
// Middleware HMAC (WP → Node)
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

  // tolerancia ±5 min
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

// ───────────────────────────────────────────────────────────
// POST /risk/login-ok
// Registra señal, evalúa riesgo y (si procede) ejecuta acciones.
// ───────────────────────────────────────────────────────────
router.post('/risk/login-ok', requireJson, requireRiskHmac, async (req, res) => {
  try {
    const { userId = '', email = '', geo = null } = (req.body || {});

    // IP y UA
    const ipHdr = (req.headers['x-forwarded-for'] || req.ip || '').toString();
    const ip = ipHdr.split(',')[0].trim();
    const ua = String(req.headers['user-agent'] || '').slice(0,180);

    // Geo opcional (preferir body.geo; si no, cabeceras de CDN si existen)
    const lat = geo && Number.isFinite(geo.lat) ? Number(geo.lat)
               : (Number.isFinite(Number(req.headers['x-geo-lat'])) ? Number(req.headers['x-geo-lat']) : undefined);
    const lon = geo && Number.isFinite(geo.lon) ? Number(geo.lon)
               : (Number.isFinite(Number(req.headers['x-geo-lon'])) ? Number(req.headers['x-geo-lon']) : undefined);
    const country = (geo && geo.country) ? String(geo.country)
                    : (req.headers['cf-ipcountry'] || req.headers['x-geo-country'] || '');

    // Registrar y decidir
    const risk = recordLogin(String(userId), { ip, ua, lat, lon, country });

    // Acciones automáticas si umbral superado
    if (risk.level === 'high' && RISK_AUTO_ENFORCE) {
      try { await closeAllSessions(userId, email); } catch (e) { console.warn('closeAll error:', e?.message || e); }
      try { await requirePasswordReset(userId, email); } catch (e) { console.warn('requireReset error:', e?.message || e); }

      // Aviso al admin con detalles
      try {
        const msg = [
          '🚨 Riesgo ALTO',
          `userId=${userId}${email ? ` · ${email}` : ''}`,
          `reasons=[${risk.reasons.join(', ')}]`,
          `metrics=${JSON.stringify(risk.metrics)}`,
          `ips=${risk.samples.ips.map(x=>`${x.ip}(${x.n})`).join(', ')}`,
          `uas=${risk.samples.uas.map(x=>`${x.ua.substring(0,40)}…(${x.n})`).join(', ')}`
        ].join(' · ');
        await alertAdmin({ area: 'risk_high', email: email || '-', err: new Error('risk_high'), meta: { userId, risk } });
        if (LAB_DEBUG) console.log('[ALERT SENT] ', msg);
      } catch (_) {}
    }

    return res.json({ ok:true, userId, email, risk });
  } catch (e) {
    console.error('❌ /risk/login-ok error:', e?.message || e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

// ───────────────────────────────────────────────────────────
// POST /risk/close-all (manual o para pruebas)
// ───────────────────────────────────────────────────────────
router.post('/risk/close-all', requireJson, async (req, res) => {
  try {
    const userId = Number(req.body?.userId || req.query?.userId || 0);
    const email  = String(req.body?.email || '');
    if (!userId) return res.status(400).json({ ok:false, error:'missing_userId' });

    const out = await closeAllSessions(userId, email);
    return res.status(out.status).json({ ok: out.ok, wp: out.data });
  } catch (e) {
    console.error('❌ /risk/close-all error:', e?.message || e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

// Ping
router.get('/risk/ping', (_req, res) => res.json({ ok:true, pong:true }));

module.exports = router;
