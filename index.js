if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

console.log('🧠 INDEX REAL EJECUTÁNDOSE');
console.log('🌍 NODE_ENV:', process.env.NODE_ENV);
console.log('🔑 STRIPE_SECRET_KEY presente:', !!process.env.STRIPE_SECRET_KEY);
console.log('🔐 STRIPE_WEBHOOK_SECRET presente:', !!process.env.STRIPE_WEBHOOK_SECRET);

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const procesarCompra = require('./services/procesarCompra');
const { activarMembresiaClub } = require('./services/activarMembresiaClub');
const { desactivarMembresiaClub } = require('./services/desactivarMembresiaClub');
const { syncMemberpressClub } = require('./services/syncMemberpressClub');

const app = express();
app.set('trust proxy', 1);

// Productos disponibles
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

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rutas principales
app.get('/', (req, res) => {
  res.send('✔️ API de Laboroteca activa');
});

const webhookHandler = require('./routes/webhook');
app.post('/webhook', webhookHandler);

app.post('/crear-sesion-pago', pagoLimiter, async (req, res) => {
  const datos = req.body;
  const {
    nombre = '', apellidos = '', email = '', dni = '', direccion = '',
    ciudad = '', provincia = '', cp = '', tipoProducto = '', nombreProducto = ''
  } = datos;

  const key = normalizarProducto(nombreProducto);
  const producto = PRODUCTOS[key];

  if (!producto || !nombre || !email) {
    return res.status(400).json({ error: 'Faltan campos obligatorios o producto no disponible.' });
  }

  const emailValido = await verificarEmailEnWordPress(email);
  if (!emailValido) return res.status(403).json({ error: 'Este email no está registrado.' });

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
        nombre, apellidos, email, dni, direccion, ciudad, provincia, cp,
        tipoProducto, nombreProducto: producto.nombre,
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

app.post('/crear-suscripcion-club', pagoLimiter, async (req, res) => {
  const datos = req.body;
  const {
    nombre = '', apellidos = '', email = '', dni = '', direccion = '',
    ciudad = '', provincia = '', cp = '', tipoProducto = '', nombreProducto = ''
  } = datos;

  const key = normalizarProducto(nombreProducto);
  const producto = PRODUCTOS[key];

  if (!producto || !nombre || !email) {
    return res.status(400).json({ error: 'Faltan campos obligatorios o producto no disponible.' });
  }

  const emailValido = await verificarEmailEnWordPress(email);
  if (!emailValido) return res.status(403).json({ error: 'Este email no está registrado.' });

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
        nombre, apellidos, email, dni, direccion, ciudad, provincia, cp,
        tipoProducto, nombreProducto: producto.nombre,
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

app.post('/activar-membresia-club', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Falta el email' });

  try {
    await activarMembresiaClub(email);
    await syncMemberpressClub({ email, accion: 'activar' });
    return res.json({ ok: true });
  } catch (error) {
    console.error('❌ Error activar membresía:', error.message);
    return res.status(500).json({ error: 'Error al activar la membresía' });
  }
});

app.post('/desactivar-membresia-club', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Falta el email' });

  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (customers.data.length) {
      const customerId = customers.data[0].id;
      const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 });
      if (subs.data.length) {
        const subscriptionId = subs.data[0].id;
        await stripe.subscriptions.del(subscriptionId);
        console.log(`🛑 Suscripción ${subscriptionId} cancelada en Stripe para ${email}`);
      }
    }

    await desactivarMembresiaClub(email);
    await syncMemberpressClub({ email, accion: 'desactivar', membership_id: 10663 });
    return res.json({ ok: true });

  } catch (error) {
    console.error('❌ Error desactivar membresía:', error.message);
    return res.status(500).json({ error: 'Error al desactivar la membresía' });
  }
});

app.post('/crear-portal-cliente', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Falta el email' });

  try {
    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) return res.status(404).json({ error: 'No existe cliente Stripe para este email.' });

    const session = await stripe.billingPortal.sessions.create({
      customer: customers.data[0].id,
      return_url: 'https://www.laboroteca.es/mi-cuenta'
    });
    return res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Error creando portal cliente Stripe:', error.message);
    return res.status(500).json({ error: 'No se pudo crear el portal de cliente Stripe' });
  }
});

// Manejo de errores no controlados
process.on('uncaughtException', err => {
  console.error('💥 uncaughtException:', err);
});
process.on('unhandledRejection', err => {
  console.error('💥 unhandledRejection:', err);
});

// Puerto final
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`✅ Backend funcionando en http://localhost:${PORT}`);
  });
}
