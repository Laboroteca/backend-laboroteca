// 📂 regalos/routes/canjear-codigo.js
const express = require('express');
const router = express.Router();

const canjearCodigoRegalo = require('../services/canjear-codigo-regalo');

function mapError(errMsg = '') {
  const msg = String(errMsg || '');
  if (msg.includes('ya ha sido utilizado')) return { status: 409, error: 'Código ya usado anteriormente.' };
  if (msg.includes('no es válido') || msg.includes('Requested entity was not found')) return { status: 400, error: 'Código inválido.' };
  if (msg.includes('no corresponde con tu email')) return { status: 403, error: 'Este código no corresponde con tu email.' };
  if (msg.includes('No se reconoce el libro seleccionado')) return { status: 400, error: 'Libro seleccionado no reconocido.' };
  return { status: 500, error: 'Error interno. Inténtalo de nuevo.' };
}

router.post('/canjear-codigo-regalo', async (req, res) => {
  try {
    console.log('📥 Body recibido /canjear-codigo-regalo:', req.body);

    const {
      nombre = '',
      apellidos = '',
      email = '',
      libro_elegido = '',
      codigo_regalo = '',
      codigoRegalo = ''
    } = req.body || {};

    const codigo = (codigo_regalo || codigoRegalo || '').trim();

    if (!nombre || !email || !libro_elegido || !codigo) {
      return res.status(400).json({
        ok: false,
        error: 'Faltan datos: nombre, email, libro_elegido y codigo_regalo son obligatorios.'
      });
    }

    const resultado = await canjearCodigoRegalo({
      nombre,
      apellidos,
      email,
      libro_elegido,
      codigo_regalo: codigo,
    });

    // ⛔️ CLAVE: si el servicio NO lanza y devuelve un objeto con error, convertirlo en respuesta no-200
    if (!resultado || resultado.ok === false) {
      const errMsg = (resultado && (resultado.error || resultado.motivo || resultado.message)) || 'no es válido';
      const { status, error } = mapError(errMsg);
      console.warn(`⚠️ Canje rechazado (${status}):`, errMsg);
      return res.status(status).json({ ok: false, error });
    }

    return res.status(200).json({
      ok: true,
      mensaje: 'Libro activado correctamente',
      resultado,
    });
  } catch (err) {
    const { status, error } = mapError(err?.message || err);
    console.error('❌ Error en /canjear-codigo-regalo:', err?.message || err);
    return res.status(status).json({ ok: false, error });
  }
});

module.exports = router;
