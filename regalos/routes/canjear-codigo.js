// 📂 regalos/routes/canjear-codigo.js
'use strict';

const express = require('express');
const crypto  = require('crypto');

const router  = express.Router();
const canjearCodigoRegalo = require('../services/canjear-codigo-regalo');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

/* ═════════════════════════════════════════
 *            CONFIG HMAC
 * ═════════════════════════════════════════ */
const HMAC_REQUIRED = String(process.env.CANJE_HMAC_REQUIRED || 'true').toLowerCase() === 'true';
const API_KEYS = [process.env.ENTRADAS_API_KEY, process.env.REGALOS_API_KEY].filter(Boolean);
const SECRETS  = [process.env.ENTRADAS_HMAC_SECRET, process.env.REGALOS_HMAC_SECRET].filter(Boolean);
const MAX_SKEW_MS = 5 * 60 * 1000; // ±5 min

// Paths que firma WP
const BASE        = '/regalos';
const PATH_CANON  = '/canjear-codigo';
const PATH_ALIAS  = '/canjear-codigo-regalo';
const PATH_LEGACY = '/canjear';

// Rutas relativas para el router (se monta con app.use('/regalos', router))
const ROUTE_CANON = PATH_CANON;
const ROUTE_ALIAS = PATH_ALIAS;

// Boot log mínimo
console.log('[CANJ ROUTER] HMAC_REQUIRED=%s keys=%d secrets=%d', HMAC_REQUIRED, API_KEYS.length, SECRETS.length);

/* ═════════════════════════════════════════
 *                HELPERS
 * ═════════════════════════════════════════ */
function safeEqHex(aHex, bHex) {
  try {
    const A = Buffer.from(String(aHex || ''), 'hex');
    const B = Buffer.from(String(bHex || ''), 'hex');
    return A.length === B.length && crypto.timingSafeEqual(A, B);
  } catch { return false; }
}

/** Verifica HMAC: ts.POST.<path>.sha256(body) */
async function verifyHmac(req, res, next) {
  const apiKey = req.header('x-api-key')  || '';
  const ts     = req.header('x-entr-ts')  || req.header('x-e-ts')  || '';
  const sig    = req.header('x-entr-sig') || req.header('x-e-sig') || '';
  const headerVariant = req.header('x-entr-sig') ? 'x-entr-*' : (req.header('x-e-sig') ? 'x-e-*' : 'none');

  if (!HMAC_REQUIRED && (!apiKey || !ts || !sig)) return next();
  if (!apiKey || !ts || !sig) return res.status(401).json({ ok:false, error:'unauthorized' });
  if (!API_KEYS.length || !SECRETS.length) {
    try {
      await alertAdmin({
        area: 'regalos.canjear.hmac_config_missing',
        err: new Error('HMAC config missing'),
        meta: { apiKeys: API_KEYS.length, secrets: SECRETS.length }
      });
    } catch (_) {}
    return res.status(500).json({ ok:false, error:'HMAC config missing' });
  }
  if (!API_KEYS.includes(apiKey)) return res.status(401).json({ ok:false, error:'unauthorized' });

  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return res.status(400).json({ ok:false, error:'bad timestamp' });
  if (Math.abs(Date.now() - tsNum) > MAX_SKEW_MS) return res.status(401).json({ ok:false, error:'expired' });

  const rawBody   = req.rawBody?.toString('utf8') || JSON.stringify(req.body || {});
  const bodyHash  = crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex');
  const bodyHash10= bodyHash.slice(0,10);

  const candidates = [
    BASE + PATH_CANON,
    BASE + PATH_ALIAS,
    BASE + PATH_LEGACY
  ];

  // Log base (auditable)
  console.log('[CANJ HMAC BASE]', {
    ts: String(ts),
    path: req.path || '',
    bodyHash10_raw: bodyHash10,
    base10_raw: String(ts).slice(0,10),
    sig10: String(sig).slice(0,10)
  });

  let ok = false;
  let matched = '';
  let matchedPath = '';
  for (const p of candidates) {
    const base = `${ts}.POST.${p}.${bodyHash}`;
    for (const secret of SECRETS) {
      const exp = crypto.createHmac('sha256', secret).update(base, 'utf8').digest('hex');
      if (safeEqHex(exp, sig)) {
        ok = true;
        matched = 'raw';
        matchedPath = p;
        break;
      }
    }
    if (ok) break;
  }
if (!ok) {
    const meta = { ts: String(ts), headerVariant, pathTried: candidates, email: req.body?.email || null, codigo: req.body?.codigo || req.body?.codigo_regalo || null };
    console.warn('[CANJ HMAC DENY]', meta);
    try {
      await alertAdmin({
        area: 'regalos.canjear.hmac_deny',
        err: new Error('HMAC verification failed'),
        meta
      });
    } catch (_) {}
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }
  // Log éxito (compacto)
  console.log('[CANJ HMAC OK]', {
    ts: String(ts),
    sig10: String(sig).slice(0,10),
    matched,
    headerVariant,
    path: matchedPath
  });
  return next();
}

