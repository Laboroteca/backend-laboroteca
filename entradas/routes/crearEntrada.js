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
  const nombre = (datos.nombre || '').trim();
  const apellidos = (datos.apellidos || '').trim();
  const asistentes = Array.isArray(datos.asistentes) ? datos.asistentes : []; // [{nombre, apellidos}]
  const numEntradas = parseInt(datos.numeroEntradas || asistentes.length || 1);
  const imagenFondo = (datos.imagenFondoPDF || '').trim();
  const slugEvento = (datos.nombreProducto || datos.slugEvento || '').trim();
  const fechaEvento = (datos.fechaEvento || '').trim();
  const direccionEvento = (datos.direccionEvento || '').trim();
  const descripcionProducto = (datos.descripcionProducto || '').trim();
  const importe = parseFloat((datos.importe || '0').toString().replace(',', '.')) || 0;
  const idFormulario = (datos.formularioId || datos.formulario_id || '').toString().trim();

  // Validación mínima
  if (!email || !slugEvento || !fechaEvento || !descripcionProducto || !numEntradas) {
    console.warn('⚠️ Datos incompletos para crear entrada');
    return res.status(400).json({ error: 'Faltan datos obligatorios' });
  }

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
      idFormulario
    });

    await enviarEmailConEntradas({
      email,
      nombre,
      entradas: entradasGeneradas,
      facturaAdjunta: datos.facturaPdfBuffer,
      descripcionProducto,
      importe
    });

    console.log(`✅ Entradas generadas y enviadas a ${email} (${numEntradas})`);
    return res.status(200).json({ ok: true, mensaje: 'Entradas generadas y enviadas' });
  } catch (err) {
    console.error('❌ Error en /entradas/crear:', err.message || err);
    return res.status(500).json({ error: 'Error generando o enviando entradas' });
  }
});

module.exports = router;
