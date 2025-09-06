/**
 * Archivo: risk/risk-events.js
 * Rutas:
 *   POST /risk/login-ok    ← WP informa "login correcto" (requiere HMAC)
 *   POST /risk/close-all   ← Node ordena a WP cerrar todas las sesiones (requiere HMAC interna hacia WP)
 *   GET  /risk/ping        ← prueba rápida (sin HMAC)
 */

const express = require('express');
const crypto  = require('crypto');
const fetch   = require('node-fetch');

const router = express.Router();

// ───────────────────────────────────────────────────────────
// Middleware HMAC (WP -> Node). Evita 500 y da errores claros.
// Firma esperada: HMAC_SHA256( secret, `${userId}.${ts}` )
// Headers: X-Risk-Ts, X-Risk-Sig
// ───────────────────────────────────────────────────────────
function requireRiskHmac(req, res, next) {
  const debug  = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');
  const secret = process.env.RISK_HMAC_SECRET || '';

  if (!secret) return res.status(500).json({ ok:false, error:'server_missing_hmac_secret' });

  const ts   = String(req.header('X-Risk-Ts')  || '');
  const sig  = String(req.header('X-Risk-Sig') || '');
  const uid  = String((req.body && req.body.userId) || req.query.userId || '');

  if (!ts || !sig || !uid) return res.status(401).json({ ok:false, error:'bad_hmac_params' });

  // Tolerancia de reloj ±5 min
  const skewOk = Math.abs(Math.floor(Date.now()/1000) - Number(ts)) <= 300;
  if (!skewOk) return res.status(403).json({ ok:false, error:'stale_ts' });

  // Calcula la firma y comprueba longitud antes de timingSafeEqual
  const calc = crypto.createHmac('sha256', secret).update(`${uid}.${ts}`).digest('hex');
  if (sig.length !== calc.length) {
    if (debug) console.warn('[RISK HMAC] length mismatch', { got: sig.length, exp: calc.length });
    return res.status(403).json({ ok:false, error:'bad_hmac_len' });
  }

  const ok = crypto.timingSafeEqual(Buffer.from(calc, 'utf8'), Buffer.from(sig, 'utf8'));
  if (!ok) return res.status(403).json({ ok:false, error:'bad_hmac' });

  // marca para CORS/debug
  res.set('X-HMAC-Checked', '1');
  if (debug) console.log('[RISK HMAC OK]', { uid, ts });

  next();
}

// ───────────────────────────────────────────────────────────
// POST /risk/login-ok
// Guarda/actualiza señales y, si procede, dispara cierre remoto.
// Aquí solo devolvemos ok: true para tu prueba; integra tu lógica.
// ───────────────────────────────────────────────────────────
router.post('/login-ok', requireRiskHmac, async (req, res) => {
  try {
    const { userId, email } = req.body || {};
    const debug = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');

    if (debug) console.log('🟢 /risk/login-ok', { userId, email });

    // TODO: aquí tu lógica de señales/riesgo…
    // await saveRiskSignal(userId, req);

    return res.json({ ok: true, userId, email });
  } catch (e) {
    console.error('❌ /risk/login-ok error:', e?.message || e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

// ───────────────────────────────────────────────────────────
// POST /risk/close-all  (Node → WP)
// Requiere: WP_RISK_ENDPOINT y WP_RISK_SECRET en el entorno de Node
// ───────────────────────────────────────────────────────────
router.post('/close-all', async (req, res) => {
  try {
    const userId = Number(req.body?.userId || req.query?.userId || 0);
    if (!userId) return res.status(400).json({ ok:false, error:'missing_userId' });

    const endpoint = String(process.env.WP_RISK_ENDPOINT || '').trim();
    const secret   = String(process.env.WP_RISK_SECRET   || '').trim();
    if (!endpoint || !secret) return res.status(500).json({ ok:false, error:'wp_risk_not_configured' });

    const ts  = Math.floor(Date.now()/1000);
    const sig = crypto.createHmac('sha256', secret).update(`${userId}.${ts}`).digest('hex');

    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type':'application/json' },
      body: JSON.stringify({ userId, ts, sig })
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { _raw:text }; }

    return res.status(r.status).json({ ok: r.ok, wp: data });
  } catch (e) {
    console.error('❌ /risk/close-all error:', e?.message || e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

// Ping
router.get('/ping', (_req, res) => res.json({ ok:true, pong:true }));

module.exports = router;
