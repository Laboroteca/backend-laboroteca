const fs = require('fs').promises;
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const procesarCompra = require('../services/procesarCompra');
const { normalizar } = require('../utils/normalizar'); // si tienes esto fuera, o reemplaza la función directamente aquí
const { emailRegistradoEnWordPress } = require('../utils/wordpress'); // o sustitúyelo directamente si no está modularizado

const RUTA_CUPONES = path.join(__dirname, '../data/cupones.json');

async function obtenerCuponValido(codigo) {
  const raw = await fs.readFile(RUTA_CUPONES, 'utf8');
  const lista = JSON.parse(raw);
  return lista.find(c => c.codigo === codigo && !c.usado);
}

async function marcarCuponComoUsado(codigo) {
  const raw = await fs.readFile(RUTA_CUPONES, 'utf8');
  const lista = JSON.parse(raw);
  const index = lista.findIndex(c => c.codigo === codigo && !c.usado);
  if (index !== -1) {
    lista[index].usado = true;
    await fs.writeFile(RUTA_CUPONES, JSON.stringify(lista, null, 2));
  }
}

router.post('/create-session', async (req, res) => {
  try {
    const datos = req.body.email ? req.body : Object.values(req.body)[0];

    const nombre = datos.nombre || datos.Nombre || '';
    const apellidos = datos.apellidos || datos.Apellidos || '';
    const email = datos.email || '';
    const dni = datos.dni || '';
    const direccion = datos.direccion || '';
    const ciudad = datos.ciudad || '';
    const provincia = datos.provincia || '';
    const cp = datos.cp || '';
    const tipoProducto = datos.tipoProducto || '';
    const nombreProducto = datos.nombreProducto || '';
    const codigoDescuento = datos.codigoDescuento || '';

    const clave = normalizar(nombreProducto);
    const producto = PRODUCTOS[clave];

    console.log('📩 Solicitud recibida:', {
      nombre, apellidos, email, dni, direccion,
      ciudad, provincia, cp, tipoProducto, nombreProducto, codigoDescuento
    });

    if (!email || !nombre || !nombreProducto || !tipoProducto || !producto) {
      console.warn('⚠️ Faltan datos o producto inválido.');
      return res.status(400).json({ error: 'Faltan datos obligatorios o producto no válido.' });
    }

    const registrado = await emailRegistradoEnWordPress(email);
    if (!registrado) {
      console.warn('🚫 Email no registrado en WP:', email);
      return res.status(403).json({ error: 'El email no está registrado como usuario.' });
    }

    let precioOriginal = getPrecioManual(producto.slug);
    let precioFinal = precioOriginal;
    let cuponAplicado = null;

    if (codigoDescuento) {
      cuponAplicado = await obtenerCuponValido(codigoDescuento);
      if (cuponAplicado) {
        precioFinal = Math.max(0, precioOriginal - cuponAplicado.valor);
        console.log(`🎟️ Cupón aplicado: -${cuponAplicado.valor} € → Total: ${precioFinal} €`);
      }
    }

    // 🆓 Si precio final es 0 €, no usar Stripe
    if (precioFinal === 0 && cuponAplicado) {
      console.log('💥 Precio final 0 €. Activando acceso sin pasar por Stripe');

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
          nombreProducto: producto.slug,
          descripcionProducto: producto.descripcion,
          codigoDescuento
        }
      };

      await marcarCuponComoUsado(codigoDescuento);
      await procesarCompra(fakeSession); // este detectará que no hay PDF ni factura y actuará en consecuencia

      return res.json({ url: 'GRATIS' });
    }

    const line_items = cuponAplicado
      ? [{
          price_data: {
            currency: 'eur',
            product_data: { name: producto.nombre },
            unit_amount: Math.round(precioFinal * 100)
          },
          quantity: 1
        }]
      : [{
          price: producto.price_id,
          quantity: 1
        }];

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items,
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(producto.nombre)}`,
      cancel_url: 'https://laboroteca.es/error',
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
        nombreProducto: producto.slug,
        descripcionProducto: producto.descripcion,
        codigoDescuento
      }
    });

    console.log('✅ Sesión Stripe creada:', session.url);
    res.json({ url: session.url });

  } catch (err) {
    console.error('❌ Error creando sesión de pago:', err.message);
    res.status(500).json({ error: 'Error interno al crear la sesión' });
  }
});

function getPrecioManual(slug) {
  switch (slug) {
    case 'libro_jubilacion': return 29.90;
    case 'curso_ip_total': return 39.90;
    case 'libro_doble': return 39.90;
    default: return 0;
  }
}
