// 📂 regalos/routes/canjear-codigo.js
'use strict';

const express = require('express');
const crypto  = require('crypto');

const router  = express.Router();
const canjearCodigoRegalo = require('../services/canjear-codigo-regalo');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

/* ═════════════════════════════════════════
 *                CONFIG / CONSTANTES
 * ═════════════════════════════════════════ */
const HMAC_REQUIRED = String(process.env.CANJE_HMAC_REQUIRED || 'true').toLowerCase() === 'true';
const API_KEYS = [process.env.ENTRADAS_API_KEY, process.env.REGALOS_API_KEY].filter(Boolean);
const SECRETS  = [process.env.ENTRADAS_HMAC_SECRET, process.env.REGALOS_HMAC_SECRET].filter(Boolean);
const MAX_SKEW_MS = 5 * 60 * 1000; // ±5 min

// OJO: este router se monta con app.use('/regalos', router)
const BASE        = '/regalos';
const PATH_CANON  = '/canjear-codigo';
const PATH_ALIAS  = '/canjear-codigo-regalo';
const PATH_LEGACY = '/canjear';

const ROUTE_CANON = PATH_CANON;       // '/canjear-codigo'
const ROUTE_ALIAS = PATH_ALIAS;       // '/canjear-codigo-regalo'

// Boot log mínimo (no expone secretos)
console.log('[CANJ ROUTER] HMAC_REQUIRED=%s keys=%d secrets=%d', HMAC_REQUIRED, API_KEYS.length, SECRETS.length);
// RGPD: utilidades de enmascarado para logs
function maskEmail(e='') {
  const s = String(e||''); const i = s.indexOf('@');
  if (i<=0) return s ? '***' : '';
  const u = s.slice(0,i), d = s.slice(i+1);
  const um = u.length<=2 ? (u[0]||'*') : (u.slice(0,2)+'***'+u.slice(-1));
  const dm = d.length<=3 ? '***' : ('***'+d.slice(-3));
  return `${um}@${dm}`;
}
function maskCode(c='') {
  const s = String(c||'').trim();
  if (!s) return '';
  // Mantén el prefijo y oculta la parte sensible
  const m = s.match(/^([A-Z]{3})-([A-Z0-9]{5})$/);
  return m ? `${m[1]}-*****` : '*****';
}

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
  const reqId  = req.header('x-req-id') || '';
  const apiKey = req.header('x-api-key')  || '';
  const ts     = req.header('x-entr-ts')  || req.header('x-e-ts')  || '';
  const sig    = req.header('x-entr-sig') || req.header('x-e-sig') || '';
  const headerVariant = req.header('x-entr-sig') ? 'x-entr-*' : (req.header('x-e-sig') ? 'x-e-*' : 'none');

  // Permite desactivar HMAC (solo entornos controlados) si faltan cabeceras
  if (!HMAC_REQUIRED && (!apiKey || !ts || !sig)) return next();

  if (!apiKey || !ts || !sig) {
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }
  if (!API_KEYS.length || !SECRETS.length) {
    try {
      await alertAdmin({
        area: 'regalos.canjear.hmac_config_missing',
        err: new Error('HMAC config missing'),
        meta: { apiKeys: API_KEYS.length, secrets: SECRETS.length, reqId }
      });
    } catch (_) {}
    return res.status(500).json({ ok:false, error:'HMAC config missing' });
  }
  if (!API_KEYS.includes(apiKey)) {
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }

  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) return res.status(400).json({ ok:false, error:'bad timestamp' });
  if (Math.abs(Date.now() - tsNum) > MAX_SKEW_MS) return res.status(401).json({ ok:false, error:'expired' });

  // Cuerpo EXACTO (requiere app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } })))
  if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
    return res.status(400).json({ ok:false, error:'no_raw_body' });
  }
  const rawBody  = req.rawBody.toString('utf8');
  const bodyHash = crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex');

  // Paths que podría haber firmado el emisor (WP MU)
  const candidates = [BASE + PATH_CANON, BASE + PATH_ALIAS, BASE + PATH_LEGACY];

  // Log base (auditable, sin exponer secretos)
  const demoBase   = `${ts}.POST.${candidates[0]}.${bodyHash}`;
  const base10Demo = demoBase.slice(0, 10);
  console.log('[CANJ HMAC BASE]', {
    ts: String(ts),
    path: req.path || '',
    bodyHash10: bodyHash.slice(0, 10),
    sig10: String(sig).slice(0, 10),
    base10: base10Demo,
    reqId
  });

  let ok = false;
  let matchedPath = '';
  for (const p of candidates) {
    const base = `${ts}.POST.${p}.${bodyHash}`;
    for (const secret of SECRETS) {
      const exp = crypto.createHmac('sha256', secret).update(base, 'utf8').digest('hex');
      if (safeEqHex(exp, sig)) { ok = true; matchedPath = p; break; }
    }
    if (ok) break;
  }

  if (!ok) {
    const meta = {
      ts: String(ts),
      headerVariant,
      pathTried: candidates,
      // LOGS: PII enmascarada
      emailMasked: maskEmail(req.body?.email || ''),
      codigoMasked: maskCode(req.body?.codigo || req.body?.codigo_regalo || ''),
      reqId
    };
    console.warn('[CANJ HMAC DENY]', meta);
    try {
      // ALERTA: email/código completos para soporte
      await alertAdmin({
        area: 'regalos.canjear.hmac_deny',
        email: req.body?.email || '-',
        err: new Error('HMAC verification failed'),
        meta: {
          codigo: req.body?.codigo || req.body?.codigo_regalo || null,
          headerVariant,
          pathTried: candidates,
          reqId
        }
      });
    } catch (_) {}
    return res.status(401).json({ ok:false, error:'unauthorized' });
  }

  // Log éxito (compacto)
  console.log('[CANJ HMAC OK]', {
    ts: String(ts),
    sig10: String(sig).slice(0, 10),
    headerVariant,
    path: matchedPath,
    reqId
  });
  return next();
}

