if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

console.log('🧠 INDEX REAL EJECUTÁNDOSE');
console.log('🌍 NODE_ENV:', process.env.NODE_ENV);
console.log('🔑 STRIPE_SECRET_KEY presente:', !!process.env.STRIPE_SECRET_KEY);
console.log('🔐 STRIPE_WEBHOOK_SECRET presente:', !!process.env.STRIPE_WEBHOOK_SECRET);

const express = require('express');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const procesarCompra = require('./services/procesarCompra');
const { activarMembresiaClub } = require('./services/activarMembresiaClub');
const desactivarMembresiaClubHandler = require('./routes/desactivarMembresiaClub'); // ← NUEVO

const app = express();
app.set('trust proxy', 1);

const PRODUCTOS = {
  'de cara a la jubilacion': {
    nombre: 'De cara a la jubilación',
    precio: 2990,
    imagen: 'https://www.laboroteca.es/wp-content/uploads/2025/06/DE-CARA-A-LA-JUBILACION-IGNACIO-SOLSONA-ABOGADO-scaled.png',
    descripcion: 'Libro "De cara a la jubilación". Edición digital. Membresía vitalicia.'
  },
  'curso ip total': {
    nombre: 'Curso IP Total',
    precio: 7900,
    imagen: 'https://laboroteca.es/wp-content/uploads/2024/12/curso-ip-total-portada.png',
    descripcion: 'Curso online de Incapacidad Permanente Total. Acceso inmediato y materiales descargables.'
  },
  'pack libros': {
    nombre: 'Pack libros',
    precio: 4990,
    imagen: 'https://laboroteca.es/wp-content/uploads/2024/12/pack-libros-laboroteca.png',
    descripcion: 'Pack: "De cara a la jubilación" + "Jubilación anticipada". Edición digital. Membresía vitalicia.'
  },
  'el club laboroteca': {
    nombre: 'El Club Laboroteca',
    precio: 499,
    imagen: 'https://www.laboroteca.es/wp-content/uploads/2025/06/club-laboroteca-membresia-precio-sin-permanencia.webp',
    descripcion: 'Suscripción mensual a El Club Laboroteca. Acceso a contenido exclusivo.'
  }
};

function normalizarProducto(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .trim()
    .toLowerCase();
}

async function verificarEmailEnWordPress(email) {
  console.log('🔓 Verificación desactivada. Email:', email);
  return true;
}

const pagoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos. Inténtalo más tarde.' }
});

app.use(cors({
  origin: 'https://www.laboroteca.es',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') {
    express.raw({ type: 'application/json' })(req, res, next);
  } else {
    bodyParser.json()(req, res, next);
  }
});
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Página test
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'formulario.html'));
});

// Webhook Stripe
const webhookHandler = require('./routes/webhook');
app.post('/webhook', webhookHandler);

// Endpoint pago único
app.post('/crear-sesion-pago', pagoLimiter, async (req, res) => {
  const datos = req.body;
  console.log('📦 DATOS FORMULARIO:', JSON.stringify(datos, null, 2));

  const {
    nombre = '', apellidos = '', email = '', dni = '', direccion = '',
    ciudad = '', provincia = '', cp = '', tipoProducto = '', nombreProducto = ''
  } = datos;

  const key = normalizarProducto(nombreProducto);
  const producto = PRODUCTOS[key];

  if (!producto) {
    return res.status(400).json({ error: 'Producto no disponible.' });
  }

  if (!nombre || !email) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  const emailValido = await verificarEmailEnWordPress(email);
  if (!emailValido) {
    return res.status(403).json({ error: 'Este email no está registrado.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_creation: 'always',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `${tipoProducto} "${producto.nombre}"`,
            images: [producto.imagen]
          },
          unit_amount: producto.precio
        },
        quantity: 1
      }],
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
        descripcionProducto: producto.descripcion
      },
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(producto.nombre)}`,
      cancel_url: 'https://laboroteca.es/error'
    });

    return res.json({ url: session.url });

  } catch (error) {
    console.error('❌ Error Stripe:', error.message);
    return res.status(500).json({ error: 'Error al crear la sesión de pago' });
  }
});

// Endpoint suscripción mensual
app.post('/crear-suscripcion-club', pagoLimiter, async (req, res) => {
  const datos = req.body;
  console.log('📦 DATOS SUSCRIPCIÓN CLUB:', JSON.stringify(datos, null, 2));

  const {
    nombre = '', apellidos = '', email = '', dni = '', direccion = '',
    ciudad = '', provincia = '', cp = '', tipoProducto = '', nombreProducto = ''
  } = datos;

  const key = normalizarProducto(nombreProducto);
  const producto = PRODUCTOS[key];

  if (!producto) {
    return res.status(400).json({ error: 'Producto no disponible.' });
  }

  if (!nombre || !email) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  const emailValido = await verificarEmailEnWordPress(email);
  if (!emailValido) {
    return res.status(403).json({ error: 'Este email no está registrado.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'eur',
          recurring: { interval: 'month' },
          product_data: {
            name: producto.nombre,
            images: [producto.imagen]
          },
          unit_amount: producto.precio
        },
        quantity: 1
      }],
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
        descripcionProducto: producto.descripcion
      },
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(producto.nombre)}`,
      cancel_url: 'https://laboroteca.es/error'
    });

    return res.json({ url: session.url });

  } catch (error) {
    console.error('❌ Error Stripe suscripción:', error.message);
    return res.status(500).json({ error: 'Error al crear la suscripción' });
  }
});

// Activar membresía manual
app.post('/activar-membresia-club', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Falta el email' });

  try {
    await activarMembresiaClub(email);
    return res.json({ ok: true });
  } catch (error) {
    console.error('❌ Error activar membresía:', error.message);
    return res.status(500).json({ error: 'Error al activar la membresía' });
  }
});

// Desactivar membresía manual (BAJA)
app.post('/desactivar-membresia-club', desactivarMembresiaClubHandler);

// Lanzar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend funcionando en http://localhost:${PORT}`);
});
