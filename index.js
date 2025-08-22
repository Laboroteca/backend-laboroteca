if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const { alertAdmin } = require('./utils/alertAdmin'); 

// Utilidad para no mostrar claves en claro
const crypto = require('crypto');
const hash8 = v => v ? crypto.createHash('sha256').update(String(v)).digest('hex').slice(0,8) : 'MISSING';

console.log('🧠 INDEX REAL EJECUTÁNDOSE');
console.log('🌍 NODE_ENV:', process.env.NODE_ENV);
console.log('🔑 STRIPE_SECRET_KEY presente:', !!process.env.STRIPE_SECRET_KEY);
console.log('🔐 STRIPE_WEBHOOK_SECRET presente:', !!process.env.STRIPE_WEBHOOK_SECRET);

// Log seguro de MemberPress (sin exponer la clave)
console.log('🛠 MemberPress config:');
console.log('   📍 SITE_URL =', process.env.SITE_URL || '(no set)');
console.log('   🔑 MEMBERPRESS_KEY =', process.env.MEMBERPRESS_KEY ? `present (${hash8(process.env.MEMBERPRESS_KEY)})` : 'MISSING');

if (!process.env.STRIPE_SECRET_KEY) {
  try {
  alertAdmin({
    area: 'startup_env_missing',
    email: '-',
    err: new Error('Falta STRIPE_SECRET_KEY'),
    meta: { hasWebhookSecret: !!process.env.STRIPE_WEBHOOK_SECRET, nodeEnv: process.env.NODE_ENV }
  }).catch(() => {});
} catch (_) {}
  throw new Error('❌ Falta STRIPE_SECRET_KEY en variables de entorno');
}
if (process.env.NODE_ENV === 'production' && !process.env.STRIPE_WEBHOOK_SECRET) {
  throw new Error('❌ Falta STRIPE_WEBHOOK_SECRET en producción');
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
const validarEntrada = require('./entradas/routes/validarEntrada');
const crearCodigoRegalo = require('./regalos/routes/crear-codigo-regalo');
const registrarConsentimiento = require('./routes/registrar-consentimiento');

const app = express();
app.set('trust proxy', 1);

app.use((req, _res, next) => {
  if (req.headers.origin) console.log('🌐 Origin:', req.headers.origin);
  next();
});

const allowProd = [
  'https://laboroteca.es',
  'https://www.laboroteca.es'
];
const allowDev = [
  'http://localhost',
  'http://localhost:3000',
  'http://127.0.0.1',
  'http://127.0.0.1:3000'
];
const extra = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ORIGINS = [
  ...allowProd,
  ...(process.env.NODE_ENV === 'production' ? [] : allowDev),
  ...extra
];

const corsOptions = {
  origin(origin, cb) {
    if (!origin || ORIGINS.includes(origin)) return cb(null, true);
    console.warn('⛔ CORS rechazado para:', origin);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-LABOROTECA-TOKEN'],
  credentials: false // pon true solo si usas cookies/sesión
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ⚠️ WEBHOOK: SIEMPRE EL PRIMERO Y EN RAW
app.use('/webhook', require('./routes/webhook'));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));


// NUEVO: ruta para registrar consentimiento
app.use(registrarConsentimiento);


// DESPUÉS DEL WEBHOOK, LOS BODY PARSERS
app.use(require('./routes/solicitarEliminacionCuenta'));
app.use(require('./routes/confirmarEliminaciondecuenta'));
app.use('/regalos', require('./regalos/routes/canjear-codigo'));
app.use('/regalos', require('./regalos/routes/crear-codigo-regalo'));


app.use('/entradas/crear', require('./entradas/routes/crearEntrada'));
app.use('/entradas/sesion', require('./entradas/routes/create-session-entrada'));
app.use('/entradas', require('./entradas/routes/crear-entrada-regalo'));
app.use('/', require('./entradas/routes/micuentaEntradas'));

app.use('/', validarEntrada);

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
  console.log('📥 Datos recibidos en /crear-sesion-pago:\n', JSON.stringify(datos, null, 2));

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
  const precio = parseFloat((datos.importe || '29.90').toString().replace(',', '.'));
  let imagenProducto = datos.imagenProducto?.trim();
  if (!imagenProducto) {
    imagenProducto = 'https://www.laboroteca.es/wp-content/uploads/2025/06/DE-CARA-A-LA-JUBILACION-PDF-IGNACIO-SOLSONA-ABOGADO-scaled.webp'; // o lo que quieras como fallback para libros/cursos
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
      success_url: `https://www.laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(nombreProducto)}`,
      cancel_url: 'https://www.laboroteca.es/error'
    });

    return res.json({ url: session.url });
    } catch (error) {
      console.error('❌ Error Stripe (crear-sesion-pago):', error.message || error);
      console.error('❌ Error completo:', error);
      try {
        await alertAdmin({
          area: 'stripe_crear_sesion_pago_error',
          email: (req.body?.email_autorelleno || req.body?.email || '-').toLowerCase(),
          err: error,
          meta: {
            tipoProducto: req.body?.tipoProducto || '',
            nombreProducto: req.body?.nombreProducto || '',
            importe: req.body?.importe || null
          }
        });
      } catch (_) {}

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
  let imagenProducto = datos.imagenProducto?.trim() || '';
  if (!imagenProducto) {
    imagenProducto = 'https://www.laboroteca.es/wp-content/uploads/2025/07/Club-laboroteca-precio-suscripcion-mensual-2.webp';
  }


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
      success_url: `https://www.laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(nombreProducto)}`,
      cancel_url: 'https://www.laboroteca.es/error'
    });

    return res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Error Stripe (crear-suscripcion-club):', error.message);
    try {
      await alertAdmin({
        area: 'stripe_crear_suscripcion_error',
        email: (req.body?.email_autorelleno || req.body?.email || '-').toLowerCase(),
        err: error,
        meta: {
          nombreProducto: req.body?.nombreProducto || '',
          importe: req.body?.importe || null
        }
      });
    } catch (_) {}

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
    try {
      await alertAdmin({
        area: 'activar_membresia_club_error',
        email: req.body?.email || '-',
        err: error,
        meta: {}
      });
    } catch (_) {}
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
      const ahoraISO = new Date().toISOString();
      const efectosISO =
        resultado?.fechaEfectosISO ||
        resultado?.fechaFinCicloISO ||
        (typeof resultado?.current_period_end === 'number'
          ? new Date(resultado.current_period_end * 1000).toISOString()
          : undefined);

      registrarBajaClub({
        email,
        nombre: '',
        motivo: 'voluntaria',
        fechaSolicitud: ahoraISO,
        fechaEfectos: efectosISO,      // si el servicio te lo devuelve → fin de ciclo
        verificacion: 'PENDIENTE',     // se confirmará cuando llegue el deleted
      }).catch((e) => {
        console.warn('⚠️ No se pudo registrar la baja en Sheets:', e.message);
      });

      return res.json({ cancelada: true, efectos: efectosISO });
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
    try {
      await alertAdmin({
        area: 'eliminar_cuenta_error',
        email: req.body?.email || '-',
        err: error,
        meta: {}
      });
    } catch (_) {}

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
    try {
      await alertAdmin({
        area: 'stripe_portal_cliente_error',
        email: req.body?.email || '-',
        err: error,
        meta: {}
      });
    } catch (_) {}

    return res.status(500).json({ error: 'No se pudo crear el portal de cliente Stripe' });
  }
});

process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException:', err?.message || String(err));
  try {
    alertAdmin({
      area: 'uncaughtException',
      email: '-',
      err,
      meta: { pid: process.pid, nodeEnv: process.env.NODE_ENV }
    }).catch(() => {});
  } catch (_) {}
});

process.on('unhandledRejection', (err) => {
  console.error('💥 unhandledRejection:', err?.message || String(err));
  try {
    alertAdmin({
      area: 'unhandledRejection',
      email: '-',
      err,
      meta: { pid: process.pid, nodeEnv: process.env.NODE_ENV }
    }).catch(() => {});
  } catch (_) {}
});


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Backend funcionando en http://localhost:${PORT}`);
});
