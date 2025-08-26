// 📂 regalos/routes/canjear-codigo.js
'use strict';

const express = require('express');
const crypto  = require('crypto');

const router  = express.Router();
const canjearCodigoRegalo = require('../services/canjear-codigo-regalo');

/* ════════════════════════════════════════════════════════════
 *                       CONFIG HMAC
 * ════════════════════════════════════════════════════════════ */
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
const PATH_LEGACY = '/canjear'; // compat

// En el router SIEMPRE registramos rutas *relativas* (sin `/regalos`)
const ROUTE_CANON  = PATH_CANON;   // '/canjear-codigo'
const ROUTE_ALIAS  = PATH_ALIAS;   // '/canjear-codigo-regalo'

/* ════════════════════════════════════════════════════════════
 *                      LOG HELPERS
 * ════════════════════════════════════════════════════════════ */
const hash8 = (v) => {
  try { return crypto.createHash('sha256').update(String(v || ''), 'utf8').digest('hex').slice(0,8); }
  catch { return 'ERRHASH'; }
};
const short = (hex, n=10) => (hex && typeof hex === 'string') ? hex.slice(0,n) : '';

(function bootLog(){
  console.log('🧩 [CANJ ROUTER BOOT] HMAC_REQUIRED=', HMAC_REQUIRED);
  console.log('🧩 [CANJ ROUTER BOOT] API_KEYS count=', API_KEYS.length, 'hashes=', API_KEYS.map(k => hash8(k)));
  console.log('🧩 [CANJ ROUTER BOOT] SECRETS count=', SECRETS.length, 'hashes=', SECRETS.map(s => hash8(s)));
  console.log('🧩 [CANJ ROUTER BOOT] Routes:', {
    mountBase: BASE,
    ROUTE_CANON, ROUTE_ALIAS, PATH_LEGACY,
    hmacSkewMs: MAX_SKEW_MS
  });
})();

/* ════════════════════════════════════════════════════════════
 *                        HELPERS
 * ════════════════════════════════════════════════════════════ */
