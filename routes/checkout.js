const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

router.post('/create-session', async (req, res) => {
  try {
    const {
      nombre,
      apellidos,
      dni,
      direccion,
      ciudad,
      provincia,
      cp,
      tipoProducto,
      nombreProducto
    } = req.body;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: `Libro "${nombreProducto}"`,
          },
          unit_amount: 2990,
        },
        quantity: 1
      }],
      success_url: 'https://laboroteca.es/success',
      cancel_url: 'https://laboroteca.es/cancel',
      metadata: {
        nombre,
        apellidos,
        dni,
        direccion,
        ciudad,
        provincia,
        cp,
        tipoProducto,
        nombreProducto
      }
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('❌ Error al crear la sesión:', error.message);
    res.status(500).send('Error al crear la sesión');
  }
});

module.exports = router;
