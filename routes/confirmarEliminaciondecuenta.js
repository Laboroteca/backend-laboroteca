// 📁 routes/confirmarEliminaciondecuenta.js
const express = require('express');
const router = express.Router();
const admin = require('../firebase');
const firestore = admin.firestore();

const desactivarMembresiaClub = require('../services/desactivarMembresiaClub');
const { eliminarUsuarioWordPress } = require('../services/eliminarUsuarioWordPress');
const { borrarDatosUsuarioFirestore } = require('../services/borrarDatosUsuarioFirestore');
const { enviarEmailPersonalizado } = require('../services/email');
const { registrarBajaClub } = require('../services/registrarBajaClub');
const { alertAdmin } = require('../utils/alertAdmin');
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

// 🔧 Stripe
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ———————————————————————————————————————————————————————
// Helper: cancelar suscripciones Stripe por email (siempre)
// ———————————————————————————————————————————————————————
async function cancelarSuscripcionesStripePorEmail(email) {
  try {
    const customers = await stripe.customers.list({ email, limit: 10 });
    if (!customers.data.length) return { ok: true, canceladas: 0, detalle: 'no_customers' };

    let canceladas = 0;
    const errores = [];

    for (const c of customers.data) {
      const subs = await stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 100 });
      for (const s of subs.data) {
        if (['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(s.status)) {
          // 1) intenta anotar motivo en metadata para que el webhook lo detecte
          try {
            await stripe.subscriptions.update(s.id, {
              metadata: {
                ...(s.metadata || {}),
                motivo_baja: 'eliminacion_cuenta',
                origen_baja: 'formulario_usuario'
              }
            });
          } catch (_) { /* no bloquea */ }

          // 2) cancela
          try {
            await stripe.subscriptions.cancel(s.id, {
              cancellation_details: { comment: 'Eliminación de cuenta' }
            });
            canceladas++;
          } catch (e) {
            errores.push({ subscriptionId: s.id, error: e?.message || String(e) });
          }
        }
      }
    }

    if (errores.length) return { ok: false, canceladas, errores };
    return { ok: true, canceladas };
  } catch (e) {
    return { ok: false, canceladas: 0, errores: [{ error: e?.message || String(e) }] };
  }
}

