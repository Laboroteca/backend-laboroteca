if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

console.log('🧠 INDEX REAL EJECUTÁNDOSE');
console.log('🌍 NODE_ENV:', process.env.NODE_ENV);
console.log('🔑 STRIPE_SECRET_KEY presente:', !!process.env.STRIPE_SECRET_KEY);
console.log('🔐 STRIPE_WEBHOOK_SECRET presente:', !!process.env.STRIPE_WEBHOOK_SECRET);

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('❌ Falta STRIPE_SECRET_KEY en variables de entorno');
}

const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const procesarCompra = require('./services/procesarCompra');
const { activarMembresiaClub } = require('./services/activarMembresiaClub');
const { syncMemberpressClub } = require('./services/syncMemberpressClub');
const desactivarMembresiaClub = require('./services/desactivarMembresiaClub');

const app = express();
app.set('trust proxy', 1);

const corsOptions = {
  origin: 'https://www.laboroteca.es',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
};
app.use(cors(corsOptions));

// ⚠️ WEBHOOK: SIEMPRE EL PRIMERO Y EN RAW
app.use('/webhook', require('./routes/webhook')); // No poner .post aquí

// DESPUÉS DEL WEBHOOK, LOS BODY PARSERS
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const pagoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos. Inténtalo más tarde.' }
});

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

// ✅ Rutas

app.get('/', (req, res) => {
  res.send('✔️ API de Laboroteca activa');
});

// FLUJO PAGO ÚNICO (LIBRO, CURSO, ETC.)
app.post('/crear-sesion-pago', pagoLimiter, async (req, res) => {
  const datos = req.body;

  // Siempre priorizamos el email oculto (autorrelleno)
  const email = (typeof datos.email_autorelleno === 'string' && datos.email_autorelleno.includes('@'))
    ? datos.email_autorelleno.trim().toLowerCase()
    : (typeof datos.email === 'string' && datos.email.includes('@') ? datos.email.trim().toLowerCase() : '');

  const nombre = datos.nombre || datos.Nombre || '';
  const apellidos = datos.apellidos || datos.Apellidos || '';
  const dni = datos.dni || '';
  const direccion = datos.direccion || '';
  const ciudad = datos.ciudad || '';
  const provincia = datos.provincia || '';
  const cp = datos.cp || '';
  const tipoProducto = datos.tipoProducto || '';
  const nombreProducto = datos.nombreProducto || '';

  const key = normalizarProducto(nombreProducto);
  const producto = PRODUCTOS[key];

  if (!producto || !nombre || !email) {
    return res.status(400).json({ error: 'Faltan campos obligatorios o producto no disponible.' });
  }

  // El login previo ya garantiza el email, pero añadimos validación extra
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    console.warn('❌ Email inválido antes de Stripe:', email);
    return res.status(400).json({ error: 'Email inválido' });
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
        nombre, apellidos, email, email_autorelleno: email, dni, direccion, ciudad, provincia, cp,
        tipoProducto, nombreProducto: producto.nombre,
        descripcionProducto: producto.descripcion
      },
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(producto.nombre)}`,
      cancel_url: 'https://laboroteca.es/error'
    });

    return res.json({ url: session.url });

  } catch (error) {
    console.error('❌ Error Stripe (crear-sesion-pago):', error.message);
    return res.status(500).json({ error: 'Error al crear la sesión de pago' });
  }
});

// FLUJO SUSCRIPCIÓN CLUB
app.post('/crear-suscripcion-club', pagoLimiter, async (req, res) => {
  const datos = req.body;

  const email = (typeof datos.email_autorelleno === 'string' && datos.email_autorelleno.includes('@'))
    ? datos.email_autorelleno.trim().toLowerCase()
    : (typeof datos.email === 'string' && datos.email.includes('@') ? datos.email.trim().toLowerCase() : '');

  const nombre = datos.nombre || datos.Nombre || '';
  const apellidos = datos.apellidos || datos.Apellidos || '';
  const dni = datos.dni || '';
  const direccion = datos.direccion || '';
  const ciudad = datos.ciudad || '';
  const provincia = datos.provincia || '';
  const cp = datos.cp || '';
  const tipoProducto = datos.tipoProducto || '';
  const nombreProducto = datos.nombreProducto || '';

  const key = normalizarProducto(nombreProducto);
  const producto = PRODUCTOS[key];

  if (!producto || !nombre || !email) {
    return res.status(400).json({ error: 'Faltan campos obligatorios o producto no disponible.' });
  }

  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    console.warn('❌ Email inválido antes de Stripe:', email);
    return res.status(400).json({ error: 'Email inválido' });
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
        nombre, apellidos, email, email_autorelleno: email, dni, direccion, ciudad, provincia, cp,
        tipoProducto, nombreProducto: producto.nombre,
        descripcionProducto: producto.descripcion
      },
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(producto.nombre)}`,
      cancel_url: 'https://laboroteca.es/error'
    });

    return res.json({ url: session.url });

  } catch (error) {
    console.error('❌ Error Stripe (crear-suscripcion-club):', error.message);
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

app.options('/cancelar-suscripcion-club', cors(corsOptions));
app.post('/cancelar-suscripcion-club', cors(corsOptions), async (req, res) => {
  const { email, password, token } = req.body;
  const tokenEsperado = 'bajaClub@2025!';

  if (token !== tokenEsperado) {
    return res.status(403).json({ cancelada: false, mensaje: 'Token inválido' });
  }

  if (!email || !password) {
    return res.status(400).json({ cancelada: false, mensaje: 'Faltan datos obligatorios' });
  }

  try {
    const resultado = await desactivarMembresiaClub(email, password);
    if (resultado.ok) {
      return res.json({ cancelada: true });
    } else {
      return res.status(400).json({ cancelada: false, mensaje: resultado.mensaje || 'No se pudo cancelar la suscripción.' });
    }
  } catch (error) {
    console.error('❌ Error al cancelar suscripción:', error.message);
    return res.status(500).json({ cancelada: false, mensaje: 'Error interno del servidor.' });
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

process.on('uncaughtException', err => {
  console.error('💥 uncaughtException:', err.message);
});
process.on('unhandledRejection', err => {
  console.error('💥 unhandledRejection:', err.message);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend funcionando en http://localhost:${PORT}`);
});
