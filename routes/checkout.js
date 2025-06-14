const fs = require('fs').promises;
const path = require('path');

const RUTA_CUPONES = path.join(__dirname, '../data/cupones.json');

async function obtenerCuponValido(codigo) {
  const raw = await fs.readFile(RUTA_CUPONES, 'utf8');
  const lista = JSON.parse(raw);
  return lista.find(c => c.codigo === codigo && !c.usado);
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

    let line_items;
    let metadata = {
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
    };

    // ✅ Verificar cupón
    let cuponAplicado = null;
    if (codigoDescuento) {
      cuponAplicado = await obtenerCuponValido(codigoDescuento);
    }

    if (cuponAplicado) {
      const precioFinal = Math.max(0, getPrecioManual(producto.slug) - cuponAplicado.valor);
      console.log(`🎟️ Cupón aplicado: -${cuponAplicado.valor} € → Total: ${precioFinal} €`);

      line_items = [{
        price_data: {
          currency: 'eur',
          product_data: { name: producto.nombre },
          unit_amount: Math.round(precioFinal * 100)
        },
        quantity: 1
      }];
    } else {
      // Usar price_id si no hay cupón válido
      line_items = [{
        price: producto.price_id,
        quantity: 1
      }];
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items,
      success_url: `https://laboroteca.es/gracias?nombre=${encodeURIComponent(nombre)}&producto=${encodeURIComponent(producto.nombre)}`,
      cancel_url: 'https://laboroteca.es/error',
      metadata
    });

    console.log('✅ Sesión Stripe creada:', session.url);
    res.json({ url: session.url });
  } catch (err) {
    console.error('❌ Error creando sesión de pago:', err.message);
    res.status(500).json({ error: 'Error interno al crear la sesión' });
  }
});

// Añade esta función auxiliar para obtener el precio original del producto
function getPrecioManual(slug) {
  switch (slug) {
    case 'libro_jubilacion': return 29.90;
    case 'curso_ip_total': return 39.90;
    case 'libro_doble': return 39.90;
    default: return 0;
  }
}
