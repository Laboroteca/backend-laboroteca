// 📂 regalos/routes/canjear-codigo.js
const express = require('express');
const router = express.Router();

const canjearCodigoRegalo = require('../services/canjear-codigo-regalo');

/**
 * 🔎 Traduce mensajes de error del servicio a códigos HTTP y textos para el frontend
 */
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

// 📌 Endpoint para canjear un código (REG- o PRE- validada)
router.post('/canjear-codigo-regalo', async (req, res) => {
  try {
    // Log de entrada (sin volcar datos sensibles)
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

    if (codigo.length < 3) {
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