// ———————————————————————————————————————————————————————
// Fallback de fuerza bruta (mantiene funcionalidades del archivo viejo)
// ———————————————————————————————————————————————————————
async function forzarDesactivacionTotal(email) {
  const resumen = { stripe: false, memberpress: false, firestore: false, errores: [] };

  // 1) Stripe — reintento por si quedó algo colgado
  try {
    const customers = await stripe.customers.list({ email, limit: 10 });
    for (const c of customers.data) {
      const subs = await stripe.subscriptions.list({
        customer: c.id,
        status: 'all',
        limit: 100
      });
      for (const s of subs.data) {
        if (['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(s.status)) {
          try {
            await stripe.subscriptions.update(s.id, {
              metadata: {
                ...(s.metadata || {}),
                motivo_baja: 'eliminacion_cuenta',
                origen_baja: 'eliminacion_cuenta_api'
              }
            });
          } catch (_) {}

          try {
            await stripe.subscriptions.cancel(s.id, {
              cancellation_details: { comment: 'Eliminación de cuenta (fallback)' }
            });
          } catch (e) {
            resumen.errores.push(`Stripe cancel ${s.id}: ${e?.message || e}`);
          }
        }
      }
    }
    // Re-chequeo rápido
    let quedanActivas = false;
    for (const c of (await stripe.customers.list({ email, limit: 10 })).data) {
      const subs = await stripe.subscriptions.list({ customer: c.id, status: 'active', limit: 1 });
      if (subs.data.length) { quedanActivas = true; break; }
    }
    resumen.stripe = !quedanActivas;
  } catch (e) {
    resumen.errores.push(`Stripe listado: ${e?.message || e}`);
  }

  // 2) MemberPress
  try {
    await syncMemberpressClub({ email, accion: 'desactivar', membership_id: 10663 });
    resumen.memberpress = true;
  } catch (e) {
    resumen.errores.push(`MemberPress: ${e?.message || e}`);
  }

  // 3) Firestore flag
  try {
    await firestore.collection('usuariosClub').doc(email).set({
      activo: false,
      fechaBaja: new Date().toISOString(),
      motivoBaja: 'eliminacion_cuenta'
    }, { merge: true });
    resumen.firestore = true;
  } catch (e) {
    resumen.errores.push(`Firestore: ${e?.message || e}`);
  }

  return { ok: (resumen.stripe && resumen.memberpress && resumen.firestore), resumen };
}

// ———————————————————————————————————————————————————————
// Endpoint
// ———————————————————————————————————————————————————————
router.post('/confirmar-eliminacion', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ ok: false, mensaje: 'Falta el token de verificación.' });

  try {
    const ref = firestore.collection('eliminacionCuentas').doc(token);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'El enlace no es válido o ya ha sido utilizado.' });

    const { email, expira } = snap.data();
    const ahora = Date.now();

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ ok: false, mensaje: 'Email no válido.' });
    }
    if (!expira || ahora > expira) {
      await ref.delete();
      return res.status(410).json({ ok: false, mensaje: 'El enlace ha caducado.' });
    }

    // 1) Intento “normal”: tu servicio interno (MemberPress/WordPress)
    let verificacion = 'PENDIENTE';
    let detalleFallo = '';
    let rPrimario;
    try {
      rPrimario = await desactivarMembresiaClub(email); // { ok, cancelada|desactivada, mensaje? }
      const ok = !!rPrimario?.ok;
      const off = rPrimario?.cancelada === true || rPrimario?.desactivada === true || rPrimario?.status === 'cancelada';
      verificacion = ok && off ? 'CORRECTO' : 'FALLIDA';
      if (verificacion === 'FALLIDA') detalleFallo = rPrimario?.mensaje || 'No se confirmó la desactivación (servicio principal)';
    } catch (e) {
      verificacion = 'FALLIDA';
      detalleFallo = e?.message || String(e);
    }

    // 2) SIEMPRE: cancelar todas las suscripciones Stripe del email
    const rStripe = await cancelarSuscripcionesStripePorEmail(email);
    if (!rStripe.ok) {
      verificacion = 'FALLIDA';
      if (!detalleFallo) detalleFallo = 'Falló la cancelación en Stripe';
    }

    // 3) Si seguimos en FALLIDA, aplicar fuerza bruta (Stripe+MemberPress+Firestore)
    let rForzado = null;
    if (verificacion === 'FALLIDA') {
      rForzado = await forzarDesactivacionTotal(email);
      if (rForzado.ok) { verificacion = 'CORRECTO'; detalleFallo = ''; }
    }

    // 4) Eliminar WordPress (independiente al estado de la baja)
    const resultadoWP = await eliminarUsuarioWordPress(email);
    if (!resultadoWP.ok) {
      verificacion = 'FALLIDA';
      if (!detalleFallo) detalleFallo = `WP: ${resultadoWP.mensaje || 'no se pudo eliminar'}`;
    }

    // 5) Borrar datos Firestore (perfil/datos fiscales…)
    try { await borrarDatosUsuarioFirestore(email); } catch (_) {}

    // 6) Nombre para Sheets (si existe)
    let nombre = '';
    try {
      const f = await firestore.collection('datosFiscalesPorEmail').doc(email).get();
      if (f.exists) nombre = f.data()?.nombre || '';
    } catch {}

    // 7) Registrar en hoja de bajas unificada (con verificación real)
    const ahoraISO = new Date().toISOString();
    try {
      await registrarBajaClub({
        email,
        nombre,
        motivo: 'eliminacion_cuenta', // clave que espera el MAP
        fechaSolicitud: ahoraISO,
        fechaEfectos: ahoraISO,
        verificacion // CORRECTO | FALLIDA
      });
    } catch (e) {
      await alertAdmin({ area: 'baja_sheet_unificada', email, err: e, meta: { motivo: 'eliminacion_cuenta' } });
    }

    // 8) Aviso al admin si FALLIDA (el usuario NO ve errores)
    if (verificacion === 'FALLIDA') {
      await alertAdmin({
        area: 'eliminacion_cuenta_desactivacion_fallida',
        email,
        err: new Error(detalleFallo || 'Fallo desactivación'),
        meta: { primario: rPrimario || null, stripe: rStripe || null, forzado: rForzado || null, wp: resultadoWP || null }
      });
      try {
        await enviarEmailPersonalizado({
          to: 'laboroteca@gmail.com',
          subject: '⚠️ FALLÓ la desactivación de membresía al eliminar una cuenta',
          text: `Email: ${email}\nDetalle: ${detalleFallo}\nPrimario: ${JSON.stringify(rPrimario)}\nStripe: ${JSON.stringify(rStripe)}\nForzado: ${JSON.stringify(rForzado)}\nWP: ${JSON.stringify(resultadoWP)}`,
          html: `<p><strong>Email:</strong> ${email}</p><p><strong>Detalle:</strong> ${detalleFallo}</p><pre>${JSON.stringify({ primario: rPrimario, stripe: rStripe, forzado: rForzado, wp: resultadoWP }, null, 2)}</pre>`
        });
      } catch {}
    }

    // 9) Token fuera y email al usuario — SIEMPRE neutro (sin revelar fallos)
    await ref.delete();
    await enviarEmailPersonalizado({
      to: email,
      subject: 'Cuenta eliminada con éxito',
      html: `
        <p><strong>✅ Tu cuenta en Laboroteca ha sido eliminada correctamente.</strong></p>
        <p>Gracias por habernos acompañado. Si alguna vez decides volver, estaremos encantados de recibirte.</p>
      `,
      text: 'Tu cuenta en Laboroteca ha sido eliminada correctamente. Gracias por tu confianza.',
      enviarACopy: true
    });

    return res.json({ ok: true, verificacion });
  } catch (err) {
    console.error('❌ Error al confirmar eliminación:', err);
    try {
      await alertAdmin({
        area: 'confirmar_eliminacion_error',
        email: '-',
        err,
        meta: {}
      });
    } catch (_) {}
    return res.status(500).json({ ok: false, mensaje: 'Error interno del servidor.' });
  }
});

module.exports = router;

