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

// 🔧 fallback de fuerza bruta para desactivar: Stripe + MemberPress + Firestore
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

async function forzarDesactivacionTotal(email) {
  const resumen = { stripe: false, memberpress: false, firestore: false, errores: [] };

  // 1) Stripe: cancelar TODAS las suscripciones activas del cliente
  try {
    const customers = await stripe.customers.list({ email, limit: 5 });
    for (const c of customers.data) {
      const subs = await stripe.subscriptions.list({
        customer: c.id,
        status: 'all',
        expand: ['data.latest_invoice'],
        limit: 100,
      });
      for (const s of subs.data) {
        if (['active','trialing','past_due','unpaid'].includes(s.status)) {
          try {
            await stripe.subscriptions.cancel(s.id, {
              cancellation_details: { comment: 'Eliminación de cuenta' },
              metadata: { motivo_baja: 'eliminacion_cuenta', origen_baja: 'eliminacion_cuenta_api' }
            });
          } catch (e) {
            resumen.errores.push(`Stripe cancel ${s.id}: ${e?.message || e}`);
          }
        }
      }
    }
    // Re-chequeo rápido: si no quedan subs activas, damos Stripe por OK
    let quedanActivas = false;
    for (const c of (await stripe.customers.list({ email, limit: 5 })).data) {
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

    // 1) Intento “normal”
    let verificacion = 'PENDIENTE';
    let detalleFallo = '';
    let r1;
    try {
      r1 = await desactivarMembresiaClub(email); // { ok, cancelada|desactivada, mensaje? }
      const ok = !!r1?.ok;
      const off = r1?.cancelada === true || r1?.desactivada === true || r1?.status === 'cancelada';
      verificacion = ok && off ? 'CORRECTO' : 'FALLIDA';
      if (verificacion === 'FALLIDA') detalleFallo = r1?.mensaje || 'No se confirmó la desactivación (servicio principal)';
    } catch (e) {
      verificacion = 'FALLIDA';
      detalleFallo = e?.message || String(e);
    }

    // 2) Si FALLIDA, aplicamos fuerza bruta
    let r2 = null;
    if (verificacion === 'FALLIDA') {
      r2 = await forzarDesactivacionTotal(email);
      if (r2.ok) { verificacion = 'CORRECTO'; detalleFallo = ''; }
    }

    // 3) Eliminar WordPress (independiente al estado de la baja)
    const resultadoWP = await eliminarUsuarioWordPress(email);
    if (!resultadoWP.ok) {
      // no cambiamos el email al usuario; solo marcamos para el admin
      verificacion = 'FALLIDA';
      if (!detalleFallo) detalleFallo = `WP: ${resultadoWP.mensaje || 'no se pudo eliminar'}`;
    }

    // 4) Borrar datos Firestore (su perfil/datos fiscales/etc.)
    try { await borrarDatosUsuarioFirestore(email); } catch (_) {}

    // 5) Nombre para Sheets (si existe)
    let nombre = '';
    try {
      const f = await firestore.collection('datosFiscalesPorEmail').doc(email).get();
      if (f.exists) nombre = f.data()?.nombre || '';
    } catch {}

    // 6) Registrar en hoja de bajas unificada (con verificación real)
    const ahoraISO = new Date().toISOString();
    try {
      await registrarBajaClub({
        email,
        nombre,
        motivo: 'eliminacion_cuenta',
        fechaSolicitud: ahoraISO,
        fechaEfectos: ahoraISO,
        verificacion // CORRECTO | FALLIDA
      });
    } catch (e) {
      await alertAdmin({ area: 'baja_sheet_unificada', email, err: e, meta: { motivo: 'eliminacion_cuenta' } });
    }

    // 7) Aviso al admin si FALLIDA
    if (verificacion === 'FALLIDA') {
      await alertAdmin({
        area: 'eliminacion_cuenta_desactivacion_fallida',
        email,
        err: new Error(detalleFallo || 'Fallo desactivación'),
        meta: { primario: r1 || null, forzado: r2 || null, wp: resultadoWP || null }
      });
      try {
        await enviarEmailPersonalizado({
          to: 'laboroteca@gmail.com',
          subject: '⚠️ FALLÓ la desactivación de membresía al eliminar una cuenta',
          text: `Email: ${email}\nDetalle: ${detalleFallo}\nPrimario: ${JSON.stringify(r1)}\nForzado: ${JSON.stringify(r2)}\nWP: ${JSON.stringify(resultadoWP)}`,
          html: `<p><strong>Email:</strong> ${email}</p><p><strong>Detalle:</strong> ${detalleFallo}</p><pre>${JSON.stringify({ primario: r1, forzado: r2, wp: resultadoWP }, null, 2)}</pre>`
        });
      } catch {}
    }

    // 8) Token fuera y email al usuario — SIEMPRE neutro (sin revelar fallos)
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
    return res.status(500).json({ ok: false, mensaje: 'Error interno del servidor.' });
  }
});

module.exports = router;
