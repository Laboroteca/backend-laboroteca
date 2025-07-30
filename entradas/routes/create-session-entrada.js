const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { emailRegistradoEnWordPress } = require('../../utils/wordpress');
const { normalizar } = require('../../utils/normalizar');

const router = express.Router();

const PRICE_ID_ENTRADA = 'price_1RqWUuEe6Cd77jenDQ3Vu5hY'; // ID fijo del producto en Stripe
const URL_IMAGEN = 'https://www.laboroteca.es/wp-content/uploads/2025/07/ENTRADAS-LABOROTECA-scaled.webp';

router.post('/crear-sesion-entrada', async (req, res) => {
  try {
    const datos = typeof req.body === 'object' ? req.body : (Object.values(req.body)[0] || {});
    
    const nombre = (datos.nombre || '').trim();
    const apellidos = (datos.apellidos || '').trim();
    const email = (datos.email || '').trim().toLowerCase();
    const dni = (datos.dni || '').trim();
    const direccion = (datos.direccion || '').trim();
    const ciudad = (datos.ciudad || '').trim();
    const provincia = (datos.provincia || '').trim();
    const cp = (datos.cp || '').trim();
    const tipoProducto = (datos.tipoProducto || 'entrada').trim();
    const nombreProducto = (datos.nombreProducto || '').trim();
    const descripcionProducto = (datos.descripcionProducto || `Entrada "${nombreProducto}"`).trim();
    const slugEvento = normalizar(nombreProducto);
    const imagenFondo = (datos.imagenFondo || '').trim();
    const fechaActuacion = (datos.fechaActuacion || '').trim();
    const formularioId = (datos.formularioId || '').trim();
    const totalAsistentes = parseInt(datos.totalAsistentes || 0);

    if (
      !email || !nombre || !nombreProducto || !tipoProducto || !slugEvento || !formularioId || !totalAsistentes
    ) {
      console.warn('⚠️ [crear-sesion-entrada] Faltan datos obligatorios.', {
        nombre, email, nombreProducto, tipoProducto, formularioId, totalAsistentes
      });
      return res.status(400).json({ error: 'Faltan datos obligatorios para crear la sesión.' });
    }

    const registrado = await emailRegistradoEnWordPress(email);
    if (!registrado) {
      console.warn('🚫 [crear-sesion-entrada] Email no registrado en WP:', email);
      return res.status(403).json({ error: 'El email no está registrado como usuario.' });
    }

    // Recopilar asistentes
    const metadataAsistentes = {};
    for (let i = 1; i <= totalAsistentes; i++) {
      metadataAsistentes[`asistente_${i}_nombre`] = datos[`asistente_${i}_nombre`] || '';
      metadataAsistentes[`asistente_${i}_apellidos`] = datos[`asistente_${i}_apellidos`] || '';
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{
        price: PRICE_ID_ENTRADA,
        quantity: totalAsistentes
      }],
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(nombreProducto)}`,
      cancel_url: 'https://laboroteca.es/error',
      metadata: {
        nombre,
        apellidos,
        email,
        dni,
        direccion,
        ciudad,
        provincia,
        cp,
        tipoProducto,
        nombreProducto,
        descripcionProducto,
        imagenFondo,
        fechaActuacion,
        slugEvento,
        formularioId,
        totalAsistentes: String(totalAsistentes),
        ...metadataAsistentes
      }
    });

    console.log('✅ [crear-sesion-entrada] Sesión Stripe creada:', session.url);
    res.json({ url: session.url });

  } catch (err) {
    console.error('❌ [crear-sesion-entrada] Error creando sesión de pago:', err.message || err);
    res.status(500).json({ error: 'Error interno al crear la sesión de entrada.' });
  }
});

module.exports = router;
