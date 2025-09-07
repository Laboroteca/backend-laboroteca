/** 
 * routes/risk-events.js
 * Endpoints:
 *   POST /login-ok  ← WP informa "login correcto" (HMAC)
 *   GET  /ping      ← prueba rápida
 *
 * Reglas:
 *   - AVISA (emails) si risk.level es 'high' o 'critical' (por cualquier motivo: IPs/UAs/logins).
 *   - NO cierra sesiones ni exige cambio de contraseña.
 */
'use strict';

const express = require('express');
const crypto  = require('crypto');
const { recordLogin } = require('../utils/riskDecider');
const { sendUserNotice, sendAdminAlert } = require('../utils/riskActions');

const router = express.Router();

const LAB_DEBUG        = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');
const RISK_HMAC_SECRET = String(process.env.RISK_HMAC_SECRET || '').trim();

/* ──────────────────────────────────────────────────────────
 * Utils
 * ──────────────────────────────────────────────────────── */
function logDebug(...args){ if (LAB_DEBUG) console.log(...args); }

function requireJson(req, res, next) {
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  // Permite application/json y variantes con charset
  if (!ct.startsWith('application/json')) {
    return res.status(415).json({ ok:false, error:'UNSUPPORTED_MEDIA_TYPE' });
  }
  next();
}

/** HMAC WP → Node: HMAC_SHA256(secret, `${userId}.${ts}`)  */
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
  // timingSafeEqual exige mismo length
  if (sig.length !== calc.length) {
    if (LAB_DEBUG) console.warn('[RISK HMAC] len mismatch');
    return res.status(403).json({ ok:false, error:'bad_hmac_len' });
  }
  const ok = crypto.timingSafeEqual(Buffer.from(calc, 'utf8'), Buffer.from(sig, 'utf8'));
  if (!ok) return res.status(403).json({ ok:false, error:'bad_hmac' });

  res.set('X-HMAC-Checked', '1');
  logDebug('[RISK HMAC OK]', { uid, ts });
  next();
}

/** IP cliente robusta (CF / X-Real-IP / X-Forwarded-For / req.ip) */
function extractClientIp(req) {
  const h = req.headers || {};
  const cf = (h['cf-connecting-ip'] || '').toString().trim();
  const xr = (h['x-real-ip'] || '').toString().trim();
  const xf = (h['x-forwarded-for'] || '').toString().trim();
  if (cf) return cf;
  if (xr) return xr;
  if (xf) {
    // si tu proxy deja el cliente al principio, coge [0]
    const parts = xf.split(',').map(s => s.trim()).filter(Boolean);
    return parts.length ? parts[0] : (req.ip || '');
  }
  return (req.ip || '').toString();
}

/** Pequeño hash seguro de un valor para idempotencia/trazas (no reversible) */
function shortHash(s) {
  if (!s) return '0';
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0,12);
}

/* ──────────────────────────────────────────────────────────
 * POST /login-ok
 * ──────────────────────────────────────────────────────── */
router.post('/login-ok', requireJson, requireRiskHmac, async (req, res) => {
  try {
    const { userId = '', email = '', geo = null } = (req.body || {});
    const uid = String(userId || '').trim();

    // IP & UA
    const ip = extractClientIp(req);
    const ua = String(req.headers['user-agent'] || '').slice(0,180);

    // Geo opcional (cabeceras o body.geo)
    const lat = (geo && Number.isFinite(geo.lat)) ? Number(geo.lat)
              : (Number.isFinite(Number(req.headers['x-geo-lat'])) ? Number(req.headers['x-geo-lat']) : undefined);
    const lon = (geo && Number.isFinite(geo.lon)) ? Number(geo.lon)
              : (Number.isFinite(Number(req.headers['x-geo-lon'])) ? Number(req.headers['x-geo-lon']) : undefined);
    const country = (geo && geo.country)
      ? String(geo.country)
      : String(req.headers['cf-ipcountry'] || req.headers['x-geo-country'] || '');

    // Evaluación de riesgo
    const risk = recordLogin(uid, { ip, ua, lat, lon, country });

    // ─── Disparo de avisos: en cualquier HIGH o CRITICAL, por cualquier motivo ───
    const isTriggered = risk.level === 'high' || risk.level === 'critical';
    if (isTriggered) {
      // Idempotencia: nivel + razones + hora + hash(IP actual)
      const hourKey    = new Date().toISOString().slice(0,13); // YYYY-MM-DDTHH
      const reasonsKey = (Array.isArray(risk?.reasons) && risk.reasons.length)
        ? risk.reasons.join('|')
        : 'no_reasons';
      const idemRaw = `${uid}:${risk.level}:${reasonsKey}:${hourKey}:${shortHash(ip)}`;
      const idemKey = 'risk:' + crypto.createHash('sha256').update(idemRaw).digest('hex').slice(0,16);

      // Enviar avisos (usuario + admin). No relanzamos si fallan; registramos en debug.
      const [adminRes, userRes] = await Promise.allSettled([
        sendAdminAlert(uid, email, risk, { idemKey }),
        sendUserNotice(email, { idemKey })
      ]);

      if (LAB_DEBUG) {
        const fmt = (r) => (r.status === 'fulfilled'
          ? r.value
          : { ok:false, status:500, data:{ error: String(r.reason?.message || r.reason || 'send_error') } });
        console.log('[riskMail] results', {
          uid,
          level: risk.level,
          reasons: risk.reasons,
          idemKey,
          admin: fmt(adminRes),
          user : fmt(userRes)
        });
      }
    } else {
      logDebug('[riskMail] not-triggered', { uid, level: risk.level, reasons: risk.reasons });
    }

    return res.json({ ok:true, userId: uid, email, risk });
  } catch (e) {
    console.error('❌ /login-ok error:', e?.message || e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

/* Ping */
router.get('/ping', (_req, res) => res.json({ ok:true, pong:true }));

module.exports = router;
