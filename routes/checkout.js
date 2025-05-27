// 🔁 Requiere dotenv si no es producción
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

// 🌐 API WordPress
const WP_URL = process.env.WP_URL;
const WP_USER = process.env.WP_USER;
const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD;

// 📚 Mapa de productos
const PRODUCTOS = {
  'de cara a la jubilacion': {
    nombre: 'De cara a la jubilación',
    price_id: 'price_1RMG0mEe6Cd77jenTtn9xlB7',
    slug: 'libro_jubilacion',
    descripcion: 'Libro De cara a la jubilación. Edición digital. Membresía vitalicia.'
  },
  'curso ip total': {
    nombre: 'Curso IP Total',
    price_id: 'price_XXXXXXX', // Sustituye por el real
    slug: 'curso_ip_total',
    descripcion: 'Curso online de Incapacidad Permanente Total. Acceso inmediato y materiales descargables.'
  },
  'pack libros': {
    nombre: 'Pack libros',
    price_id: 'price_XXXXXXX', // Sustituye por el real
    slug: 'libro_doble',
    descripcion: 'Pack: "De cara a la jubilación" + "Jubilación anticipada". Edición digital. Membresía vitalicia.'
  }
};

// 🔄 Normaliza nombre de producto
function normalizar(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .trim()
    .toLowerCase();
}

// 🔐 Verifica si el email existe en WP
async function emailRegistradoEnWordPress(email) {
  const auth = Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64');
  try {
    const response = await fetch(`${WP_URL}/wp-json/wp/v2/users?search=${email}`, {
      headers: { Authorization: `Basic ${auth}` }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Error consultando WordPress:', errorText);
      return false;
    }

    const users = await response.json();
    return users.some(user => user.email.toLowerCase() === email.toLowerCase());
  } catch (err) {
    console.error('❌ Error de red al consultar WordPress:', err.message);
    return false;
  }
}

// 📦 Endpoint crear sesión Stripe
router.post('/create-session', async (req, res) => {
  try {
    const datos = req.body.email ? req.body : Object.values(req.body)[0];

    const nombre = datos.nombre || datos.Nombre || '';
    const apellidos = datos.apellidos || datos.Apellidos || '';
    const email = datos.email || '';
    const dni = datos.dni || '';
    const direccion = datos.direccion || '';
    const ciudad = datos.ciudad || '';
    const provincia = datos.provincia || '';
    const cp = datos.cp || '';
    const tipoProducto = datos.tipoProducto || '';
    const nombreProducto = datos.nombreProducto || '';

    const clave = normalizar(nombreProducto);
    const producto = PRODUCTOS[clave];

    console.log('📩 Solicitud recibida:', {
      nombre, apellidos, email, dni, direccion,
      ciudad, provincia, cp, tipoProducto, nombreProducto
    });

    if (!email || !nombre || !nombreProducto || !tipoProducto || !producto) {
      console.warn('⚠️ Faltan datos o producto inválido.');
      return res.status(400).json({ error: 'Faltan datos obligatorios o producto no válido.' });
    }

    const registrado = await emailRegistradoEnWordPress(email);
    if (!registrado) {
      console.warn('🚫 Email no registrado en WP:', email);
      return res.status(403).json({ error: 'El email no está registrado como usuario.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [
        {
          price: producto.price_id,
          quantity: 1
        }
      ],
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
        nombreProducto: producto.slug,
        descripcionProducto: producto.descripcion
      }
    });

    console.log('✅ Sesión Stripe creada:', session.url);
    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Error creando sesión de pago:', err.message);
    res.status(500).json({ error: 'Error interno al crear la sesión' });
  }
});

module.exports = router;
