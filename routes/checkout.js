const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch'); // Asegúrate de tenerlo instalado

// 🌐 API WordPress
const WP_URL = process.env.WP_URL; // e.g. https://laboroteca.es
const WP_USER = process.env.WP_USER;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;

// 🧠 Mapa de productos y precios
const PRECIO_PRODUCTO_MAP = {
  'De cara a la jubilación': 2990,
  'Curso IP Total': 7900,
  'Pack libros': 4990
};

// 🔄 Normaliza el body (en caso de estructura anidada como { "0": { ... } })
function extraerDatos(body) {
  return body.email ? body : Object.values(body)[0];
}

// 🧠 Normaliza el nombre del producto (interno, si quisieras usarlo en metadatos o rutas)
function normalizarProducto(nombre) {
  const mapa = {
    'De cara a la jubilación': 'libro_jubilacion',
    'Pack libros': 'libro_doble',
    'Curso IP Total': 'curso_ip_total'
  };
  return mapa[nombre] || null;
}

// 🔐 Verifica si el email está registrado en WordPress
async function emailRegistradoEnWordPress(email) {
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');

  const response = await fetch(`${WP_URL}/wp-json/wp/v2/users?search=${email}`, {
    headers: {
      Authorization: `Basic ${auth}`
    }
  });

  if (!response.ok) {
    console.error('❌ Error consultando WordPress:', await response.text());
    return false;
  }

  const users = await response.json();
  return users.some(user => user.email === email);
}

router.post('/create-session', async (req, res) => {
  try {
    const datos = extraerDatos(req.body);
    const {
      nombre,
      apellidos,
      email,
      dni,
      direccion,
      ciudad,
      provincia,
      cp,
      tipoProducto,
      nombreProducto
    } = datos;

    console.log('📦 Datos recibidos del formulario:', datos);
    console.log('🔎 nombreProducto normalizado:', nombreProducto);

    // 🚫 Verificación estricta del email
    const registrado = await emailRegistradoEnWordPress(email);
    if (!registrado) {
      console.warn('🚫 Email no registrado en WordPress:', email);
      return res.status(403).json({ error: 'El email no está registrado como usuario.' });
    }

    const precio = PRECIO_PRODUCTO_MAP[nombreProducto];
    if (!precio) {
      console.warn('⚠️ Producto no tiene precio configurado:', nombreProducto);
      return res.status(400).json({ error: 'Producto no disponible para la venta.' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `${tipoProducto} "${nombreProducto}"`,
          },
          unit_amount: precio,
        },
        quantity: 1
      }],
      success_url: 'https://laboroteca.es/success',
      cancel_url: 'https://laboroteca.es/cancel',
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
        nombreProducto: normalizarProducto(nombreProducto)
      }
    });

    console.log('✅ Sesión de Stripe creada:', session.url);
    res.json({ url: session.url });

  } catch (error) {
    console.error('❌ Error al crear la sesión:', error.message);
    res.status(500).send('Error al crear la sesión');
  }
});

module.exports = router;