/* ═════════════════════════════════════════
 *         MAPEO DE ERRORES → RESPUESTAS UX
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

  if (msg.includes('too many requests') || msg.includes('rate')) {
    return { status: 429, error: 'Demasiadas solicitudes. Inténtalo en un minuto.' };
  }

  return { status: 500, error: 'Error interno. Inténtalo de nuevo.' };
}

/* ═════════════════════════════════════════
 *                HANDLER
 * ═════════════════════════════════════════ */
async function handleCanje(req, res) {
  try {
    const reqId = req.header('x-req-id') || '';
    const b = req.body || {};

    // Normalización de entrada
    const nombre        = String(b.nombre || '').trim();
    const apellidos     = String(b.apellidos || '').trim();
    const email         = String(b.email || '').trim().toLowerCase();
    const libroElegido  = String(b.libro_elegido || b.libro || b.elige_un_libro || '').trim();
    let   codigo        = String(b.codigo_regalo || b.codigo || b.codigoRegalo || '').trim().toUpperCase();
    const membershipId  = b.membershipId ? String(b.membershipId).trim() : '';

    // Normalización defensiva del código:
    // - quitar espacios
    // - si viene como REGxxxxx/PRExxxxx, insertamos el guion
    codigo = codigo.replace(/\s+/g, '');
    if (/^(REG|PRE)[A-Z0-9]{5}$/.test(codigo)) {
      codigo = codigo.slice(0, 3) + '-' + codigo.slice(3);
    }

    if (!nombre || !email || !libroElegido || !codigo) {
      return res.status(422).json({ ok:false, error:'Faltan datos: nombre, email, libro y código.' });
    }
    // Regla estricta y alineada con el front: prefijo y 5 caracteres alfanuméricos
    if (!/^(REG|PRE)-[A-Z0-9]{5}$/.test(codigo)) {
      return res.status(400).json({ ok:false, error:'Código inválido.' });
    }

    // Llamada al servicio (idempotencia y validaciones internas)
    const resp = await canjearCodigoRegalo({
      nombre,
      apellidos,
      email,
      libro_elegido: libroElegido,
      codigo_regalo: codigo,
      reqId,
      ...(membershipId ? { membershipId } : {})
    });

    // Servicio devolvió error semántico
    if (!resp || resp.ok === false) {
      const errMsg = (resp && (resp.error || resp.motivo || resp.message)) || 'no es válido';
      const { status, error } = mapError(errMsg);
      return res.status(status).json({ ok:false, error });
    }

    // Éxito
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
          email: req.body?.email || null,      // OK: admin recibe completo
          codigo: req.body?.codigo || req.body?.codigo_regalo || null, // OK en admin
          libro: req.body?.libro_elegido || req.body?.libro || null,
          reqId: req.header('x-req-id') || ''
        }
      });
    } catch (_) {}
    return res.status(status).json({ ok:false, error });
  }
}

/* ═════════════════════════════════════════
 *                RUTAS (relativas)
 * ═════════════════════════════════════════ */
// Se montan con app.use('/regalos', router)
router.post(ROUTE_CANON, verifyHmac, handleCanje);   // POST /regalos/canjear-codigo
router.post(ROUTE_ALIAS, verifyHmac, handleCanje);   // POST /regalos/canjear-codigo-regalo
router.post(PATH_LEGACY, verifyHmac, handleCanje);   // POST /regalos/canjear (compat)

module.exports = router;