function safeEqHex(aHex, bHex) {
  try {
    const A = Buffer.from(String(aHex || ''), 'hex');
    const B = Buffer.from(String(bHex || ''), 'hex');
    return A.length === B.length && crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

/** Verifica HMAC: ts.POST.<path>.sha256(body) */
function verifyHmac(req, res, next) {
  const apiKey = req.header('x-api-key')   || '';
  const ts     = req.header('x-entr-ts')   || req.header('x-e-ts')   || '';
  const sig    = req.header('x-entr-sig')  || req.header('x-e-sig')  || '';
  const rid    = req.header('x-req-id')    || '';

  const rawBodyStr = req.rawBody ? req.rawBody.toString('utf8') : (req.body ? JSON.stringify(req.body) : '');
  const bodyHash   = crypto.createHash('sha256').update(rawBodyStr, 'utf8').digest('hex');
  const tsNum      = parseInt(ts, 10);
  const skewMs     = Math.abs(Date.now() - (Number.isFinite(tsNum) ? tsNum : 0));

  console.log('🔐 [HMAC IN] rid=', rid || '(none)', 'url=', req.originalUrl);
  console.log('🔐 [HMAC IN] headers:', {
    apiKeyPresent: !!apiKey,
    tsPresent: !!ts,
    sigPresent: !!sig,
    apiKeyHash: hash8(apiKey),
    sig10: short(sig, 10),
    ts
  });
  console.log('🔐 [HMAC IN] body: len=', rawBodyStr.length, 'sha10=', short(bodyHash,10));

  if (!HMAC_REQUIRED && (!apiKey || !ts || !sig)) {
    console.warn('🔓 [HMAC BYPASS] HMAC_REQUIRED=false y faltan cabeceras → se permite paso');
    return next();
  }

  if (!apiKey || !ts || !sig) {
    console.warn('⛔ [HMAC FAIL] missing headers');
    return res.status(401).json({ ok:false, error:'unauthorized', reason:'missing_headers' });
  }
  if (!API_KEYS.length || !SECRETS.length) {
    console.error('⛔ [HMAC FAIL] config missing (API_KEYS/SECRETS vacíos)');
    return res.status(500).json({ ok:false, error:'HMAC config missing' });
  }
  if (!API_KEYS.includes(apiKey)) {
    console.warn('⛔ [HMAC FAIL] apiKey no aceptada hash=', hash8(apiKey));
    return res.status(401).json({ ok:false, error:'unauthorized', reason:'bad_apikey' });
  }
  if (!Number.isFinite(tsNum)) {
    console.warn('⛔ [HMAC FAIL] timestamp inválido');
    return res.status(400).json({ ok:false, error:'bad timestamp' });
  }
  if (skewMs > MAX_SKEW_MS) {
    console.warn('⛔ [HMAC FAIL] solicitud expirada skewMs=', skewMs, 'limit=', MAX_SKEW_MS);
    return res.status(401).json({ ok:false, error:'expired', skewMs });
  }

  // Candidatos de path (lo que firmó WP)
  const candidates = [
    BASE + PATH_CANON,   // /regalos/canjear-codigo
    BASE + PATH_ALIAS,   // /regalos/canjear-codigo-regalo
    BASE + PATH_LEGACY   // /regalos/canjear
  ];
  console.log('🔐 [HMAC IN] candidates=', candidates);

  // Probar todos los candidatos y secretos
  let ok = false;
  let match = { path:null, secretHash:null, base10:null };

  for (const p of candidates) {
    const base = `${ts}.POST.${p}.${bodyHash}`;
    for (const secret of SECRETS) {
      const expected = crypto.createHmac('sha256', secret).update(base, 'utf8').digest('hex');
      const eq = safeEqHex(expected, sig);
      console.log('   • test base10=', short(base,10), 'exp10=', short(expected,10), '== sig10=', short(sig,10), '→', eq ? 'OK' : 'NO');
      if (eq) {
        ok = true;
        match = { path: p, secretHash: hash8(secret), base10: short(base,10) };
        break;
      }
    }
    if (ok) break;
  }

  if (!ok) {
    console.warn('⛔ [HMAC FAIL] ninguna coincidencia con candidatos');
    return res.status(401).json({ ok:false, error:'unauthorized', reason:'bad_signature' });
  }

  console.log('✅ [HMAC OK] match:', match);
  return next();
}

/* ════════════════════════════════════════════════════════════
 *            MAPEO DE ERRORES (tus textos originales)
 * ════════════════════════════════════════════════════════════ */
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

/* ════════════════════════════════════════════════════════════
 *                         HANDLER
 * ════════════════════════════════════════════════════════════ */
async function handleCanje(req, res) {
  const rid = req.header('x-req-id') || '';
  const ip  = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
  console.log('🎯 [CANJ IN] url=', req.originalUrl, 'rid=', rid || '(none)', 'ip=', ip);
  console.log('🎯 [CANJ IN] baseUrl=', req.baseUrl, 'path=', req.path, 'method=', req.method);
  console.log('🎯 [CANJ IN] hdr.apikeyHash=', hash8(req.header('x-api-key')||''), 'ts=', req.header('x-entr-ts')||req.header('x-e-ts')||'', 'sig10=', short(req.header('x-entr-sig')||req.header('x-e-sig')||'',10));
  console.log('🎯 [CANJ IN] rawLen=', (req.rawBody ? req.rawBody.length : 0), 'jsonKeys=', Object.keys(req.body || {}));

  try {
    const b = req.body || {};

    // Normalización de entrada
    const nombre        = String(b.nombre || '').trim();
    const apellidos     = String(b.apellidos || '').trim();
    const email         = String(b.email || '').trim().toLowerCase();
    const libroElegido  = String(b.libro_elegido || b.libro || b.elige_un_libro || '').trim();
    const codigo        = String(b.codigo_regalo || b.codigo || b.codigoRegalo || '').trim().toUpperCase();
    const membershipId  = b.membershipId ? String(b.membershipId).trim() : '';

    console.log('🧹 [CANJ NORM]', { nombre, apellidos, email, libroElegido, codigo, hasMembershipId: !!membershipId });

    if (!nombre || !email || !libroElegido || !codigo) {
      console.warn('⛔ [CANJ FAIL] faltan campos', { nombre:!!nombre, email:!!email, libro:!!libroElegido, codigo:!!codigo });
      return res.status(400).json({ ok:false, error:'Faltan datos: nombre, email, libro y código.' });
    }
    if (!/^(REG-|PRE-)/.test(codigo) || codigo.length < 7 || codigo.length > 64) {
      console.warn('⛔ [CANJ FAIL] código inválido', { codigo });
      return res.status(400).json({ ok:false, error:'Código inválido.' });
    }

    // Llamada al servicio
    console.log('🚀 [CANJ CALL] → servicio canjearCodigoRegalo');
    const resp = await canjearCodigoRegalo({
      nombre,
      apellidos,
      email,
      libro_elegido: libroElegido,
      codigo_regalo: codigo,
      ...(membershipId ? { membershipId } : {})
    });

    console.log('📥 [CANJ RESP] servicio=', resp ? (resp.ok !== false ? 'ok' : 'fail') : 'empty');

    if (!resp || resp.ok === false) {
      const errMsg = (resp && (resp.error || resp.motivo || resp.message)) || 'no es válido';
      const { status, error } = mapError(errMsg);
      console.warn(`⚠️ [CANJ REJECT] (${status})`, errMsg);
      return res.status(status).json({ ok:false, error });
    }

    console.log(`✅ [CANJ OK] codigo=${codigo} email=${email}`);
    return res.status(200).json({ ok:true, mensaje:'Libro activado correctamente', resultado: resp });
  } catch (err) {
    const { status, error } = mapError(err?.message || err);
    console.error('❌ [CANJ EXC]', err?.message || err);
    return res.status(status).json({ ok:false, error });
  }
}

/* ════════════════════════════════════════════════════════════
 *                      RUTAS (RELATIVAS)
 * ════════════════════════════════════════════════════════════ */
// ¡OJO! Estas rutas se montan con app.use('/regalos', router)
router.post(ROUTE_CANON,  verifyHmac, handleCanje);   // POST /regalos/canjear-codigo
router.post(ROUTE_ALIAS,  verifyHmac, handleCanje);   // POST /regalos/canjear-codigo-regalo
router.post(PATH_LEGACY,  verifyHmac, handleCanje);   // POST /regalos/canjear  (compat)

console.log('🧩 [CANJ ROUTER READY] Mounted relative routes:', [ROUTE_CANON, ROUTE_ALIAS, PATH_LEGACY]);

module.exports = router;
