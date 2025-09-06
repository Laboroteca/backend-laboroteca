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

const LAB_DEBUG         = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');
const RISK_HMAC_SECRET  = String(process.env.RISK_HMAC_SECRET || '').trim();
const RISK_AUTO_ENFORCE = (process.env.RISK_AUTO_ENFORCE === '1');

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

/**
 * Enforce robusto en WP (cierre + reset) con reintentos y backoff.
 * Considera éxito solo con 2xx; 423/401/etc. se reintentan hasta agotar.
 */
async function enforceRiskActions({ userId, email }) {
  const maxRetries = 3;
  const baseDelayMs = 400;

  async function retry(fn, label) {
    let last = { ok:false, status:0, data:{ error:'no_call' } };
    for (let i = 0; i <= maxRetries; i++) {
      last = await fn();
      const ok2xx = last && last.ok === true;        // utils/riskActions devuelve ok = r.ok (2xx)
      if (ok2xx) return { ok:true, status:last.status, data:last.data, tries:i+1 };
      const delay = Math.floor(Math.pow(2, i) * baseDelayMs);
      if (LAB_DEBUG) console.warn(`[risk enforce] ${label} intento ${i+1} falló status=${last?.status}. Reintentando en ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
    return { ok:false, status:last?.status || 0, data:last?.data, tries:maxRetries+1 };
  }

  const closeRes = await retry(() => closeAllSessions(userId, email), 'closeAllSessions');
  const resetRes = await retry(() => requirePasswordReset(userId, email), 'requirePasswordReset');

  // log claro
  const summary = {
    closeAll: { ok: closeRes.ok, status: closeRes.status, tries: closeRes.tries, error: closeRes.data?.error || null },
    requireReset: { ok: resetRes.ok, status: resetRes.status, tries: resetRes.tries, error: resetRes.data?.error || null }
  };
  if (summary.closeAll.ok && summary.requireReset.ok) {
    console.log('[risk enforce] ✅ cierre+reset aplicados', summary);
  } else {
    console.warn('[risk enforce] ⚠️ acciones incompletas', summary);
  }
  return summary;
}

/** Email al admin en español (asunto claro + métricas) */
async function notifyAdminES({ userId, email, risk }) {
  const entorno = process.env.NODE_ENV || 'unknown';
  const subject = `🚨 Riesgo ALTO: posible compartición de credenciales · userId=${userId}`;

  const textoPlano =
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
- Cierre de sesiones: sí
- Forzar cambio de contraseña: sí

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
  <li>Cerrar todas las sesiones en WP: <strong>sí</strong></li>
  <li>Forzar cambio de contraseña: <strong>sí</strong></li>
</ul>
<p style="color:#888">Entorno: ${entorno}</p>`;

  // Pasa subject/text/html a tu proxy (ajústalo si antes ignoraba estos campos).
  await alertAdmin({
    area: 'risk_high',
    email: email || '-',
    subject,
    text: textoPlano,
    html,
    err: new Error('risk_high'),
    meta: { userId, risk, entorno }
  });

  if (LAB_DEBUG) console.log('[ALERT SENT ES]', subject);
}

/* ──────────────────────────────────────────────────────────
 * POST /risk/login-ok
 * Registra señal, evalúa riesgo y (si procede) ejecuta acciones.
 * ──────────────────────────────────────────────────────── */
router.post('/risk/login-ok', requireJson, requireRiskHmac, async (req, res) => {
  try {
    const { userId = '', email = '', geo = null } = (req.body || {});

    // IP y UA
    const ipHdr = (req.headers['x-forwarded-for'] || req.ip || '').toString();
    const ip = ipHdr.split(',')[0].trim();
    const ua = String(req.headers['user-agent'] || '').slice(0,180);

    // Geo opcional (preferir body.geo; si no, cabeceras CDN si existen)
    const lat = geo && Number.isFinite(geo.lat) ? Number(geo.lat)
               : (Number.isFinite(Number(req.headers['x-geo-lat'])) ? Number(req.headers['x-geo-lat']) : undefined);
    const lon = geo && Number.isFinite(geo.lon) ? Number(geo.lon)
               : (Number.isFinite(Number(req.headers['x-geo-lon'])) ? Number(req.headers['x-geo-lon']) : undefined);
    const country = (geo && geo.country) ? String(geo.country)
                    : (req.headers['cf-ipcountry'] || req.headers['x-geo-country'] || '');

    // Registrar y decidir
    const risk = recordLogin(String(userId), { ip, ua, lat, lon, country });

    let enforceSummary = null;

    // Acciones automáticas si umbral superado
    if (risk.level === 'high' && RISK_AUTO_ENFORCE) {
      enforceSummary = await enforceRiskActions({ userId, email }).catch(e => {
        console.warn('[risk enforce] error', e?.message || e);
        return null;
      });

      // Aviso al admin en ES (con métricas y acciones)
      try { await notifyAdminES({ userId, email, risk }); } catch (_) {}
    }

    return res.json({ ok:true, userId, email, risk, enforce: enforceSummary });
  } catch (e) {
    console.error('❌ /risk/login-ok error:', e?.message || e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

/* ──────────────────────────────────────────────────────────
 * POST /risk/close-all (manual o para pruebas)
 * ──────────────────────────────────────────────────────── */
router.post('/risk/close-all', requireJson, async (req, res) => {
  try {
    const userId = Number(req.body?.userId || req.query?.userId || 0);
    const email  = String(req.body?.email || '');
    if (!userId) return res.status(400).json({ ok:false, error:'missing_userId' });

    // Forzamos cierre con los mismos reintentos que en auto-enforce
    const summary = await (async () => {
      const s = await enforceRiskActions({ userId, email });
      return s;
    })();

    // Si realmente quieres solo el “close” aquí y no reset, puedes llamar a closeAllSessions directamente.
    const ok = !!(summary && summary.closeAll && summary.closeAll.ok);
    const status = ok ? 200 : 502;
    return res.status(status).json({ ok, enforce: summary });
  } catch (e) {
    console.error('❌ /risk/close-all error:', e?.message || e);
    return res.status(500).json({ ok:false, error:'internal' });
  }
});

/* Ping */
router.get('/risk/ping', (_req, res) => res.json({ ok:true, pong:true }));

module.exports = router;
