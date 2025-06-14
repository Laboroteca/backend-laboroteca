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
const fs = require('fs').promises;
const procesarCompra = require('./services/procesarCompra');

const app = express();
app.set('trust proxy', 1);

const RUTA_CUPONES = path.join(__dirname, 'data/cupones.json');

// 🧠 Mapa de productos
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
  const codigoDescuento = datos.codigoDescuento || '';

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

  let precioFinal = producto.precio;
  let cupon = null;

  if (codigoDescuento) {
    try {
      const raw = await fs.readFile(RUTA_CUPONES, 'utf8');
      const cupones = JSON.parse(raw);
      cupon = cupones.find(c => c.codigo === codigoDescuento && !c.usado);

      if (cupon) {
        precioFinal = Math.max(0, producto.precio - Math.round(cupon.valor * 100));
        console.log(`🎟️ Cupón válido: -${cupon.valor} € → Total: ${precioFinal / 100} €`);
      } else {
        console.warn(`⚠️ Cupón no válido o ya usado: ${codigoDescuento}`);
      }
    } catch (error) {
      console.error('❌ Error leyendo cupones.json:', error);
    }
  }

  if (precioFinal === 0 && cupon) {
    console.log('💥 Cupón cubre el 100%. Activando acceso sin Stripe');

    const fakeSession = {
      id: `FREE-${Date.now()}`,
      payment_status: 'paid',
      customer_details: { email, name: `${nombre} ${apellidos}`.trim() },
      amount_total: 0,
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
        descripcionProducto: producto.descripcion || `${tipoProducto} "${producto.nombre}"`,
        codigoDescuento
      }
    };

    // Marcar cupón como usado
    try {
      const raw = await fs.readFile(RUTA_CUPONES, 'utf8');
      const cupones = JSON.parse(raw);
      const index = cupones.findIndex(c => c.codigo === codigoDescuento && !c.usado);
      if (index !== -1) {
        cupones[index].usado = true;
        await fs.writeFile(RUTA_CUPONES, JSON.stringify(cupones, null, 2));
        console.log(`✔️ Cupón ${codigoDescuento} marcado como usado`);
      }
    } catch (err) {
      console.error('❌ Error actualizando cupones.json:', err);
    }

    await procesarCompra(fakeSession);
    return res.json({ url: 'GRATIS' });
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
          unit_amount: precioFinal
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
        nombreProducto: producto.nombre,
        descripcionProducto: producto.descripcion || `${tipoProducto} "${producto.nombre}"`,
        codigoDescuento
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
