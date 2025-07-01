const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { normalizar } = require('../utils/normalizar');
const { emailRegistradoEnWordPress } = require('../utils/wordpress');
const express = require('express');
const router = express.Router();

// 🧠 Mapa de productos
const PRODUCTOS = {
  'de cara a la jubilacion': {
    nombre: 'De cara a la jubilación',
    slug: 'de-cara-a-la-jubilacion',
    descripcion: 'Libro digital con acceso vitalicio',
    price_id: 'price_1RMG0mEe6Cd77jenTpudZVan'
  },
  'el club laboroteca': {
    nombre: 'El Club Laboroteca',
    slug: 'el-club-laboroteca',
    descripcion: 'Suscripción mensual a El Club Laboroteca. Acceso a contenido exclusivo.',
    price_id: 'price_1RfHeAEe6Cd77jenDw9UUPCp'
  }
};

router.post('/create-session', async (req, res) => {
  try {
    // Soporte para body plano y body anidado
    const datos = req.body.email ? req.body : Object.values(req.body)[0];

    // Extraer datos asegurando siempre strings limpias
    const nombre = String(datos.nombre || datos.Nombre || '').trim();
    const apellidos = String(datos.apellidos || datos.Apellidos || '').trim();
    const email = String(datos.email || '').trim().toLowerCase();
    const dni = String(datos.dni || '').trim();
    const direccion = String(datos.direccion || '').trim();
    const ciudad = String(datos.ciudad || '').trim();
    const provincia = String(datos.provincia || '').trim();
    const cp = String(datos.cp || '').trim();
    const tipoProducto = String(datos.tipoProducto || '').trim();
    const nombreProducto = String(datos.nombreProducto || '').trim();

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

    // Validar email mínimo (regex sencilla)
    if (!/^[\w\.\-]+@[\w\.\-]+\.\w+$/.test(email)) {
      console.warn('⚠️ Email no válido:', email);
      return res.status(400).json({ error: 'Email no válido.' });
    }

    const registrado = await emailRegistradoEnWordPress(email);
    if (!registrado) {
      console.warn('🚫 Email no registrado en WP:', email);
      return res.status(403).json({ error: 'El email no está registrado como usuario.' });
    }

    const isSuscripcion = tipoProducto.toLowerCase().includes('suscrip');

    const session = await stripe.checkout.sessions.create({
      mode: isSuscripcion ? 'subscription' : 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{
        price: producto.price_id,
        quantity: 1
      }],
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(producto.nombre)}`,
      cancel_url: 'https://laboroteca.es/error',
      metadata: {
        nombre,
        apellidos,
        email, // SIEMPRE email real aquí
        dni,
        direccion,
        ciudad,
        provincia,
        cp,
        tipoProducto,
        nombreProducto: producto.nombre,
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

