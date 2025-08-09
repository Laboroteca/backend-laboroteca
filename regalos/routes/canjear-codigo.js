// 📂 regalos/routes/canjear-codigo.js
const express = require('express');
const router = express.Router();

const canjearCodigoRegalo = require('../services/canjear-codigo-regalo');

/**
 * 🔎 Traduce mensajes de error del servicio a códigos HTTP y mensajes para el frontend
 */
function mapError(errMsg = '') {
  const msg = String(errMsg || '').toLowerCase();
  if (msg.includes('ya ha sido utilizado')) return { status: 409, error: 'Código ya usado anteriormente.' };
  if (msg.includes('no es válido') || msg.includes('requested entity was not found')) return { status: 400, error: 'Código inválido.' };
  if (msg.includes('no corresponde con tu email')) return { status: 403, error: 'Este código no corresponde con tu email.' };
  if (msg.includes('no se reconoce el libro seleccionado')) return { status: 400, error: 'Libro seleccionado no reconocido.' };
  return { status: 500, error: 'Error interno. Inténtalo de nuevo.' };
}

// 📌 Endpoint para canjear un código regalo
router.post('/canjear-codigo-regalo', async (req, res) => {
  try {
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

    // Regla ligera para filtrar códigos incompletos
    if (codigo.length < 3) {
      return res.status(400).json({ ok: false, error: 'Código inválido.' });
    }

    // 📜 Log limpio
    console.log(`📥 Canje recibido: ${email} → "${libro_elegido}" (cod:${codigo})${membershipId ? ` [membershipId:${membershipId}]` : ''}`);

    // 🛠️ Montamos payload para el servicio
    const payloadServicio = {
      nombre,
      apellidos,
      email,
      libro_elegido,
      codigo_regalo: codigo
    };
    if (membershipId) payloadServicio.membershipId = membershipId;

    // 🚀 Llamada al servicio
    const resultado = await canjearCodigoRegalo(payloadServicio);

    // ⛔ Servicio devuelve error aunque no lance excepción
    if (!resultado || resultado.ok === false) {
      const errMsg = (resultado && (resultado.error || resultado.motivo || resultado.message)) || 'no es válido';
      const { status, error } = mapError(errMsg);
      console.warn(`⚠️ Canje rechazado (${status}): ${errMsg}`);
      return res.status(status).json({ ok: false, error });
    }

    // ✅ Canje OK
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
