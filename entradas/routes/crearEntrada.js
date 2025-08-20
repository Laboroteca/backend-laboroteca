// /entradas/routes/crearEntrada.js

const express = require('express');
const router = express.Router();

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
  const numEntradas = parseInt(datos.numeroEntradas || asistentes.length || 1, 10);
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
    // 1) Generar entradas (devuelve { entradas, errores })
    const { entradas, errores } = await generarEntradas({
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

    // 2) Enviar SIEMPRE email con entradas (si falla, abortamos con 500)
    try {
      await enviarEmailConEntradas({
        email,
        nombre,
        entradas, // [{ buffer }]
        facturaAdjunta: datos.facturaPdfBuffer || null,
        descripcionProducto,
        importe
      });
    } catch (e) {
      console.error('❌ Error enviando email de entradas:', e.message || e);
      return res.status(500).json({ error: 'No se pudo enviar el email con entradas.' });
    }

    // 3) Aviso a admin si hubo errores post-email (no bloquea la respuesta al cliente)
    if (errores && errores.length) {
      try {
        const { enviarEmailPersonalizado } = require('../../services/email');
        await enviarEmailPersonalizado({
          to: 'laboroteca@gmail.com',
          subject: `⚠️ Fallos post-pago en registro de entradas (${email})`,
          text: JSON.stringify(
            {
              email,
              descripcionProducto,
              fechaEvento,
              slugEvento,
              idFormulario,
              errores
            },
            null,
            2
          )
        });
      } catch (e) {
        console.error('⚠️ No se pudo avisar al admin:', e.message || e);
      }
    }

    console.log(`✅ Entradas generadas y enviadas a ${email} (${numEntradas})`);
    return res.status(200).json({ ok: true, mensaje: 'Entradas generadas y enviadas' });
  } catch (err) {
    console.error('❌ Error en /entradas/crear:', err.message || err);
    return res.status(500).json({ error: 'Error generando entradas' });
  }
});

module.exports = router;
