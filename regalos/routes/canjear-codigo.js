// 📂 regalos/routes/canjear-codigo.js
'use strict';

const express = require('express');
const crypto  = require('crypto');

const router  = express.Router();
const canjearCodigoRegalo = require('../services/canjear-codigo-regalo');

/* ============================================================
 *                      CONFIG HMAC
 * ============================================================ */
// Exigir firma HMAC (recomendado: true en producción)
const HMAC_REQUIRED = String(process.env.CANJE_HMAC_REQUIRED || 'true').toLowerCase() === 'true';

// Acepta claves de ENTRADAS o REGALOS (las mismas que usa WP)
const API_KEYS = [process.env.ENTRADAS_API_KEY, process.env.REGALOS_API_KEY].filter(Boolean);
const SECRETS  = [process.env.ENTRADAS_HMAC_SECRET, process.env.REGALOS_HMAC_SECRET].filter(Boolean);

// Ventana anti-replay
const MAX_SKEW_MS = 5 * 60 * 1000; // ±5 min

// ❗️IMPORTANTE: estas son las RUTAS *REALS* que firma WP
const BASE        = '/regalos';
const PATH_CANON  = '/canjear-codigo';
const PATH_ALIAS  = '/canjear-codigo-regalo';
const PATH_LEGACY = '/canjear'; // por si algún fallback viejo sigue vivo

// En el router SIEMPRE registramos rutas *relativas* (sin `/regalos`)
const ROUTE_CANON  = PATH_CANON;  // '/canjear-codigo'
const ROUTE_ALIAS  = PATH_ALIAS;  // '/canjear-codigo-regalo'

/* ============================================================
 *                      HELPERS
 * ============================================================ */
function safeEqHex(aHex, bHex) {
  const A = Buffer.from(String(aHex || ''), 'hex');
  const B = Buffer.from(String(bHex || ''), 'hex');
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/** Verifica HMAC: ts.POST.<path>.sha256(body) */
function verifyHmac(req, res, next) {
  const apiKey = req.header('x-api-key') || '';
  const ts     = req.header('x-entr-ts') || req.header('x-e-ts') || '';
  const sig    = req.header('x-entr-sig') || req.header('x-e-sig') || '';

  if (!HMAC_REQUIRED && (!apiKey || !ts || !sig)) return next();

  if (!apiKey || !ts || !sig) return res.status(401).json({ ok:false, error:'unauthorized' });
  if (!API_KEYS.length || !SECRETS.length) return res.status(500).json({ ok:false, error:'HMAC config missing' });
  if (!API_KEYS.includes(apiKey)) return res.status(401).json({ ok:false, error:'unauthorized' });

  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return res.status(400).json({ ok:false, error:'bad timestamp' });
  if (Math.abs(Date.now() - tsNum) > MAX_SKEW_MS) return res.status(401).json({ ok:false, error:'expired' });

  // ¡El hash debe ser del RAW recibido!
  const rawBody  = req.rawBody?.toString('utf8') || JSON.stringify(req.body || {});
  const bodyHash = crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex');

  // Candidatos válidos de path (lo que firmó WP)
  const candidates = [
    BASE + PATH_CANON,   // /regalos/canjear-codigo
    BASE + PATH_ALIAS,   // /regalos/canjear-codigo-regalo
    BASE + PATH_LEGACY   // /regalos/canjear (por si el mu-plugin hace fallback)
  ];

  let ok = false;
  for (const p of candidates) {
    const base = `${ts}.POST.${p}.${bodyHash}`;
    for (const secret of SECRETS) {
      const exp = crypto.createHmac('sha256', secret).update(base, 'utf8').digest('hex');
      if (safeEqHex(exp, sig)) { ok = true; break; }
    }
    if (ok) break;
  }

  if (!ok) {
    console.warn('⛔ HMAC mismatch', { url: req.originalUrl, candidates });
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }

  return next();
}

/* ============================================================
 *            MAPEO DE ERRORES (tus textos originales)
 * ============================================================ */
function mapError(errMsg = '') {
  const msg = String(errMsg || '').toLowerCase();

  if (msg.includes('ya ha sido utilizado')) return { status: 409, error: 'Código ya usado anteriormente.' };
  if (msg.includes('no se reconoce el libro')) return { status: 400, error: 'Libro seleccionado no reconocido.' };
  if (msg.includes('no corresponde con tu email')) return { status: 403, error: 'Este código no corresponde con tu email.' };

  if (msg.includes('entrada no está validada')) return { status: 400, error: 'Esta entrada no está validada y no puede canjearse.' };
  if (msg.includes('entrada validada no corresponde')) return { status: 403, error: 'Esta entrada validada no corresponde con tu email.' };

  if (msg.includes('no es válido') || msg.includes('requested entity was not found') || msg.includes('prefijo desconocido')) {
    return { status: 400, error: 'Código inválido.' };
  }
  return { status: 500, error: 'Error interno. Inténtalo de nuevo.' };
}

/* ============================================================
 *                      HANDLER
 * ============================================================ */
async function handleCanje(req, res) {
  console.log('🎯 POST /regalos/canjear (handler) url=', req.originalUrl);
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
      return res.status(400).json({ ok:false, error:'Faltan datos: nombre, email, libro y código.' });
    }
    if (!/^(REG-|PRE-)/.test(codigo) || codigo.length < 7 || codigo.length > 64) {
      return res.status(400).json({ ok:false, error:'Código inválido.' });
    }

    const resp = await canjearCodigoRegalo({
      nombre,
      apellidos,
      email,
      libro_elegido: libroElegido,
      codigo_regalo: codigo,
      ...(membershipId ? { membershipId } : {})
    });

    if (!resp || resp.ok === false) {
      const errMsg = (resp && (resp.error || resp.motivo || resp.message)) || 'no es válido';
      const { status, error } = mapError(errMsg);
      console.warn(`⚠️ Canje rechazado (${status}): ${errMsg}`);
      return res.status(status).json({ ok:false, error });
    }

    console.log(`✅ Canje OK → ${codigo} (${email})`);
    return res.status(200).json({ ok:true, mensaje:'Libro activado correctamente', resultado: resp });
  } catch (err) {
    const { status, error } = mapError(err?.message || err);
    console.error('❌ Error en canje:', err?.message || err);
    return res.status(status).json({ ok:false, error });
  }
}

/* ============================================================
 *                      RUTAS (RELATIVAS)
 * ============================================================ */
// ¡OJO! Estas rutas se montan con app.use('/regalos', router)
router.post(ROUTE_CANON,  verifyHmac, handleCanje);  // POST /regalos/canjear-codigo
router.post(ROUTE_ALIAS,  verifyHmac, handleCanje);  // POST /regalos/canjear-codigo-regalo
router.post(PATH_LEGACY,  verifyHmac, handleCanje);  // POST /regalos/canjear  (compat)

module.exports = router;
