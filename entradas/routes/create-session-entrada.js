const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { emailRegistradoEnWordPress } = require('../utils/wordpress');
const PRODUCTOS = require('../../utils/productos');

const router = express.Router();
const URL_IMAGEN_DEFAULT = 'https://www.laboroteca.es/wp-content/uploads/2025/07/ENTRADAS-LABOROTECA-scaled.webp';

router.post('/crear-sesion-entrada', async (req, res) => {
  try {
    const datos = req.body;
    console.log('📥 Datos crudos del formulario recibidos:\n', JSON.stringify(req.body, null, 2));
    console.log('📥 Datos recibidos en /crear-sesion-entrada:\n', JSON.stringify(datos, null, 2));

    // Campos del comprador
    const nombre = (datos.nombre || '').trim();
    const apellidos = (datos.apellidos || '').trim();
    const email = (datos.email || '').trim().toLowerCase();
    const dni = (datos.dni || '').trim();
    const direccion = (datos.direccion || '').trim();
    const ciudad = (datos.ciudad || '').trim();
    const provincia = (datos.provincia || '').trim();
    const cp = (datos.cp || '').trim();

    // Campos del producto/evento
    const tipoProducto = (datos.tipoProducto || '').trim();
    const producto = PRODUCTOS['entrada evento'];
    const nombreProducto = (datos.nombreProducto || '').trim();
    const descripcionProducto = (datos.descripcionProducto || `Entrada "${nombreProducto}"`).trim();
    const direccionEvento = (datos.direccionEvento || '').trim();
    const imagenPDF = (datos.imagenEvento || '').trim();
    const imagenStripe = URL_IMAGEN_DEFAULT;
    const fechaActuacion = (datos.fechaActuacion || '').trim();
    const formularioId = (datos.formularioId || '').toString().trim();

    // Cálculo del precio (precio fijo por Stripe)
    const totalAsistentes = parseInt(
      String(datos.totalAsistentes || datos.input_totalAsistentes || datos.input_20 || '0').replace(/\D/g, '')
    );


    const precioTotal = Number.isInteger(totalAsistentes) ? totalAsistentes * 1500 : 0;

    // 🔎 LOG DEBUG PRECIO ENTRADAS
    console.log('🧪 DEBUG PRECIO ENTRADAS');
    console.log('👉 totalAsistentes:', totalAsistentes);
    console.log('👉 precio unitario esperado: 15.00 €');
    console.log('👉 precioTotal (en céntimos):', precioTotal);
    console.log('👉 precioTotal (en euros):', precioTotal / 100);
    console.log('👉 tipoProducto:', tipoProducto);
    console.log('👉 nombreProducto:', nombreProducto);
    console.log('👉 descripcionProducto:', descripcionProducto);


    console.log('🧾 Cálculo de precio:\n', {
      totalAsistentes,
      precioTotal
    });

    // Validación de campos obligatorios
    if (
      !email || !nombre || !nombreProducto || !tipoProducto || !precioTotal || !totalAsistentes ||
      !formularioId || !fechaActuacion
    ) {
      console.warn('⚠️ [crear-sesion-entrada] Faltan datos obligatorios.');
      return res.status(400).json({ error: 'Faltan datos obligatorios para crear la sesión.' });
    }

    // Verificar email en WordPress
    const registrado = await emailRegistradoEnWordPress(email);
    if (!registrado) {
      console.warn('🚫 [crear-sesion-entrada] Email no registrado en WP:', email);
      return res.status(403).json({ error: 'El email no está registrado como usuario.' });
    }

    // Recoger asistentes
    const metadataAsistentes = {};
    for (let i = 1; i <= totalAsistentes; i++) {
      metadataAsistentes[`asistente_${i}_nombre`] = datos[`asistente_${i}_nombre`] || '';
      metadataAsistentes[`asistente_${i}_apellidos`] = datos[`asistente_${i}_apellidos`] || '';
    }

    // Crear sesión de Stripe
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  payment_method_types: ['card'],
  customer_email: email,
  line_items: [{
    quantity: totalAsistentes,
    price_data: {
      currency: 'eur',
      unit_amount: 1500, // 15,00 €
      product_data: {
        name: nombreProducto,
        description: descripcionProducto,
        images: [imagenStripe]
      }
    }
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
    direccionEvento,
    imagenEvento: imagenPDF,
    fechaActuacion,
    formularioId,
    totalAsistentes: String(totalAsistentes),
    ...metadataAsistentes
  }
});


    console.log('✅ Sesión Stripe creada correctamente:\n', session.url);
    res.json({ url: session.url });

  } catch (err) {
    console.error('❌ Error creando sesión de entrada:', err.message || err);
    res.status(500).json({ error: 'Error interno al crear la sesión de entrada.' });
  }
});

module.exports = router;
