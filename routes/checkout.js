const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { normalizar } = require('../utils/normalizar');
const { emailRegistradoEnWordPress } = require('../utils/wordpress');

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

    const clave = normalizar(nombreProducto);
    const producto = PRODUCTOS[clave];

    console.log('📩 Solicitud recibida:', {
      nombre, apellidos, email, dni, direccion,
      ciudad, provincia, cp, tipoProducto, nombreProducto
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

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{
        price: producto.price_id,
        quantity: 1
      }],
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
        descripcionProducto: producto.descripcion
      }
    });

    console.log('✅ Sesión Stripe creada:', session.url);
    res.json({ url: session.url });

  } catch (err) {
    console.error('❌ Error creando sesión de pago:', err.message);
    res.status(500).json({ error: 'Error interno al crear la sesión' });
  }
});
