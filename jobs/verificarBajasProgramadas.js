// 📁 jobs/verificarBajasProgramadas.js
const admin = require('../firebase');
const firestore = admin.firestore();
const { syncMemberpressClub } = require('../services/syncMemberpressClub');
const { alertAdmin } = require('../utils/alertAdmin');
const { actualizarVerificacionBaja } = require('../services/registrarBajaClub');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const MEMBERSHIP_ID = parseInt(process.env.MEMBERSHIP_ID || '10663', 10);

module.exports = async function verificarBajasProgramadas() {
  const ahora = new Date();
  const snap = await firestore.collection('bajasClub')
    .where('estadoBaja', 'in', ['pendiente', 'programada'])
    .get();

  for (const doc of snap.docs) {
    const d = doc.data();
    const email = doc.id;
    const fechaEfectos = d?.fechaEfectos && typeof d.fechaEfectos.toDate === 'function'
      ? d.fechaEfectos.toDate()
      : new Date(d.fechaEfectos);
    if (isNaN(fechaEfectos.getTime())) continue;
    if (fechaEfectos > ahora) continue; // aún no toca

    try {
      // 1) Comprobar que la suscripción YA está cancelada en Stripe
      let stripeOk = true;
      try {
        const clientes = await stripe.customers.list({ email, limit: 1 });
        if (clientes?.data?.length) {
          const customerId = clientes.data[0].id;
          const subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 50 });
          const sigueActiva = subs.data.some(s => ['active','trialing','incomplete','past_due'].includes(s.status));
          stripeOk = !sigueActiva;
        }
      } catch (e) {
        stripeOk = false;
      }

      // 2) Desactivar en MemberPress por seguridad (idempotente)
      const mp = await syncMemberpressClub({ email, accion: 'desactivar', membership_id: MEMBERSHIP_ID });
      const mpOk = !!mp?.ok;
      if (!stripeOk || !mpOk) throw new Error(`Verificación baja: stripeOk=${stripeOk}, mpOk=${mpOk}`);

      await firestore.collection('usuariosClub').doc(email).set({ activo: false, fechaBaja: new Date().toISOString() }, { merge: true });
      await firestore.collection('bajasClub').doc(email).set({ estadoBaja: 'ejecutada', comprobacionFinal: 'correcto', fechaEjecucion: new Date().toISOString() }, { merge: true });
      await actualizarVerificacionBaja({ email, verificacion: 'CORRECTO ✅' });
    } catch (err) {
      await firestore.collection('bajasClub').doc(email).set({ estadoBaja: 'fallida', comprobacionFinal: 'fallida', error: String(err?.message || err), fechaIntento: new Date().toISOString() }, { merge: true });
      await alertAdmin({ area: 'baja_programada_fallida', email, err, meta: { job: 'verificarBajasProgramadas' } });
      try {
        await actualizarVerificacionBaja({ email, verificacion: 'FALLIDA ❌' });
      } catch (e) {
        await alertAdmin({ area: 'sheets_baja_programada_fallida', email, err: e, meta: { job: 'verificarBajasProgramadas' } });
      }
    }
  }
  return { ok: true };
}
