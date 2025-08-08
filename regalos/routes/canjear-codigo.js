const express = require('express');
const router = express.Router();

const canjearCodigoRegalo = require('../services/canjear-codigo-regalo');

router.post('/canjear-codigo-regalo', async (req, res) => {
  try {
    const resultado = await canjearCodigoRegalo(req.body);
    res.json({ ok: true, mensaje: 'Libro activado correctamente', resultado });
  } catch (err) {
    console.error('❌ Error en /canjear-codigo-regalo:', err.message);
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
