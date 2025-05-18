const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// 🧠 Mapa de productos y precios en céntimos de euro
const PRECIO_PRODUCTO_MAP = {
  'De cara a la jubilación': 2990,
  'Curso IP Total': 7900,
  'Pack libros': 4990
};

router.post('/create-session', async (req, res) => {
  try {
    const {
      nombre,
      apellidos,
      email, // ⬅️ añadido
      dni,
      direccion,
      ciudad,
      provincia,
      cp,
      tipoProducto,
      nombreProducto
    } = req.body;

    // Comprobación simple del email (solo para depuración)
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      console.warn('⚠️ Email no válido o ausente:', email);
      // NO devolvemos error, seguimos
    } else {
      console.log('📩 Email recibido:', email);
    }

    const precio = PRECIO_PRODUCTO_MAP[nombreProducto];

    if (!precio) {
      console.warn('⚠️ Producto no tiene precio configurado:', nombreProducto);
      return res.status(400).json({ error: 'Producto no disponible para la venta.' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `${tipoProducto} "${nombreProducto}"`,
          },
          unit_amount: precio,
        },
        quantity: 1
      }],
      success_url: 'https://laboroteca.es/success',
      cancel_url: 'https://laboroteca.es/cancel',
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
        nombreProducto
      }
    });

    console.log('✅ Sesión de Stripe creada:', session.url);
    res.json({ url: session.url });

  } catch (error) {
    console.error('❌ Error al crear la sesión:', error.message);
    res.status(500).send('Error al crear la sesión');
  }
});

module.exports = router
