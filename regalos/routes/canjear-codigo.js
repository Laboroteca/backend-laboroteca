// 📂 Ruta: /regalos/routes/canjear-codigo.js
// 

// 📂 regalos/routes/canjear-codigo.js
const express = require('express');
const router = express.Router();

const canjearCodigoRegalo = require('../services/canjear-codigo-regalo');

// 📌 Endpoint para canjear un código regalo
router.post('/canjear-codigo-regalo', async (req, res) => {
  try {
    console.log('📥 Body recibido /canjear-codigo-regalo:', req.body);

    const {
      nombre = '',
      apellidos = '',
      email = '',
      libro_elegido = '',
      codigo_regalo = '',
      codigoRegalo = '' // fallback por si el campo viene en camelCase
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
      codigo_regalo: codigo, // ✅ el servicio espera snake_case
    });

    return res.json({
      ok: true,
      mensaje: 'Libro activado correctamente',
      resultado
    });
  } catch (err) {
    console.error('❌ Error en /canjear-codigo-regalo:', err?.message || err);
    return res.status(400).json({
      ok: false,
      error: err.message || 'Error desconocido'
    });
  }
});

// ✅ Exportamos el router para que pueda ser usado en app.use()
module.exports = router;
