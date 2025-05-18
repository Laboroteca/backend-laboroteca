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

// 🧠 Mapa de productos y precios en céntimos de euro
const PRECIO_PRODUCTO_MAP = {
  'De cara a la jubilacion': 2990,
  'Curso IP Total': 7900,
  'Pack libros': 4990
};

// 🔐 Verificación del email en WordPress
async function verificarEmailEnWordPress(email) {
  const usuario = 'ignacio';
  const claveApp = 'anKUsIXl31BsVZAaPSyepBRC';
  const auth = Buffer.from(`${usuario}:${claveApp}`).toString('base64');

  try {
    const response = await axios.get(
      `https://laboroteca.es/wp-json/wp/v2/users?search=${encodeURIComponent(email)}`,
      {
        headers: {
          'Authorization': `Basic ${auth}`
        }
      }
    );
    return response.data.length > 0;
  } catch (error) {
    console.error('❌ Error verificando email en WordPress:', error.message);
    return false;
  }
}

// 🆕 Limitador de peticiones
const pagoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    error: 'Demasiados intentos. Por favor, inténtalo más tarde.'
  }
});

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'formulario.html'));
});

// ✅ Webhook de Stripe
const webhookHandler = require('./routes/webhook');
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => webhookHandler(req, res)
);

// ✅ Crear sesión de pago
app.post('/crear-sesion-pago', pagoLimiter, async (req, res) => {
  const datos = req.body;
  console.log('📦 Datos recibidos del formulario:', datos);

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

  // ✨ Normaliza el nombre del producto
  const productoNormalizado = (nombreProducto || '').normalize('NFC').trim();
  const precio = PRECIO_PRODUCTO_MAP[productoNormalizado];

  if (!PRECIO_PRODUCTO_MAP.hasOwnProperty(productoNormalizado)) {
    console.warn('⚠️ Producto sin precio o mal escrito:', productoNormalizado);
    return res.status(400).json({ error: 'Producto no disponible para la venta.' });
  }

  // 🔐 Verificación estricta del email
  const emailValido = await verificarEmailEnWordPress(email);
  if (!emailValido) {
    console.warn('🚫 Email no registrado en WordPress:', email);
    return res.status(403).json({ error: 'Este email no está registrado. Debes crear una cuenta primero.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'eur',
            product_data: {
              name: `${tipoProducto} "${productoNormalizado}"`
            },
            unit_amount: precio
          },
          quantity: 1
        }
      ],
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
        nombreProducto: productoNormalizado
      },
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre || '')}&producto=${encodeURIComponent(productoNormalizado || '')}`,
      cancel_url: 'https://laboroteca.es/error'
    });

    console.log('🧾 Sesión Stripe creada:', session.id);
    res.json({ url: session.url });

  } catch (error) {
    console.error('❌ Error creando sesión de pago:', error.message);
    res.status(500).json({ error: 'Error al crear la sesión de pago' });
  }
});

// ✅ Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend funcionando en http://localhost:${PORT}`);
});
