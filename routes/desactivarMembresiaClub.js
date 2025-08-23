// 📁 routes/desactivarMembresiaClub.js

const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { alertAdmin } = require('../utils/alertAdmin');
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

// 👉 servicio unificado para BAJA VOLUNTARIA (programada fin de ciclo)
const desactivarMembresiaVoluntaria = require('../services/desactivarMembresiaClub');

const MEMBERPRESS_ID = parseInt(process.env.MEMBERSHIP_ID || '10663', 10);
// Importante: no incluimos 'incomplete' para evitar suscripciones sin period_end estable
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

const nowISO = () => new Date().toISOString();

/**
 * Ruta “baja del Club”
 * - Voluntaria (con password): delega TODO en services/desactivarMembresiaClub.js
 * - Inmediata (sin password: impago / eliminación / manual inmediata): corta ya desde aquí
 *
 * Nota: La ruta no envía emails por su cuenta para evitar duplicados: el servicio (voluntaria)
 *       ya envía el acuse; los webhooks gestionan el resto de correos (impago, confirmación final, etc.).
 */
async function desactivarMembresiaClub(email, password) {
  // Validación básica del email
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { ok: false, mensaje: 'Email inválido.' };
  }
  email = email.trim().toLowerCase();

  const esVoluntaria = typeof password === 'string';

  // ────────────────────────────────────────────────────────────────────────────
  // A) BAJA VOLUNTARIA → delegar 100% en el servicio (no duplicamos lógica)
  // ────────────────────────────────────────────────────────────────────────────
  if (esVoluntaria) {
    try {
      const res = await desactivarMembresiaVoluntaria(email, password);
      // El servicio ya: valida WP, programa Stripe, registra 1 fila (con nombre y fecha efectos),
      // y envía el acuse inmediato al usuario. Aquí solo devolvemos su resultado.
      return res;
    } catch (err) {
      await alertAdmin({
        area: 'route_baja_voluntaria_error',
        email,
        err,
        meta: {}
      });
      return { ok: false, mensaje: 'Error al procesar la baja voluntaria.' };
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // B) BAJA INMEDIATA (impago / eliminación / manual inmediata)
  //    Se mantiene aquí para no romper flujos ya operativos
  // ────────────────────────────────────────────────────────────────────────────
  let huboSuscripciones = false;

  try {
    // 1) Stripe: cancelar inmediatamente las suscripciones activas
    const clientes = await stripe.customers.list({ email, limit: 1 });
    if (!clientes?.data?.length) {
      console.warn(`⚠️ Stripe: cliente no encontrado (${email})`);
    } else {
      const customerId = clientes.data[0].id;
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 25,
      });

      for (const sub of subs.data) {
        if (!ACTIVE_STATUSES.includes(sub.status)) continue;
        huboSuscripciones = true;

        try {
          await stripe.subscriptions.cancel(sub.id, { invoice_now: false, prorate: false });
          console.log(`🛑 Stripe: cancelada inmediata ${sub.id} (${email})`);
        } catch (e) {
          console.error('❌ Error cancelando suscripción inmediata en Stripe:', e?.message || e);
          // seguimos con el resto para no dejar el estado a medias
        }
      }
    }
  } catch (errStripe) {
    console.error('❌ Stripe error (baja inmediata):', errStripe?.message || errStripe);
    await alertAdmin({ area: 'stripe_baja_inmediata', email, err: errStripe });
  }

  // 2) Firestore: marcar inactivo ya
  try {
    await firestore.collection('usuariosClub').doc(email).set(
      { activo: false, fechaBaja: nowISO() },
      { merge: true }
    );
    console.log(`📉 Firestore: baja inmediata registrada para ${email}`);
  } catch (errFS) {
    console.error('❌ Error Firestore (usuariosClub):', errFS?.message || errFS);
    await alertAdmin({ area: 'firestore_baja_inmediata', email, err: errFS });
  }

  // 3) MemberPress: desactivar acceso (idempotente)
  try {
    const resp = await syncMemberpressClub({
      email,
      accion: 'desactivar',
      membership_id: MEMBERPRESS_ID,
    });
    console.log('🧩 MemberPress sync (inmediata):', resp);
    if (!resp?.ok) {
      return { ok: false, mensaje: `Error desactivando en MemberPress: ${resp?.error || 'Sin mensaje'}` };
    }
  } catch (errMP) {
    console.error('❌ Error MemberPress (inmediata):', errMP?.message || errMP);
    await alertAdmin({ area: 'memberpress_baja_inmediata', email, err: errMP });
    return { ok: false, mensaje: 'Error al desactivar en MemberPress.' };
  }

  // Nota: Esta ruta no envía emails (los webhooks ya mandan los correspondientes).
  return { ok: true, cancelada: true, inmediata: true, stripe: { huboSuscripciones } };
}

module.exports = desactivarMembresiaClub;
