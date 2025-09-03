// routes/checkout.js
// 
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

const { normalizar } = require('../utils/normalizar');
const { emailRegistradoEnWordPress } = require('../utils/wordpress');
// ⬇️ Importa el catálogo y utilidades correctas (antes se importaba mal)
const {
  PRODUCTOS,
  normalizarProducto: normalizarProductoCat,
  resolverProducto,
  getImagenProducto,
  DEFAULT_IMAGE
} = require('../utils/productos');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

router.post('/create-session', async (req, res) => {
  // ❌ Bloquear intentos de lanzar entradas por esta ruta
  if ((req.body?.tipoProducto || '').toLowerCase() === 'entrada') {
    console.warn('🚫 [create-session] Entrada bloqueada en checkout.js');

    // 🔔 Aviso admin (no bloquea respuesta)
    try {
      await alertAdmin({
        area: 'checkout_entrada_bloqueada',
        email: (req.body?.email_autorelleno || req.body?.email || '-'),
        err: new Error('Intento de procesar entradas por ruta no permitida'),
        meta: {
          tipoProducto: req.body?.tipoProducto || null,
          nombreProducto: req.body?.nombreProducto || null
        }
      });
    } catch (_) { /* no-op */ }

    return res.status(400).json({ error: 'Las entradas no se procesan por esta ruta.' });
  }

  // Vars para meta en alertas del catch final (no afectan al flujo)
  let email, tipoProducto, nombreProducto, esEntrada, isSuscripcion, totalAsistentes, importeFormulario;


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

    // 🔒 Este endpoint es SOLO para pago único
    isSuscripcion = tipoProducto.toLowerCase().includes('suscrip') || tipoProducto.toLowerCase().includes('club');
    esEntrada = tipoProducto.toLowerCase() === 'entrada';
    totalAsistentes = parseInt(datos.totalAsistentes) || 1;

    // ⛔ Redirige suscripciones al endpoint específico
    if (isSuscripcion) {
      return res.status(400).json({ error: 'Las suscripciones no se crean aquí. Usa /crear-suscripcion-club.' });
    }

    // 🧭 Resuelve el producto del catálogo (pago único)
    const productoResuelto =
      resolverProducto({ tipoProducto, nombreProducto, descripcionProducto: datos.descripcionProducto, price_id: datos.price_id }, []);
    const slug = productoResuelto?.slug || normalizarProductoCat(nombreProducto, tipoProducto);
    const producto = slug ? PRODUCTOS[slug] : null;

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
      !producto
    ) {
      console.warn('⚠️ [create-session] Faltan datos obligatorios o producto inválido.', {
        nombre, email, nombreProducto, tipoProducto, producto
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

    // 💶 Importe para pago único (catálogo MANDARÁ; el formulario queda de fallback)
    const precioCatalogoCents = Number.isFinite(Number(producto?.precio_cents)) ? Number(producto.precio_cents) : NaN;
    const importeFinalCents = Number.isFinite(precioCatalogoCents)
      ? precioCatalogoCents
      : (Number.isFinite(importeFormulario) && importeFormulario > 0 ? Math.round(importeFormulario * 100) : 0);
  
    
    // 🖼️ Imagen (formulario → catálogo → fallback global)
    const imagenCanon = (imagenFormulario || (slug ? getImagenProducto(slug) : (producto?.imagen || DEFAULT_IMAGE))).trim();

    // 💳 Línea de Stripe
    // Intentamos usar price_id del catálogo solo si es ACTIVO, NO recurrente y el Product de Stripe ya tiene imagen.
    let line_items;
    let usarPriceId = false;
    const candidatePriceId = String(producto?.price_id || '').trim();
    if (candidatePriceId.startsWith('price_')) {
      try {
        const pr = await stripe.prices.retrieve(candidatePriceId, { expand: ['product'] });
        const noRecurring = !pr?.recurring;
        const activo = !!pr?.active;
        const hasImages = Array.isArray(pr?.product?.images) && pr.product.images.length > 0;
        usarPriceId = !!(activo && noRecurring && hasImages);
        if (!usarPriceId) {
          console.warn('⚠️ price_id no usado (activo=%s, recurring=%s, hasImages=%s). Se fuerza price_data con imagen.',
            activo, !!pr?.recurring, hasImages);
        }
      } catch (e) {
        console.warn('⚠️ price_id inválido/inaccesible. Fallback a price_data:', candidatePriceId, e?.message || e);
      }
    }

    if (usarPriceId) {
      line_items = [{ price: candidatePriceId, quantity: 1 }];
    } else {
      line_items = [{
        price_data: {
          currency: 'eur',
          unit_amount: importeFinalCents,
          product_data: {
            name: producto?.nombre || nombreProducto,
            description: (descripcionFormulario || producto?.descripcion || '').trim(),
            images: imagenCanon ? [imagenCanon] : []
          }
        },
        quantity: 1
      }];
    }
    console.log('🧪 tipoProducto:', tipoProducto);
    console.log('🧪 esEntrada:', esEntrada);
    console.log('🧪 totalAsistentes:', totalAsistentes);
    console.log('🧪 importeFormulario:', importeFormulario);
    console.log('🧪 producto:', producto);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment', // 🔒 solo pago único en este endpoint
      payment_method_types: ['card'],
      customer_email: email,
      line_items,
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(producto?.nombre || nombreProducto)}`,
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
        tipoProducto,                             // p.ej. 'libro'
        // 🧾 Metadatos canónicos para el webhook
        nombreProducto: (producto?.nombre || nombreProducto),
        descripcionProducto: (datos.descripcionProducto || producto?.descripcion || `${tipoProducto} "${producto?.nombre || nombreProducto}"`).trim(),
        // 🔗 Ayudas de resolución
        price_id: producto?.price_id || '',
        slug: slug || '',
        memberpressId: String(producto?.membership_id || ''),
        tipoProductoCanon: producto?.tipo || tipoProducto || '',
        // Auditoría/compat
        importe: (Number.isFinite(importeFinalCents) ? (importeFinalCents / 100) : 0).toFixed(2),
        tipoProductoOriginal: tipoProducto,
        nombreProductoOriginal: nombreProducto
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
          esEntrada: typeof esEntrada === 'boolean' ? esEntrada : ((raw.tipoProducto || '').toLowerCase() === 'entrada'),
          isSuscripcion: typeof isSuscripcion === 'boolean' ? isSuscripcion : ((raw.tipoProducto || '').toLowerCase().includes('suscrip')),
          totalAsistentes: totalAsistentes || raw.totalAsistentes || null,
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
