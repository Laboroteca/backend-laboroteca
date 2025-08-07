const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { emailRegistradoEnWordPress } = require('../utils/wordpress');
const PRODUCTOS = require('../../utils/productos');

const router = express.Router();
const URL_IMAGEN_DEFAULT = 'https://www.laboroteca.es/wp-content/uploads/2025/07/ENTRADAS-LABOROTECA-scaled.webp';

router.post('/crear-sesion-entrada', async (req, res) => {
  try {
    const datos = req.body;
    console.log('📥 Datos crudos recibidos:\n', JSON.stringify(datos, null, 2));

    // 🧍 Datos del comprador
    const nombre = (datos.nombre || '').trim();
    const apellidos = (datos.apellidos || '').trim();
    const email = (datos.email || '').trim().toLowerCase();
    const dni = (datos.dni || '').trim();
    const direccion = (datos.direccion || '').trim();
    const ciudad = (datos.ciudad || '').trim();
    const provincia = (datos.provincia || '').trim();
    const cp = (datos.cp || '').trim();

    // 🎟️ Datos del evento
    const tipoProducto = (datos.tipoProducto || '').trim();
    const nombreProducto = (datos.nombreProducto || '').trim();
    const descripcionProducto = (datos.descripcionProducto || `Entrada "${nombreProducto}"`).trim();
    const direccionEvento = (datos.direccionEvento || '').trim();
    const imagenPDF = (datos.imagenEvento || '').trim();
    const fechaActuacion = (datos.fechaActuacion || '').trim();
    const formularioId = (datos.formularioId || '').toString().trim();
    const imagenStripe = URL_IMAGEN_DEFAULT;

    // 🧮 Cálculo del precio
    const totalAsistentes = parseInt(String(datos.totalAsistentes || '').trim());
    if (isNaN(totalAsistentes) || totalAsistentes < 1) {
      console.warn('⚠️ totalAsistentes inválido:', datos.totalAsistentes);
      return res.status(400).json({ error: 'Número de asistentes inválido.' });
    }
    const precioTotal = totalAsistentes * 1500;

    console.log('🧪 DEBUG PRECIO:', {
      totalAsistentes,
      precioTotalEnCentimos: precioTotal,
      precioUnitarioEuros: 15,
      tipoProducto,
      nombreProducto,
      descripcionProducto
    });

    // ✅ Validación de campos obligatorios
    if (
      !email || !nombre || !nombreProducto || !tipoProducto || !formularioId || !fechaActuacion
    ) {
      console.warn('⚠️ Faltan datos obligatorios.');
      return res.status(400).json({ error: 'Faltan datos obligatorios para crear la sesión.' });
    }

    // 🔐 Verificar email en WordPress
    const registrado = await emailRegistradoEnWordPress(email);
    if (!registrado) {
      console.warn('🚫 Email no registrado en WordPress:', email);
      return res.status(403).json({ error: 'El email no está registrado como usuario.' });
    }

    // 👥 Recoger asistentes
    const metadataAsistentes = {};
    for (let i = 1; i <= totalAsistentes; i++) {
      metadataAsistentes[`asistente_${i}_nombre`] = datos[`asistente_${i}_nombre`] || '';
      metadataAsistentes[`asistente_${i}_apellidos`] = datos[`asistente_${i}_apellidos`] || '';
    }

    // 💳 Crear sesión de Stripe
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{
        quantity: totalAsistentes,
        price_data: {
          currency: 'eur',
          unit_amount: 1500,
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

    // ✅ Validación final
    if (!session?.url) {
      console.error('❌ Stripe no devolvió una URL válida');
      return res.status(500).json({ error: 'Stripe no devolvió una URL válida.' });
    }

    console.log('✅ Sesión Stripe creada correctamente:', session.url);
    return res.json({ url: session.url });

  } catch (err) {
    console.error('❌ Error creando sesión de entrada:', err.message || err);
    return res.status(500).json({ error: err.message || 'Error interno al crear la sesión de entrada.' });
  }
});

module.exports = router;
