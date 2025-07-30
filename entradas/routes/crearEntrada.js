// /entradas/routes/crearEntrada.js

const express = require('express');
const router = express.Router();
const admin = require('../../firebase');
const firestore = admin.firestore();

const generarEntradas = require('../services/generarEntradas');
const { enviarEmailConEntradas } = require('../services/enviarEmailConEntradas');

const processed = new Set(); // deduplicación básica

router.post('/', async (req, res) => {
  const token = req.headers['authorization'];
  if (!token || token !== process.env.FLUENTFORM_TOKEN) {
    console.warn('⛔️ Token inválido en /entradas');
    return res.status(403).json({ error: 'Token inválido' });
  }

  const datos = req.body;
  console.log('🎟️ Datos recibidos para entrada:\n', JSON.stringify(datos, null, 2));

  const email = (datos.email || datos.email_autorelleno || '').trim().toLowerCase();
  const nombre = datos.nombre || '';
  const apellidos = datos.apellidos || '';
  const asistentes = datos.asistentes || []; // [{nombre, apellidos}]
  const numEntradas = parseInt(datos.numeroEntradas || asistentes.length || 1);
  const imagenFondo = datos.imagenFondoPDF || '';
  const slugEvento = datos.nombreProducto || datos.slugEvento || '';
  const fechaEvento = datos.fechaEvento || '';
  const direccionEvento = datos.direccionEvento || '';
  const descripcionProducto = datos.descripcionProducto || '';
  const importe = parseFloat((datos.importe || '0').toString().replace(',', '.'));

  const hashUnico = `${email}-${slugEvento}-${numEntradas}-${importe}`;
  if (processed.has(hashUnico)) {
    console.warn(`⛔️ Solicitud duplicada ignorada para ${email}`);
    return res.status(200).json({ ok: true, mensaje: 'Duplicado ignorado' });
  }
  processed.add(hashUnico);

  try {
    const entradasGeneradas = await generarEntradas({
      email,
      nombre,
      apellidos,
      asistentes,
      numEntradas,
      slugEvento,
      fechaEvento,
      direccionEvento,
      descripcionProducto,
      imagenFondo,
    });

    await enviarEmailConEntradas({
      email,
      nombre,
      entradas: entradasGeneradas,
      facturaAdjunta: datos.facturaPdfBuffer,
      descripcionProducto,
      importe
    });

    console.log(`✅ Entradas enviadas a ${email}`);
    return res.status(200).json({ ok: true, mensaje: 'Entradas generadas y enviadas' });
  } catch (err) {
    console.error('❌ Error en /entradas/crear:', err);
    return res.status(500).json({ error: 'Error generando o enviando entradas' });
  }
});

module.exports = router;
