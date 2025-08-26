// 📂 regalos/routes/canjear-codigo.js
'use strict';

const express = require('express');
const crypto  = require('crypto');

const router = express.Router();
const canjearCodigoRegalo = require('../services/canjear-codigo-regalo');

/* ============================================================
 *                      CONFIG HMAC
 * ============================================================ */
// Exigir firma HMAC (recomendado: true en producción)
const HMAC_REQUIRED = String(process.env.CANJE_HMAC_REQUIRED || 'true').toLowerCase() === 'true';

// Acepta claves de ENTRADAS o REGALOS (reaprovechamos las mismas que en WP)
const API_KEYS = [
  process.env.ENTRADAS_API_KEY,
  process.env.REGALOS_API_KEY
].filter(Boolean);

const SECRETS = [
  process.env.ENTRADAS_HMAC_SECRET,
  process.env.REGALOS_HMAC_SECRET
].filter(Boolean);

// Ventana anti-replay
const MAX_SKEW_MS = 5 * 60 * 1000; // ±5 min

// Ruta exacta usada para firmar en WP (debe coincidir)
const CANJEAR_PATH = '/regalos/canjear-codigo-regalo';

/* ============================================================
 *                      HELPERS
 * ============================================================ */
function safeEq(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

/** Verifica HMAC: ts.POST.<path>.sha256(body) */
function verifyHmac(req, res, next) {
  // Permite transición si no exigimos HMAC y faltan cabeceras
  const apiKey = req.header('x-api-key') || '';
  const ts     = req.header('x-entr-ts') || req.header('x-e-ts') || '';
  const sig    = req.header('x-entr-sig') || req.header('x-e-sig') || '';

  if (!HMAC_REQUIRED && (!apiKey || !ts || !sig)) return next();

  // Comprobaciones base
  if (!apiKey || !ts || !sig) {
    return res.status(403).json({ ok: false, error: 'No autorizado.' });
  }
  if (!API_KEYS.length || !SECRETS.length) {
    return res.status(500).json({ ok: false, error: 'Config HMAC incompleta.' });
  }
  if (!API_KEYS.includes(apiKey)) {
    return res.status(403).json({ ok: false, error: 'No autorizado.' });
  }

  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) {
    return res.status(400).json({ ok: false, error: 'Cabecera de tiempo inválida.' });
  }
  if (Math.abs(Date.now() - tsNum) > MAX_SKEW_MS) {
    return res.status(401).json({ ok: false, error: 'Solicitud expirada.' });
  }

  // El body debe ser exactamente el que firmó WP: usa req.rawBody si tu app.json lo adjunta
  const bodyJson = req.rawBody?.toString('utf8') || JSON.stringify(req.body || {});
  const bodyHash = crypto.createHash('sha256').update(bodyJson, 'utf8').digest('hex');

  // Montamos la base firmada
  const base = `${ts}.POST.${CANJEAR_PATH}.${bodyHash}`;

  let ok = false;
  for (const secret of SECRETS) {
    const expected = crypto.createHmac('sha256', secret).update(base, 'utf8').digest('hex');
    if (safeEq(expected, sig)) { ok = true; break; }
  }
  if (!ok) {
    return res.status(403).json({ ok: false, error: 'Firma inválida.' });
  }

  // (Opcional: anti-replay por ts+sig con un pequeño cache en memoria/redis)
  return next();
}

/* ============================================================
 *            MAPEO DE ERRORES (tus textos originales)
 * ============================================================ */
function mapError(errMsg = '') {
  const msg = String(errMsg || '').toLowerCase();

  // Casos comunes
  if (msg.includes('ya ha sido utilizado')) return { status: 409, error: 'Código ya usado anteriormente.' };
  if (msg.includes('no se reconoce el libro seleccionado')) return { status: 400, error: 'Libro seleccionado no reconocido.' };
  if (msg.includes('no corresponde con tu email')) return { status: 403, error: 'Este código no corresponde con tu email.' };

  // Casos de ENTRADAS (PRE-)
  if (msg.includes('entrada no está validada')) return { status: 400, error: 'Esta entrada no está validada y no puede canjearse.' };
  if (msg.includes('entrada validada no corresponde')) return { status: 403, error: 'Esta entrada validada no corresponde con tu email.' };

  // Genérico inválido / prefijos raros / not found
  if (msg.includes('no es válido') || msg.includes('requested entity was not found') || msg.includes('prefijo desconocido')) {
    return { status: 400, error: 'Código inválido.' };
  }

  return { status: 500, error: 'Error interno. Inténtalo de nuevo.' };
}

/* ============================================================
 *                      ENDPOINT
 * ============================================================ */
// 📌 Endpoint para canjear un código (REG- o PRE- validada)
router.post(CANJEAR_PATH, verifyHmac, async (req, res) => {
  try {
    // Log higiénico
    console.log('📥 /canjear-codigo-regalo BODY keys:', Object.keys(req.body || {}));

    const {
      nombre: _nombre = '',
      apellidos: _apellidos = '',
      email: _email = '',
      libro_elegido: _libro_elegido = '',
      libro: _libro = '',
      codigo_regalo: _codigo_regalo = '',
      codigoRegalo: _codigoRegalo = '',
      membershipId: _membershipId = ''
    } = req.body || {};

    // 🧹 Normalización
    const nombre        = String(_nombre).trim();
    const apellidos     = String(_apellidos).trim();
    const email         = String(_email).trim().toLowerCase();
    const libro_elegido = String(_libro_elegido || _libro).trim();
    const codigo        = String(_codigo_regalo || _codigoRegalo).trim().toUpperCase();
    const membershipId  = String(_membershipId || '').trim();

    // 📋 Validación mínima
    if (!nombre || !email || !libro_elegido || !codigo) {
      return res.status(400).json({
        ok: false,
        error: 'Faltan datos: nombre, email, libro_elegido y codigo_regalo son obligatorios.'
      });
    }
    // Prefijos esperados y tamaño razonable
    if (!/^(REG-|PRE-)/.test(codigo) || codigo.length < 7 || codigo.length > 64) {
      return res.status(400).json({ ok: false, error: 'Código inválido.' });
    }

    console.log(`🔧 Canje recibido → email=${email} libro="${libro_elegido}" codigo=${codigo}${membershipId ? ` membershipId=${membershipId}` : ''}`);

    // Payload al servicio
    const payloadServicio = {
      nombre,
      apellidos,
      email,
      libro_elegido,
      codigo_regalo: codigo,
      ...(membershipId ? { membershipId } : {})
    };

    // 🚀 Llamada al servicio
    const resultado = await canjearCodigoRegalo(payloadServicio);

    // ⛔ Servicio devolvió error “suave”
    if (!resultado || resultado.ok === false) {
      const errMsg = (resultado && (resultado.error || resultado.motivo || resultado.message)) || 'no es válido';
      const { status, error } = mapError(errMsg);
      console.warn(`⚠️ Canje rechazado (${status}): ${errMsg}`);
      return res.status(status).json({ ok: false, error });
    }

    // ✅ OK
    console.log(`✅ Canje OK → ${codigo} (${email})`);
    return res.status(200).json({
      ok: true,
      mensaje: 'Libro activado correctamente',
      resultado
    });
  } catch (err) {
    const { status, error } = mapError(err?.message || err);
    console.error('❌ Error en /canjear-codigo-regalo:', err?.message || err);
    return res.status(status).json({ ok: false, error });
  }
});

module.exports = router;
