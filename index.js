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
const { eliminarUsuarioWordPress } = require('./services/eliminarUsuarioWordPress');
const procesarCompra = require('./services/procesarCompra');
const { activarMembresiaClub } = require('./services/activarMembresiaClub');
const { syncMemberpressClub } = require('./services/syncMemberpressClub');
const desactivarMembresiaClubForm = require('./routes/desactivarMembresiaClub');
const desactivarMembresiaClub = require('./services/desactivarMembresiaClub');
const { registrarBajaClub } = require('./services/registrarBajaClub');

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
app.use('/webhook', require('./routes/webhook'));

// DESPUÉS DEL WEBHOOK, LOS BODY PARSERS
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(require('./routes/solicitarEliminacionCuenta'));
app.use(require('./routes/confirmarEliminaciondecuenta'));

app.use('/entradas/crear', require('./entradas/routes/crearEntrada'));
app.use('/entradas/sesion', require('./entradas/routes/create-session-entrada'));


const pagoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos. Inténtalo más tarde.' }
});

// ✅ Usar la función correcta desde utils
const { normalizarProducto } = require('./utils/productos');

async function verificarEmailEnWordPress(email) {
  console.log('🔓 Verificación desactivada. Email:', email);
  return true;
}

app.get('/', (req, res) => {
  res.send('✔️ API de Laboroteca activa');
});


app.post('/crear-sesion-pago', pagoLimiter, async (req, res) => {
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
  const descripcionProducto = datos.descripcionProducto || '';
  const precio = parseFloat((datos.importe || '28').toString().replace(',', '.'));
  let imagenProducto = datos.imagenProducto || '';

  if (!imagenProducto && tipoProducto.toLowerCase() === 'entrada') {
    imagenProducto = 'https://www.laboroteca.es/wp-content/uploads/2025/07/ENTRADAS-LABOROTECA-scaled.webp';
  }

  // Si no hay imagen, no se pone
  if (!imagenProducto) {
    imagenProducto = '';
  }


  console.log('🧪 tipoProducto:', tipoProducto);
  console.log('🧪 nombreProducto:', nombreProducto);

  if (!nombre || !email || !nombreProducto || !precio || isNaN(precio)) {
    return res.status(400).json({ error: 'Faltan campos obligatorios o datos inválidos.' });
  }

  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    console.warn('❌ Email inválido antes de Stripe:', email);
    return res.status(400).json({ error: 'Email inválido' });
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
            name: `${tipoProducto} "${nombreProducto}"`,
            images: [imagenProducto]
          },
          unit_amount: Math.round(precio * 100)
        },
        quantity: 1
      }],
      metadata: {
        nombre,
        apellidos,
        email,
        email_autorelleno: email,
        dni,
        direccion,
        ciudad,
        provincia,
        cp,
        tipoProducto,
        nombreProducto,
        descripcionProducto
      },
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(nombreProducto)}`,
      cancel_url: 'https://laboroteca.es/error'
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Error Stripe (crear-sesion-pago):', error.message);
    return res.status(500).json({ error: 'Error al crear el pago' });
  }
});

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
  const descripcionProducto = datos.descripcionProducto || '';
  const precio = parseFloat((datos.importe || '9.99').toString().replace(',', '.'));
  const imagenProducto = datos.imagenProducto || 'https://www.laboroteca.es/wp-content/uploads/2025/07/Club-laboroteca-precio-suscripcion-mensual-2.webp';

  console.log('🧪 tipoProducto:', tipoProducto);
  console.log('🧪 nombreProducto:', nombreProducto);

  if (!nombre || !email) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    console.warn('❌ Email inválido antes de Stripe:', email);
    return res.status(400).json({ error: 'Email inválido' });
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
          product_data: {
            name: nombreProducto,
            images: [imagenProducto]
          },
          unit_amount: Math.round(precio * 100),
          recurring: { interval: 'month' }
        },
        quantity: 1
      }],
      metadata: {
        nombre,
        apellidos,
        email,
        email_autorelleno: email,
        dni,
        direccion,
        ciudad,
        provincia,
        cp,
        tipoProducto,
        nombreProducto,
        descripcionProducto
      },
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(nombreProducto)}`,
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
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      cancelada: false,
      mensaje: 'Faltan datos obligatorios'
    });
  }

  try {
    const resultado = await desactivarMembresiaClub(email, password);

    // ❌ Si el objeto resultado indica fallo en validación
    if (!resultado.ok) {
      console.warn('⚠️ Cancelación bloqueada:', resultado.mensaje);
      const mensaje = resultado.mensaje === 'Contraseña incorrecta'
        ? 'Contraseña incorrecta'
        : 'No se pudo completar la cancelación: ' + resultado.mensaje;
      return res.status(401).json({
        cancelada: false,
        mensaje
      });
    }

    // ✅ Si se ha cancelado correctamente
    if (resultado.cancelada === true) {
      registrarBajaClub({
        email,
        nombre: '',
        motivo: 'baja voluntaria'
      }).catch((e) => {
        console.warn('⚠️ No se pudo registrar la baja en Sheets:', e.message);
      });

      return res.json({ cancelada: true });
    }

    // ⚠️ Si no canceló pero no se marcó como error
    console.warn('⚠️ Cancelación no completada (sin error pero no marcada como cancelada)');
    return res.status(400).json({
      cancelada: false,
      mensaje: 'No se pudo completar la cancelación'
    });

  } catch (error) {
    console.error('❌ Error en desactivarMembresiaClub:', error.message);
    return res.status(500).json({
      cancelada: false,
      mensaje: 'Error interno del servidor.'
    });
  }
});

app.post('/eliminar-cuenta', async (req, res) => {
  const { email, password, token } = req.body;
  const tokenEsperado = 'eliminarCuenta@2025!';

  if (token !== tokenEsperado) {
    return res.status(403).json({ eliminada: false, mensaje: 'Token inválido' });
  }

  if (!email || !password) {
    return res.status(400).json({ eliminada: false, mensaje: 'Faltan datos obligatorios' });
  }

  try {
    const resultado = await eliminarUsuarioWordPress(email, password);
    if (!resultado.ok) {
      return res.status(401).json({ eliminada: false, mensaje: resultado.mensaje });
    }

    console.log(`🧨 Cuenta eliminada correctamente en WordPress para: ${email}`);
    return res.json({ eliminada: true });
  } catch (error) {
    console.error('❌ Error al procesar eliminación:', error.message);
    return res.status(500).json({ eliminada: false, mensaje: 'Error interno del servidor' });
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
