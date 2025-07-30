const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { normalizar } = require('../utils/normalizar');
const { emailRegistradoEnWordPress } = require('../utils/wordpress');
const express = require('express');
const router = express.Router();

const PRODUCTOS = require('../utils/productos');

router.post('/create-session', async (req, res) => {
  try {
    const body = req.body;
    const datos = typeof body === 'object' && (body.email || body.email_autorelleno || body.nombre)
      ? body
      : (Object.values(body)[0] || {});

    const nombre = (datos.nombre || datos.Nombre || '').trim();
    const apellidos = (datos.apellidos || datos.Apellidos || '').trim();
    let email = (datos.email_autorelleno || datos.email || '').trim().toLowerCase();
    const dni = (datos.dni || '').trim();
    const direccion = (datos.direccion || '').trim();
    const ciudad = (datos.ciudad || '').trim();
    const provincia = (datos.provincia || '').trim();
    const cp = (datos.cp || '').trim();
    const tipoProducto = (datos.tipoProducto || '').trim();
    const nombreProducto = (datos.nombreProducto || '').trim();
    const descripcionFormulario = (datos.descripcionProducto || '').trim();
    const imagenFormulario = (datos.imagenProducto || '').trim();
    const importeFormulario = parseFloat((datos.importe || '').toString().replace(',', '.'));


    const esEntrada = tipoProducto.toLowerCase() === 'entrada';

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
      return res.status(400).json({ error: 'Faltan datos obligatorios o producto no válido.' });
    }

    const registrado = await emailRegistradoEnWordPress(email);
    if (!registrado) {
      console.warn('🚫 [create-session] Email no registrado en WP:', email);
      return res.status(403).json({ error: 'El email no está registrado como usuario.' });
    }

    const isSuscripcion = tipoProducto.toLowerCase().includes('suscrip');

    const esEntrada = tipoProducto.toLowerCase() === 'entrada';
    const totalAsistentes = parseInt(datos.totalAsistentes) || 1;
    const importeTotalEntrada = !isNaN(importeFormulario) ? (importeFormulario * totalAsistentes) : producto.precio_cents / 100;

    const line_items = isSuscripcion
      ? [{
          price: producto.price_id,
          quantity: 1
        }]
      : esEntrada
      ? [{
          price: producto.price_id,
          quantity: totalAsistentes
        }]

        : [{
            price_data: {
              currency: 'eur',
              unit_amount: !isNaN(importeFormulario) ? Math.round(importeFormulario * 100) : producto.precio_cents,
              product_data: {
                name: producto.nombre,
                description: descripcionFormulario || producto.descripcion,
                images: imagenFormulario ? [imagenFormulario] : [producto.imagen]
              }
            },
            quantity: 1
          }];

    const session = await stripe.checkout.sessions.create({
      mode: isSuscripcion ? 'subscription' : 'payment',
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
        importe: importeFormulario.toFixed(2),
        totalAsistentes: totalAsistentes.toString(),

        esPrimeraCompra: isSuscripcion ? 'true' : 'false'
      }
    });

    console.log('✅ [create-session] Sesión Stripe creada:', session.url);
    res.json({ url: session.url });

  } catch (err) {
    console.error('❌ [create-session] Error creando sesión de pago:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'Error interno al crear la sesión' });
  }
});

module.exports = router;
