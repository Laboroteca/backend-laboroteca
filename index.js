// Carga de variables de entorno (en local)
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

const app = express();
app.set('trust proxy', 1);

// 🧠 Mapa de productos
const PRODUCTOS = {
  'de cara a la jubilacion': {
    nombre: 'De cara a la jubilación',
    precio: 2990,
    imagen: 'https://laboroteca.es/wp-content/uploads/2024/12/libro-jubilacion-portada-laboroteca.png'
  },
  'curso ip total': {
    nombre: 'Curso IP Total',
    precio: 7900,
    imagen: 'https://laboroteca.es/wp-content/uploads/2024/12/curso-ip-total-portada.png'
  },
  'pack libros': {
    nombre: 'Pack libros',
    precio: 4990,
    imagen: 'https://laboroteca.es/wp-content/uploads/2024/12/pack-libros-laboroteca.png'
  }
};

// Normalizador
function normalizarProducto(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .trim()
    .toLowerCase();
}

// Email dummy checker
async function verificarEmailEnWordPress(email) {
  console.log('🔓 Verificación desactivada. Email:', email);
  return true;
}

// Límite de intentos
const pagoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos. Inténtalo más tarde.' }
});

app.use(cors());
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

// Webhook
const webhookHandler = require('./routes/webhook');
app.post('/webhook', webhookHandler);

// Crear sesión Stripe
app.post('/crear-sesion-pago', pagoLimiter, async (req, res) => {
  const datos = req.body;
  console.log('📦 DATOS FORMULARIO:', JSON.stringify(datos, null, 2));

  // Captura de campos con distintas mayúsculas/minúsculas
  const nombre = datos.nombre || datos.Nombre || '';
  const apellidos = datos.apellidos || datos.Apellidos || '';
  const email = datos.email || '';
  const dni = datos.dni || '';
  const direccion = datos.direccion || '';
  const ciudad = datos.ciudad || '';
  const provincia = datos.provincia || '';
  const cp = datos.cp || '';
  const tipoProducto = datos.tipoProducto || 'Producto';
  const nombreProducto = datos.nombreProducto || '';

  const key = normalizarProducto(nombreProducto);
  const producto = PRODUCTOS[key];

  if (!producto) {
    console.warn('⚠️ Producto no encontrado:', key);
    return res.status(400).json({ error: 'Producto no disponible.' });
  }

  if (!nombre || !email) {
    console.warn('⚠️ Faltan nombre o email');
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  const emailValido = await verificarEmailEnWordPress(email);
  if (!emailValido) {
    console.warn('🚫 Email no válido:', email);
    return res.status(403).json({ error: 'Este email no está registrado.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
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
      customer_creation: 'always',
      customer_email: email,
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
        nombreProducto: producto.nombre
      },
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(producto.nombre)}`,
      cancel_url: 'https://laboroteca.es/error'
    });

    console.log('✅ Sesión Stripe creada:', session.id);
    return res.json({ url: session.url });

  } catch (error) {
    console.error('❌ Error en Stripe:', error.message);
    return res.status(500).json({ error: 'Error al crear la sesión de pago' });
  }
});

// Lanzar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend funcionando en http://localhost:${PORT}`);
});