/* ═════════════════════════════════════════
 *           MAPEO DE ERRORES → UX
 * ═════════════════════════════════════════ */
function mapError(errMsg = '') {
  const msg = String(errMsg || '').toLowerCase();

  if (msg.includes('ya ha sido utilizado')) return { status: 409, error: 'Código ya usado anteriormente.' };
  if (msg.includes('no se reconoce el libro')) return { status: 400, error: 'Libro seleccionado no reconocido.' };
  if (msg.includes('no corresponde con tu email')) return { status: 403, error: 'Este código no corresponde con tu email.' };

  if (msg.includes('no está validada') || msg.includes('no esta validada')) {
    return { status: 400, error: 'Esta entrada no está validada y no puede canjearse.' };
  }

  if (msg.includes('no es válido') || msg.includes('requested entity was not found') || msg.includes('prefijo desconocido')) {
    return { status: 400, error: 'Código inválido.' };
  }

  if (msg.includes('faltan datos')) {
    return { status: 422, error: 'Faltan datos: nombre, email, libro y código.' };
  }

  return { status: 500, error: 'Error interno. Inténtalo de nuevo.' };
}

/* ═════════════════════════════════════════
 *                HANDLER
 * ═════════════════════════════════════════ */
async function handleCanje(req, res) {
  try {
    const b = req.body || {};

    // Normalización de entrada
    const nombre        = String(b.nombre || '').trim();
    const apellidos     = String(b.apellidos || '').trim();
    const email         = String(b.email || '').trim().toLowerCase();
    const libroElegido  = String(b.libro_elegido || b.libro || b.elige_un_libro || '').trim();
    const codigo        = String(b.codigo_regalo || b.codigo || b.codigoRegalo || '').trim().toUpperCase();
    const membershipId  = b.membershipId ? String(b.membershipId).trim() : '';

    if (!nombre || !email || !libroElegido || !codigo) {
      return res.status(422).json({ ok:false, error:'Faltan datos: nombre, email, libro y código.' });
    }
    if (!/^(REG-|PRE-)/.test(codigo) || codigo.length < 7 || codigo.length > 64) {
      return res.status(400).json({ ok:false, error:'Código inválido.' });
    }

    // Llamada al servicio (el propio servicio refuerza idempotencia)
    const resp = await canjearCodigoRegalo({
      nombre,
      apellidos,
      email,
      libro_elegido: libroElegido,
      codigo_regalo: codigo,
      ...(membershipId ? { membershipId } : {})
    });

    // Si el servicio devuelve estructura de error
    if (!resp || resp.ok === false) {
      const errMsg = (resp && (resp.error || resp.motivo || resp.message)) || 'no es válido';
      const { status, error } = mapError(errMsg);
      return res.status(status).json({ ok:false, error });
    }

    // Éxito → enviar message + mensaje para máxima compatibilidad
    return res.status(200).json({
      ok: true,
      message: 'Libro activado correctamente',
      mensaje: 'Libro activado correctamente',
      resultado: resp
    });
  } catch (err) {
    const { status, error } = mapError(err?.message || err);
    try {
      await alertAdmin({
        area: 'regalos.canjear.exception',
        err,
        meta: {
          email: req.body?.email || null,
          codigo: req.body?.codigo || req.body?.codigo_regalo || null,
          libro: req.body?.libro_elegido || req.body?.libro || null
        }
      });
    } catch (_) {}
    return res.status(status).json({ ok:false, error });
  }
}

/* ═════════════════════════════════════════
 *                RUTAS (relativas)
 * ═════════════════════════════════════════ */
// Estas rutas se montan con app.use('/regalos', router)
router.post(ROUTE_CANON, verifyHmac, handleCanje);   // POST /regalos/canjear-codigo
router.post(ROUTE_ALIAS, verifyHmac, handleCanje);   // POST /regalos/canjear-codigo-regalo
router.post(PATH_LEGACY, verifyHmac, handleCanje);   // POST /regalos/canjear (compat)

module.exports = router;
