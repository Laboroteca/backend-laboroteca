// /entradas/routes/create-session-entrada.js
// 

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { emailRegistradoEnWordPress } = require('../utils/wordpress');

const router = express.Router();
const URL_IMAGEN_DEFAULT = 'https://www.laboroteca.es/wp-content/uploads/2025/07/ENTRADAS-LABOROTECA-scaled.webp';

router.post('/crear-sesion-entrada', async (req, res) => {
  try {
    const datos = req.body;
    console.log('📥 Datos recibidos en /crear-sesion-entrada:', datos);

    // Campos del comprador
    const nombre = (datos.nombre || '').trim();
    const apellidos = (datos.apellidos || '').trim();
    const email = (datos.email || '').trim().toLowerCase();
    const dni = (datos.dni || '').trim();
    const direccion = (datos.direccion || '').trim();
    const ciudad = (datos.ciudad || '').trim();
    const provincia = (datos.provincia || '').trim();
    const cp = (datos.cp || '').trim(); // minúsculas, como en Fluent

    // Campos del producto/evento
    const tipoProducto = (datos.tipoProducto || '').trim();
    const nombreProducto = (datos.nombreProducto || '').trim();
    const descripcionProducto = (datos.descripcionProducto || `Entrada "${nombreProducto}"`).trim();
    const direccionEvento = (datos.direccionEvento || '').trim();
    const imagenPDF = (datos.imagenEvento || '').trim(); // Para el PDF
    const imagenStripe = URL_IMAGEN_DEFAULT; // Imagen fija para Stripe
    const fechaActuacion = (datos.fechaActuacion || '').trim();
    const formularioId = (datos.formularioId || '').toString().trim();

    const totalAsistentes = parseInt(datos.totalAsistentes || '0');
    const importeUnitario = parseFloat((datos.importe || '0').toString().replace(',', '.')) || 0;
    const precio = totalAsistentes * importeUnitario;

    console.log('🧾 Campos procesados:', {
      nombre, apellidos, email, nombreProducto, tipoProducto, descripcionProducto,
      direccionEvento, imagenPDF, fechaActuacion, formularioId, totalAsistentes, precio
    });

    // Validación de campos obligatorios
    if (!email || !nombre || !nombreProducto || !tipoProducto || !precio || !totalAsistentes || !formularioId || !fechaActuacion) {
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
          unit_amount: Math.round(precio * 100),
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

    console.log('✅ Sesión Stripe creada correctamente:', session.url);
    res.json({ url: session.url });

  } catch (err) {
    console.error('❌ Error creando sesión de entrada:', err.message || err);
    res.status(500).json({ error: 'Error interno al crear la sesión de entrada.' });
  }
});

module.exports = router;
