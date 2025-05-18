require('dotenv').config();
console.log('🧠 INDEX REAL EJECUTÁNDOSE');

const express = require('express');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const rateLimit = require('express-rate-limit'); // 🆕 Rate limiting

const app = express();

// 🔐 Función para verificar si el email está registrado en WordPress
async function verificarEmailEnWordPress(email) {
  const usuario = 'ignacio'; // ← Tu usuario WP
  const claveApp = 'anKUsIXl31BsVZAaPSyepBRC'; // ← Tu clave (sin espacios)
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

// 🆕 Limitador: 5 intentos cada 15 minutos por IP
const pagoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    error: 'Demasiados intentos. Por favor, inténtalo más tarde.'
  }
});

// ✅ 1. Habilitar CORS
app.use(cors());

// ✅ 2. Webhook de Stripe
const webhookHandler = require('./routes/webhook');
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => webhookHandler(req, res)
);

// ✅ 3. bodyParser
app.use(bodyParser.json());

// ✅ 4. Servir formulario estático (solo en local)
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'formulario.html'));
});

// ✅ 5. Crear sesión de pago con verificación de email y limitador
app.post('/crear-sesion-pago', pagoLimiter, async (req, res) => {
  const datos = req.body;
  console.log('📦 Datos recibidos del formulario:', datos);

  // 🔐 Verificar si el email está registrado en WordPress
  const emailValido = await verificarEmailEnWordPress(datos.email);
  if (!emailValido) {
    console.warn('🚫 Email no registrado en WordPress:', datos.email);
    return res.status(403).json({ error: 'Este email no está registrado. Debes crear una cuenta primero.' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price: 'price_1RMG0mEe6Cd77jenTtn9xlB7',
          quantity: 1
        }
      ],
      customer_creation: 'always',
      customer_email: datos.email,
      metadata: {
        nombre: datos.nombre || '',
        apellidos: datos.apellidos || '',
        dni: datos.dni || '',
        direccion: datos.direccion || '',
        ciudad: datos.ciudad || '',
        provincia: datos.provincia || '',
        cp: datos.cp || '',
        tipoProducto: 'libro',
        nombreProducto: 'De cara a la jubilación'
      },
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(datos.nombre || '')}&producto=${encodeURIComponent('De cara a la jubilación')}`,
      cancel_url: 'https://laboroteca.es/error'
    });

    console.log('🧾 Sesión Stripe creada:', session.id);
    res.json({ url: session.url });

  } catch (error) {
    console.error('❌ Error creando sesión de pago:', error.message);
    res.status(500).json({ error: 'Error al crear la sesión de pago' });
  }
});

// ✅ 6. Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend funcionando en http://localhost:${PORT}`);
});
