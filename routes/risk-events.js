/**
 * File: routes/risk-events.js
 * Purpose: Endpoints de señales de riesgo (WP ↔ Node)
 *
 * Routes:
 *   POST /risk/login-ok   — Evento de login correcto (requiere HMAC WP→Node)
 *   POST /risk/download   — Evento de descarga (requiere HMAC WP→Node)
 *   GET  /risk/status     — Diagnóstico de riesgo actual (solo lectura; sin HMAC)
 *
 * Env esperadas:
 *   RISK_HMAC_SECRET   → secreto compartido para HMAC (debe = LAB_RISK_HMAC_SECRET en WP)
 *   LAB_DEBUG          → si '1', imprime logs detallados
 */

const express = require('express');
const router = express.Router();

const crypto = require('crypto');
const LAB_DEBUG = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');
const SKEW_SECS = Number(process.env.RISK_TS_SKEW_SECS || 300); // 5 min por defecto

// Utilidades de negocio (debes tener estos helpers)
const {
  recordLoginOK,
  recordDownload,
  computeAndEnforce
} = require('../utils/riskSignals');

// ───────────────────────── helpers ─────────────────────────
function ipFrom(req) {
  return String(req.headers['x-forwarded-for'] || req.ip || '')
    .toString()
    .split(',')[0]
    .trim();
}

function safeTSE(a, b) {
  const ba = Buffer.from(String(a) || '', 'utf8');
  const bb = Buffer.from(String(b) || '', 'utf8');
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

// ───────────── middleware HMAC (WP -> Node) ─────────────
function requireRiskHmac(req, res, next) {
  const secret = process.env.RISK_HMAC_SECRET || '';
  if (!secret) {
    if (LAB_DEBUG) console.warn('[RISK HMAC] ❌ FALTA RISK_HMAC_SECRET en servidor');
    return res.status(500).json({ ok: false, error: 'server_missing_hmac_secret' });
  }

  const ts  = String(req.header('X-Risk-Ts') || '');
  const sig = String(req.header('X-Risk-Sig') || '');
  const uid = String((req.body && req.body.userId) || req.query.userId || '');
  const ua  = String(req.headers['user-agent'] || '').slice(0, 120);
  const ip  = ipFrom(req);

  if (LAB_DEBUG) {
    console.log('[RISK HMAC IN]', {
      path: req.path, uid, ts, ip, ua, sig10: sig.slice(0, 10)
    });
  }

  if (!ts || !sig || !uid) {
    if (LAB_DEBUG) console.warn('[RISK HMAC] ❌ Parámetros faltantes', { hasTs: !!ts, hasSig: !!sig, hasUid: !!uid });
    return res.status(401).json({ ok: false, error: 'bad_hmac_params' });
  }

  const calc = crypto.createHmac('sha256', secret).update(uid + '.' + ts).digest('hex');

  if (!safeTSE(calc, sig)) {
    if (LAB_DEBUG) console.warn('[RISK HMAC] ❌ Mismatch', { expect10: calc.slice(0, 10), got10: sig.slice(0, 10) });
    return res.status(403).json({ ok: false, error: 'bad_hmac' });
  }

  const skew = Math.abs((Date.now() / 1000) - Number(ts));
  if (skew > SKEW_SECS) {
    if (LAB_DEBUG) console.warn('[RISK HMAC] ❌ stale_ts', { skew_sec: Math.round(skew), limit: SKEW_SECS });
    return res.status(403).json({ ok: false, error: 'stale_ts' });
  }

  // Marca visible para depurar desde cliente (recuerda exponerla en CORS: exposedHeaders)
  res.setHeader('X-HMAC-Checked', '1');
  if (LAB_DEBUG) console.log('[RISK HMAC] ✅ OK', { path: req.path, uid });

  next();
}

// ───────────────────────── routes ─────────────────────────

// Evento de login correcto (WP → Node, con HMAC)
router.post('/risk/login-ok', requireRiskHmac, async (req, res) => {
  try {
    const { userId, email, ua, geo } = req.body || {};
    const payload = {
      userId: String(userId || ''),
      email: (email || '').toLowerCase(),
      ip: ipFrom(req),
      ua: ua || req.headers['user-agent'] || '',
      geo: geo || {}
    };

    const r = await recordLoginOK(payload);
    // Compute & enforce puede cerrar sesiones si toca (opcionalmente lo llamas aquí o via cron)
    try { await computeAndEnforce({ userId: payload.userId }); } catch (e) { if (LAB_DEBUG) console.warn('[risk] computeAndEnforce warn:', e?.message || e); }

    return res.json({ ok: true, ...r });
  } catch (e) {
    if (LAB_DEBUG) console.error('[/risk/login-ok] error:', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'internal_error' });
  }
});

// Evento de descarga (WP → Node, con HMAC)
router.post('/risk/download', requireRiskHmac, async (req, res) => {
  try {
    const { userId, email, ua } = req.body || {};
    const payload = {
      userId: String(userId || ''),
      email: (email || '').toLowerCase(),
      ip: ipFrom(req),
      ua: ua || req.headers['user-agent'] || ''
    };

    const r = await recordDownload(payload);
    // Puedes evaluar riesgo aquí también si quieres respuesta inmediata
    try { await computeAndEnforce({ userId: payload.userId }); } catch (e) { if (LAB_DEBUG) console.warn('[risk] computeAndEnforce warn:', e?.message || e); }

    return res.json({ ok: true, ...r });
  } catch (e) {
    if (LAB_DEBUG) console.error('[/risk/download] error:', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'internal_error' });
  }
});

// Diagnóstico de riesgo (solo lectura; útil para soporte / pruebas)
router.get('/risk/status', async (req, res) => {
  try {
    const userId = String(req.query.userId || '').trim();
    if (!userId) return res.status(400).json({ ok: false, error: 'userId_required' });

    const r = await computeAndEnforce({ userId, dryRun: true }); // no aplicar medidas, solo calcular
    // Para que el cliente pueda distinguir que no hubo HMAC en esta ruta:
    res.setHeader('X-HMAC-Checked', '0');
    return res.json({ ok: true, ...r });
  } catch (e) {
    if (LAB_DEBUG) console.error('[/risk/status] error:', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'internal_error' });
  }
});

module.exports = router;
