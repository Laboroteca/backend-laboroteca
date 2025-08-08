// 🔐 VALIDAR ENTRADA QR – Solo uso privado por Ignacio
// Ruta POST /validar-entrada
// - Requiere token privado de validador en header X-LABOROTECA-TOKEN
// - Busca el código en Google Sheets del evento correspondiente
// - Si no se ha validado, marca como "Usada: SÍ" en Sheets y guarda registro en Firestore
// - Si ya estaba validada, rechaza
// - Si no existe el código, rechaza

const express = require('express');
const router = express.Router();
const admin = require('../../firebase');
const firestore = admin.firestore();

const { marcarEntradaComoUsada } = require('../utils/sheetsEntradas');
const dayjs = require('dayjs');

const TOKEN_VALIDACION = process.env.VALIDADOR_ENTRADAS_TOKEN || '123456';

router.post('/validar-entrada', async (req, res) => {
  try {
    const token = req.headers['x-laboroteca-token'];
    if (token !== TOKEN_VALIDACION) {
      return res.status(403).json({ error: 'Token no autorizado.' });
    }

    const { codigoEntrada, slugEvento } = req.body;

    if (!codigoEntrada || !slugEvento) {
      return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }

    const docRef = firestore.collection('entradasValidadas').doc(codigoEntrada);
    const docSnap = await docRef.get();

    if (docSnap.exists) {
      return res.status(409).json({ error: 'Entrada ya validada.' });
    }

    // Buscar entrada en Google Sheets y marcar como usada
    const resultado = await marcarEntradaComoUsada(codigoEntrada, slugEvento);

    if (!resultado || resultado.error) {
      return res.status(404).json({ error: resultado?.error || 'Código no encontrado.' });
    }

    const { emailComprador, nombreAsistente } = resultado;

    // Registrar validación en Firestore
    await docRef.set({
      validado: true,
      fechaValidacion: dayjs().toISOString(),
      validador: 'Ignacio',
      emailComprador,
      nombreAsistente,
      evento: codigoEntrada.split('-')[0] || '',
      slugEvento
    });

    return res.json({ ok: true, mensaje: 'Entrada validada correctamente.' });
  } catch (err) {
    console.error('❌ Error en /validar-entrada:', err);
    return res.status(500).json({ error: 'Error interno al validar entrada.' });
  }
});

module.exports = router;
