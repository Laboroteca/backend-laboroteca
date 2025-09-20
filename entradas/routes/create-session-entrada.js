// entradas/routes/create-session-entrada.js
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
// Verificación WP opcional (solo si STRICT=1)
const { emailRegistradoEnWordPress } = require('../utils/wordpress');
const WP_CHECK_STRICT = String(process.env.LAB_WP_CHECK_STRICT || '0') === '1';
// const PRODUCTOS = require('../../utils/productos'); // (no usado)
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

const router = express.Router();
const URL_IMAGEN_DEFAULT = 'https://www.laboroteca.es/wp-content/uploads/2025/08/logo-entradas-laboroteca-scaled.webp';

// ——— utilidades locales (para logs, no para alertas) ———
const maskEmail = (e) => {
  if (!e || typeof e !== 'string') return '';
  const [u, d] = e.split('@');
  const uh = (u || '').slice(0, 2);
  return `${uh}***@***.${(d || '').split('.').pop() || ''}`;
};
const safeLogMeta = ({ totalAsistentes, tipoProducto, nombreProducto, formularioId, fechaActuacion }) => ({
  totalAsistentes, tipoProducto, nombreProducto, formularioId, fechaActuacion
});


router.post('/crear-sesion-entrada', async (req, res) => {
  try {
    const datos = req.body;
    // Log seguro (sin PII)
    console.log('📥 crear-sesion-entrada', safeLogMeta({
      totalAsistentes: datos?.totalAsistentes,
      tipoProducto: datos?.tipoProducto,
      nombreProducto: datos?.nombreProducto,
      formularioId: datos?.formularioId,
      fechaActuacion: datos?.fechaActuacion
    }));

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
    const descripcionProducto = String(datos.descripcionProducto || '').trim();
    const direccionEvento = (datos.direccionEvento || '').trim();
    const imagenPDF = (datos.imagenEvento || '').trim();
    const fechaActuacion = (datos.fechaActuacion || '').trim();
    const formularioId = (datos.formularioId || '').toString().trim();
    const imagenStripe = URL_IMAGEN_DEFAULT;

    // 🧮 Cálculo del precio
    const totalAsistentes = parseInt(String(datos.totalAsistentes || '').trim(), 10);
    if (isNaN(totalAsistentes) || totalAsistentes < 1) {
      console.warn('⚠️ totalAsistentes inválido:', datos.totalAsistentes);
      try {
        await alertAdmin({
          area: 'entradas.checkout.validacion',
          email,
          err: new Error('totalAsistentes inválido'),
          meta: { totalAsistentes: datos.totalAsistentes, tipoProducto, nombreProducto, formularioId }
        });
      } catch (_) {}
      return res.status(400).json({ error: 'Número de asistentes inválido.' });
    }
    const precioTotal = totalAsistentes * 1500;

    console.log('🧪 Precio entradas:', { totalAsistentes, precioTotalEnCentimos: precioTotal, precioUnitarioEuros: 15 });

    // ✅ Validación de campos obligatorios
    if (
      !email || !nombre || !nombreProducto || !tipoProducto || !formularioId || !fechaActuacion
    ) {
      console.warn('⚠️ Faltan datos obligatorios.');
      try {
        await alertAdmin({
          area: 'entradas.checkout.validacion',
          email, // email completo para admin
          err: new Error('Faltan datos obligatorios'),
          meta: { nombre, nombreProducto, tipoProducto, formularioId, fechaActuacion, campos: Object.keys(datos || {}) }
        });
      } catch (_) {}
      return res.status(400).json({ error: 'Faltan datos obligatorios para crear la sesión.' });
    }

    // 🔎 Validación estricta de descripción (factura no ambigua)
    if (!descripcionProducto || /^entrada\s*$/i.test(descripcionProducto)) {
      return res.status(400).json({ error: 'Descripción de producto inválida. Debe ser concreta para la factura.' });
    }

    // 🔐 (Opcional) Verificación en WordPress
    if (WP_CHECK_STRICT) {
      const registrado = await emailRegistradoEnWordPress(email);
      if (!registrado) {
        console.warn('🚫 Email no registrado en WordPress (STRICT=1):', email);
        try {
          await alertAdmin({
            area: 'entradas.checkout.wp',
            email,
            err: new Error('Email no registrado en WordPress'),
            meta: { formularioId, tipoProducto, nombreProducto, strict: true }
          });
        } catch (_) {}
        return res.status(403).json({ error: 'El email no está registrado como usuario.' });
      }
    } else {
      // En modo no estricto NO bloqueamos (email viene del usuario logueado/autorrelleno)
      console.log('ℹ️ Verificación WP omitida (LAB_WP_CHECK_STRICT=0):', email);
    }

    // 👥 Recoger asistentes
    const metadataAsistentes = {};
    for (let i = 1; i <= totalAsistentes; i++) {
      const nom = String(datos[`asistente_${i}_nombre`] || '').trim();
      const ape = String(datos[`asistente_${i}_apellidos`] || '').trim();
      if (!nom || !ape) {
        return res.status(400).json({ error: `Faltan datos del asistente ${i}.` });
      }
      metadataAsistentes[`asistente_${i}_nombre`] = nom;
      metadataAsistentes[`asistente_${i}_apellidos`] = ape;
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
      // Evitar PII en URL; el frontend puede leer la sesión por {CHECKOUT_SESSION_ID}
      success_url: 'https://laboroteca.es/gracias?ok=1&sid={CHECKOUT_SESSION_ID}',
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
      try {
        await alertAdmin({
          area: 'entradas.checkout.stripe',
          email, // email completo para admin
          err: new Error('Stripe no devolvió URL'),
          meta: { totalAsistentes, precioTotal, tipoProducto, nombreProducto, formularioId }
        });
      } catch (_) {}
      return res.status(500).json({ error: 'Stripe no devolvió una URL válida.' });
    }

    console.log('✅ Sesión Stripe creada:', { sid: (session.id || '').slice(0,12) + '…' });
    return res.json({ url: session.url });

  } catch (err) {
    console.error('❌ Error creando sesión de entrada:', err.message || err);
    try {
      await alertAdmin({
        area: 'entradas.checkout.route',
        email: String(req?.body?.email || '-').toLowerCase(),
        err,
        meta: {
          tipoProducto: String(req?.body?.tipoProducto || ''),
          nombreProducto: String(req?.body?.nombreProducto || ''),
          formularioId: String(req?.body?.formularioId || '')
        }
      });
    } catch (_) {}
    return res.status(500).json({ error: err.message || 'Error interno al crear la sesión de entrada.' });
  }
});

module.exports = router;
