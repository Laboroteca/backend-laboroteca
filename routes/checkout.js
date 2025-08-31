// routes/checkout.js
// 
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

const { normalizar } = require('../utils/normalizar');
const { emailRegistradoEnWordPress } = require('../utils/wordpress');
const PRODUCTOS = require('../utils/productos');
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

    isSuscripcion = tipoProducto.toLowerCase().includes('suscrip');
    esEntrada = tipoProducto.toLowerCase() === 'entrada';
    totalAsistentes = parseInt(datos.totalAsistentes) || 1;

    const producto = esEntrada
      ? PRODUCTOS['entrada evento']
      : PRODUCTOS[normalizar(nombreProducto)];

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

    const importeFinalCents = esEntrada
      ? Math.round((importeFormulario || 0) * 100) * totalAsistentes
      : Math.round((importeFormulario || PRODUCTOS[normalizar(nombreProducto)].precio_cents / 100) * 100);

    const line_items = isSuscripcion
      ? [{
          price: PRODUCTOS[normalizar(nombreProducto)].price_id,
          quantity: 1
        }]
      : esEntrada
        ? [{
            price: PRODUCTOS[normalizar(nombreProducto)].price_id,
            quantity: totalAsistentes
          }]
        : [{
            price_data: {
              currency: 'eur',
              unit_amount: importeFinalCents,
              product_data: {
                name: PRODUCTOS[normalizar(nombreProducto)].nombre,
                description: descripcionFormulario || PRODUCTOS[normalizar(nombreProducto)].descripcion,
                images: imagenFormulario ? [imagenFormulario] : [PRODUCTOS[normalizar(nombreProducto)].imagen]
              }
            },
            quantity: 1
          }];

    console.log('🧪 tipoProducto:', tipoProducto);
    console.log('🧪 esEntrada:', esEntrada);
    console.log('🧪 totalAsistentes:', totalAsistentes);
    console.log('🧪 importeFormulario:', importeFormulario);
    console.log('🧪 producto:', PRODUCTOS[normalizar(nombreProducto)]);

    const session = await stripe.checkout.sessions.create({
      mode: isSuscripcion ? 'subscription' : 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items,
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(PRODUCTOS[normalizar(nombreProducto)].nombre)}`,
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
        nombreProducto: PRODUCTOS[normalizar(nombreProducto)].nombre,
        descripcionProducto: (datos.descripcionProducto || PRODUCTOS[normalizar(nombreProducto)].descripcion || `${tipoProducto} "${PRODUCTOS[normalizar(nombreProducto)].nombre}"`).trim(),
        importe: (importeFormulario || 0).toFixed(2),
        totalAsistentes: totalAsistentes.toString(),
        esPrimeraCompra: isSuscripcion ? 'true' : 'false'
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
