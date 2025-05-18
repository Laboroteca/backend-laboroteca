require('dotenv').config();
console.log('🧠 INDEX REAL EJECUTÁNDOSE');

const express = require('express');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

// 🧠 Mapa de productos y precios en céntimos de euro
const PRECIO_PRODUCTO_MAP = {
  'De cara a la jubilación': 2990,
  'Curso IP Total': 7900,
  'Pack libros': 4990
};

// 🧼 Normaliza producto
function normalizarProducto(str) {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .trim()
    .toLowerCase();
}

// ❌ Verificación de email desactivada temporalmente
async function verificarEmailEnWordPress(email) {
  console.log('🔓 Verificación de email desactivada. Email recibido:', email);
  return true;
}

// 🆕 Limitador de peticiones
const pagoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos. Inténtalo más tarde.' }
});

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Página formulario
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'formulario.html'));
});

// Webhook de Stripe
const webhookHandler = require('./routes/webhook');
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => webhookHandler(req, res));

// Crear sesión de pago
app.post('/crear-sesion-pago', pagoLimiter, async (req, res) => {
  const datos = req.body;
  console.log('📦 DATOS FORMULARIO:', JSON.stringify(datos, null, 2));

  const {
    nombre,
    Nombre,
    apellidos,
    Apellidos,
    email,
    dni,
    direccion,
    ciudad,
    provincia,
    cp,
    CP,
    tipoProducto
  } = datos;

  const nombreProductoRaw = datos?.nombreProducto || '';
  const productoNormalizado = normalizarProducto(nombreProductoRaw);
  console.log('🔎 nombreProducto normalizado:', productoNormalizado);

  const claveProducto = Object.keys(PRECIO_PRODUCTO_MAP).find(p =>
    normalizarProducto(p) === productoNormalizado
  );

  if (!claveProducto) {
    console.warn('⚠️ Producto inválido:', productoNormalizado);
    return res.status(400).json({ error: 'Producto no disponible.' });
  }

  const precio = PRECIO_PRODUCTO_MAP[claveProducto];

  console.log('🔐 Email recibido:', email.trim().toLowerCase());
  const emailValido = await verificarEmailEnWordPress(email);
  if (!emailValido) {
    console.warn('🚫 Email no encontrado en WordPress:', email);
    return res.status(403).json({ error: 'Este email no está registrado. Crea una cuenta primero.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: { name: `${tipoProducto} "${claveProducto}"` },
            unit_amount: precio
          },
          quantity: 1
        }
      ],
      customer_creation: 'always',
      customer_email: email,
      metadata: {
        nombre: nombre || Nombre,
        apellidos: apellidos || Apellidos,
        email,
        dni,
        direccion,
        ciudad,
        provincia,
        cp: cp || CP,
        tipoProducto,
        nombreProducto: claveProducto
      },
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre || Nombre || '')}&producto=${encodeURIComponent(claveProducto || '')}`,
      cancel_url: 'https://laboroteca.es/error'
    });

    console.log('✅ Sesión Stripe creada:', session.id);
    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Error en Stripe:', error.message);
    res.status(500).json({ error: 'Error al crear la sesión de pago' });
  }
});

// Iniciar servidor
const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`✅ Backend funcionando en http://localhost:${PORT}`);
});
