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
    console.log('🔐 Token recibido:', token);

    if (token !== TOKEN_VALIDACION) {
      console.warn('❌ Token no autorizado');
      return res.status(403).json({ error: 'Token no autorizado.' });
    }

    const { codigoEntrada, slugEvento } = req.body;
    console.log('📨 Datos recibidos:', { codigoEntrada, slugEvento });

    if (!codigoEntrada || !slugEvento) {
      console.warn('⚠️ Faltan campos obligatorios');
      return res.status(400).json({ error: 'Faltan campos obligatorios.' });
    }

    // Limpieza del código en caso de que venga como URL completa
    let codigoLimpio = String(codigoEntrada).trim();
    if (codigoLimpio.startsWith('http')) {
      try {
        const url = new URL(codigoLimpio);
        codigoLimpio = url.searchParams.get('codigo') || codigoLimpio;
        console.log('🔍 Código extraído de URL:', codigoLimpio);
      } catch (err) {
        console.warn('⚠️ No se pudo parsear la URL del código. Se usará valor original.');
      }
    }

    if (!codigoLimpio || codigoLimpio.includes('//')) {
      console.warn('⚠️ Código de entrada inválido:', codigoLimpio);
      return res.status(400).json({ error: 'Código de entrada inválido.' });
    }

    const docRef = firestore.collection('entradasValidadas').doc(codigoLimpio);
    const docSnap = await docRef.get();

    if (docSnap.exists) {
      console.warn('⚠️ Entrada ya validada previamente en Firestore');
      return res.status(409).json({ error: 'Entrada ya validada.' });
    }

    console.log('🔍 Buscando código en hoja de Google Sheets...');
    const resultado = await marcarEntradaComoUsada(codigoLimpio, slugEvento);
    console.log('📋 Resultado de Sheets:', resultado);

    if (!resultado || resultado.error) {
      console.warn('❌ Código no encontrado o error en Sheets:', resultado?.error);
      return res.status(404).json({ error: resultado?.error || 'Código no encontrado.' });
    }

    const { emailComprador, nombreAsistente } = resultado;

    await docRef.set({
      validado: true,
      fechaValidacion: dayjs().toISOString(),
      validador: 'Ignacio',
      emailComprador,
      nombreAsistente,
      evento: codigoLimpio.split('-')[0] || '',
      slugEvento
    });

    console.log(`✅ Entrada ${codigoLimpio} validada correctamente.`);
    return res.json({ ok: true, mensaje: 'Entrada validada correctamente.' });
  } catch (err) {
    console.error('❌ Error en /validar-entrada:', err.stack || err);
    return res.status(500).json({ error: 'Error interno al validar entrada.' });
  }
});

module.exports = router;
