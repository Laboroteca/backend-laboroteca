// routes/checkout.js
// 
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

const { normalizar } = require('../utils/normalizar'); // (solo para logs en catch)
const { emailRegistradoEnWordPress } = require('../utils/wordpress');
const { PRODUCTOS: CATALOGO, resolverProducto } = require('../utils/productos');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

router.post('/create-session', async (req, res) => {
  // Vars para meta en alertas del catch final (no afectan al flujo)
  let email, tipoProducto, nombreProducto, importeFormulario;

  try {
    const body = req.body;
    const datos = typeof body === 'object' && (body.email || body.email_autorelleno || body.nombre)
      ? body
      : (Object.values(body)[0] || {});

    const nombre = (datos.nombre || datos.Nombre || '').trim();
    const apellidos = (datos.apellidos || datos.Apellidos || '').trim();
    email = (datos.email_autorelleno || datos.email || '').trim().toLowerCase();
    const dni = (datos.dni || '').trim();
    const direccion = (datos.direccion || '').trim();
    const ciudad = (datos.ciudad || '').trim();
    const provincia = (datos.provincia || '').trim();
    const cp = (datos.cp || '').trim();
    tipoProducto = (datos.tipoProducto || '').trim();
    nombreProducto = (datos.nombreProducto || '').trim();
    const descripcionFormulario = (datos.descripcionProducto || '').trim();
    const imagenFormulario = (datos.imagenProducto || '').trim();
    importeFormulario = parseFloat((datos.importe || '').toString().replace(',', '.'));

    // Resolver solo productos de pago ÚNICO (no entradas, no suscripciones)
    const producto = resolverProducto({
      tipoProducto,
      nombreProducto,
      descripcionProducto: descripcionFormulario,
      price_id: datos.price_id
    });

    console.log('📩 [create-session] Solicitud recibida:', {
      nombre, apellidos, email, dni, direccion,
      ciudad, provincia, cp, tipoProducto, nombreProducto
    });

    if (
      !email ||
      typeof email !== 'string' ||
      !email.includes('@') ||
      email === 'email' ||
      !nombre ||
      !nombreProducto ||
      !tipoProducto ||
      !producto ||
      producto.es_recurrente === true // solo pago único
    ) {
      console.warn('⚠️ [create-session] Faltan datos obligatorios o producto inválido.', {
        nombre, email, nombreProducto, tipoProducto, productoSlug: producto?.slug || null
      });

      // 🔔 Aviso admin (validación 400)
      try {
        await alertAdmin({
          area: 'checkout_validacion',
          email: email || '-',
          err: new Error('Faltan datos obligatorios o producto no válido'),
          meta: {
            nombre, apellidos, email, dni, direccion, ciudad, provincia, cp,
            tipoProducto, nombreProducto,
            productoEncontrado: !!producto
          }
        });
      } catch (_) { /* no-op */ }

      return res.status(400).json({ error: 'Faltan datos obligatorios o producto no válido.' });
    }

    const registrado = await emailRegistradoEnWordPress(email);
    if (!registrado) {
      console.warn('🚫 [create-session] Email no registrado en WP:', email);

      // 🔔 Aviso admin (403)
      try {
        await alertAdmin({
          area: 'checkout_wp_email_no_registrado',
          email,
          err: new Error('Email no registrado en WordPress'),
          meta: { tipoProducto, nombreProducto }
        });
      } catch (_) { /* no-op */ }

      return res.status(403).json({ error: 'El email no está registrado como usuario.' });
    }

    const importeFinalCents = Number.isFinite(importeFormulario)
      ? Math.round(importeFormulario * 100)
      : (Number(producto?.precio_cents) || 0);

    const line_items = [{
      price_data: {
        currency: 'eur',
        unit_amount: importeFinalCents,
        product_data: {
          name: producto.nombre,
          description: descripcionFormulario || producto.descripcion,
          images: (imagenFormulario || producto.imagen) ? [ (imagenFormulario || producto.imagen) ] : []
        }
      },
      quantity: 1
    }];

    console.log('🧪 tipoProducto:', tipoProducto);
    console.log('🧪 importeFormulario:', importeFormulario);
    console.log('🧪 producto:', producto?.slug, '→', producto?.nombre);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items,
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(producto.nombre)}`,
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
        nombreProducto: producto.nombre,
        descripcionProducto: (datos.descripcionProducto || producto.descripcion || `${tipoProducto} "${producto.nombre}"`).trim(),
        importe: ((importeFinalCents || 0) / 100).toFixed(2)
      }
    });

    console.log('✅ [create-session] Sesión Stripe creada:', session.url);
    res.json({ url: session.url });

  } catch (err) {
    console.error('❌ [create-session] Error creando sesión de pago:', err?.message || err);

    // 🔔 Aviso admin (500)
    try {
      const raw = req?.body || {};
      await alertAdmin({
        area: 'checkout_create_session_error',
        email: (raw.email_autorelleno || raw.email || email || '-'),
        err,
        meta: {
          tipoProducto: tipoProducto || raw.tipoProducto || null,
          nombreProducto: nombreProducto || raw.nombreProducto || null,
          importeFormulario: importeFormulario || raw.importe || null,
          productoKey: nombreProducto ? normalizar(nombreProducto) : (raw.nombreProducto ? normalizar(raw.nombreProducto) : null),
          rawBodyType: typeof raw
        }
      });
    } catch (_) { /* no-op */ }

    return res.status(500).json({ error: 'Error interno al crear la sesión' });
  }
});

module.exports = router;
