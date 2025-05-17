require('dotenv').config();
console.log('🧠 INDEX REAL EJECUTÁNDOSE');

const express = require('express');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const path = require('path');

const app = express();

// ✅ 1. Habilitar CORS (podrás ajustar 'origin' si usas Railway)
app.use(cors());

// ✅ 2. Webhook de Stripe (se procesa antes de bodyParser.json)
const webhookHandler = require('./routes/webhook');
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => webhookHandler(req, res)
);

// ✅ 3. bodyParser para el resto de rutas
app.use(bodyParser.json());

// ✅ 4. Servir formulario estático para pruebas locales
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'formulario.html'));
});

// ✅ 5. Crear sesión de pago con Stripe
app.post('/crear-sesion-pago', async (req, res) => {
  const datos = req.body;
  console.log('📦 Datos recibidos del formulario:', datos);

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
