const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('../firebase');
const firestore = admin.firestore();
const bcrypt = require('bcryptjs');

const { syncMemberpressClub } = require('../services/syncMemberpressClub');
const { enviarConfirmacionBajaClub } = require('../services/email');

const CLUB_MEMBERSHIP_ID = 10663;
const TOKEN_ESPERADO = process.env.TOKEN_DESACTIVACION || 'bajaClub@2025!';

// POST /cancelar-suscripcion-club
router.post('/', async (req, res) => {
  const { email, password, token } = req.body;

  // 🔒 Validación inicial
  if (!email || !password) {
    return res.status(400).json({
      cancelada: false,
      mensaje: 'Faltan datos obligatorios.'
    });
  }

  if (token !== TOKEN_ESPERADO) {
    return res.status(403).json({
      cancelada: false,
      mensaje: 'Token inválido.'
    });
  }

  try {
    // 🔐 Verificar contraseña desde Firestore
    const ref = firestore.collection('usuariosClub').doc(email);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({
        cancelada: false,
        mensaje: 'El usuario no existe en la base de datos.'
      });
    }

    const datos = doc.data();
    const hash = datos.passwordHash;

    if (!hash) {
      return res.status(400).json({
        cancelada: false,
        mensaje: 'No se ha establecido una contraseña.'
      });
    }

    const esCorrecta = await bcrypt.compare(password, hash);
    if (!esCorrecta) {
      return res.status(401).json({
        cancelada: false,
        mensaje: 'La contraseña no es válida.'
      });
    }

    const nombre = datos.nombre || '';

    // 🔁 Cancelar suscripciones activas en Stripe
    const clientes = await stripe.customers.list({ email, limit: 1 });
    if (clientes.data.length) {
      const customerId = clientes.data[0].id;

      const subsActivas = await stripe.subscriptions.list({
        customer: customerId,
        status: 'active',
        limit: 10
      });

      for (const sub of subsActivas.data) {
        await stripe.subscriptions.cancel(sub.id);
        console.log(`🛑 Stripe: suscripción ${sub.id} cancelada para ${email}`);
      }
    } else {
      console.warn(`⚠️ Stripe: cliente no encontrado para ${email}`);
    }

    // 🔁 Desactivar en MemberPress
    await syncMemberpressClub({
      email,
      accion: 'desactivar',
      membership_id: CLUB_MEMBERSHIP_ID
    });

    // 🔁 Desactivar en Firestore
    await ref.set({
      activo: false,
      fechaBaja: new Date().toISOString()
    }, { merge: true });

    console.log(`📉 Firestore: marcado como inactivo → ${email}`);

    // ✉️ Enviar email de confirmación
    try {
      const resultadoEmail = await enviarConfirmacionBajaClub(email, nombre);
      if (resultadoEmail?.data?.succeeded === 1) {
        console.log(`📩 Email de confirmación enviado a ${email}`);
      } else {
        console.warn(`⚠️ Fallo al enviar email de baja:`, resultadoEmail);
      }
    } catch (errEmail) {
      console.error(`❌ Error email baja → ${errEmail.message}`);
    }

    return res.json({
      cancelada: true,
      mensaje: 'Suscripción cancelada correctamente.'
    });

  } catch (error) {
    console.error('❌ Error interno en /cancelar-suscripcion-club:', error.message || error);
    return res.status(500).json({
      cancelada: false,
      mensaje: 'Error interno al cancelar la suscripción.'
    });
  }
});

module.exports = router;
