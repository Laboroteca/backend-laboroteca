// 📁 jobs/verificarBajasProgramadas.js
const admin = require('../firebase');
const firestore = admin.firestore();
const { syncMemberpressClub } = require('../services/syncMemberpressClub');
const { alertAdmin } = require('../utils/alertAdmin');
const { actualizarVerificacionBaja } = require('../services/registrarBajaClub');
const Stripe = require('stripe'); const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
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
      const mp = await syncMemberpressClub({ email, accion: 'desactivar', membership_id: MEMBERSHIP_ID });
      if (!mp?.ok) throw new Error(`MemberPress devolvió ok=false: ${mp?.error || 'sin detalle'}`);
      await firestore.collection('usuariosClub').doc(email).set({ activo: false, fechaBaja: new Date().toISOString() }, { merge: true });
      await firestore.collection('bajasClub').doc(email).set({ estadoBaja: 'ejecutada', comprobacionFinal: 'correcto', fechaEjecucion: new Date().toISOString() }, { merge: true });
// Verificación Stripe complementaria (no imprescindible pero informativa)
      let okStripe = true;
      try {
        const customers = await stripe.customers.search({ query: `email:'${email}'`, limit: 1 });
        const cust = customers?.data?.[0];
        if (cust) {
          const subs = await stripe.subscriptions.list({ customer: cust.id, status: 'all', limit: 10 });
          okStripe = subs.data.every(s => s.status === 'canceled' || s.status === 'incomplete_expired');
        }
      } catch { okStripe = false; }
      await actualizarVerificacionBaja({ email, fechaEfectosISO: fechaEfectos.toISOString(), estado: okStripe ? 'ok' : 'fail' })
        .catch(e => alertAdmin({ area: 'baja_programada_update_sheets', email, err: e, meta: { job: 'verificarBajasProgramadas' } }));
      if (!okStripe) {
        await alertAdmin({ area: 'baja_programada_stripe_dudoso', email, err: new Error('Stripe no verificado 100% OK'), meta: { job: 'verificarBajasProgramadas' } });
      }
    } catch (err) {
      await firestore.collection('bajasClub').doc(email).set({ estadoBaja: 'fallida', comprobacionFinal: 'fallida', error: String(err?.message || err), fechaIntento: new Date().toISOString() }, { merge: true });
      // **OBLIGATORIO** alertAdmin ya está:
      await alertAdmin({ area: 'baja_programada_fallida', email, err, meta: { job: 'verificarBajasProgramadas' } });
      // Y F = ❌ FALLIDA en Sheets
      await actualizarVerificacionBaja({ email, fechaEfectosISO: fechaEfectos.toISOString(), estado: 'fail' })
        .catch(e => alertAdmin({ area: 'baja_programada_update_sheets_fail', email, err: e, meta: { job: 'verificarBajasProgramadas' } }));
     }
   }
  
  return { ok: true };
}
