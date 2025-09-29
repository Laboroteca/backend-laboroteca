// 📁 routes/desactivarMembresiaClub.js

const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

// 👉 servicio unificado para BAJA VOLUNTARIA (programada fin de ciclo)
//    (él registra la fila única en Sheets y envía el acuse)
const desactivarMembresiaVoluntaria = require('../services/desactivarMembresiaClub');

const MEMBERPRESS_ID = parseInt(process.env.MEMBERSHIP_ID || '10663', 10);
// Importante: no incluimos 'incomplete' para evitar suscripciones sin period_end estable
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

const nowISO = () => new Date().toISOString();
const maskEmail = (e='') => {
  const [u,d] = String(e).split('@'); if(!u||!d) return '***';
  return `${u.slice(0,2)}***@***${d.slice(-3)}`;
};
// Evita que en errores caiga PII (emails) en logs si algún objeto se imprime entero
const sanitizeSnippet = (s='') =>
  String(s).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig,'***@***');

/**
 * Ruta “baja del Club”
 * - Voluntaria (con password): delega TODO en services/desactivarMembresiaClub.js (evita duplicados).
 * - Inmediata (sin password: impago / eliminación / manual inmediata): ejecuta aquí sin tocar Sheets.
 *
 * La ruta NO envía emails para evitar duplicados: el servicio (voluntaria) y los webhooks (resto) lo hacen.
 */
async function desactivarMembresiaClub(email, password) {
  // Validación básica del email
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { ok: false, mensaje: 'Email inválido.' };
  }
  email = email.trim().toLowerCase();

  const SENTINEL = process.env.WP_ASSERTED_SENTINEL || '__WP_ASSERTED__';
  // Voluntaria si viene sentinel (form WP) o una contraseña (string no vacío);
  // el servicio valida la contraseña real contra WP.
  const esVoluntaria = (typeof password === 'string') && (password === SENTINEL || password.length > 0);

  // ────────────────────────────────────────────────────────────────────────────
  // A) BAJA VOLUNTARIA → delegar 100% en el servicio (no duplicamos lógica)
  // ────────────────────────────────────────────────────────────────────────────
  if (esVoluntaria) {
    try {
      // El servicio valida WP, programa Stripe, escribe UNA fila en Sheets y envía el acuse.
      return await desactivarMembresiaVoluntaria(email, password);
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
  //    Se mantiene aquí para no romper flujos ya operativos.
  //    (No escribe en Sheets desde esta ruta).
  // ────────────────────────────────────────────────────────────────────────────
  let huboSuscripciones = false;

  try {
    // 1) Stripe: cancelar inmediatamente las suscripciones activas
    //    (recorre TODOS los clientes que compartan email para evitar cobros residuales)
    const clientes = await stripe.customers.list({ email, limit: 100 });
    if (!clientes?.data?.length) {
      console.warn(`⚠️ Stripe: cliente no encontrado (${maskEmail(email)})`);
    } else {
      for (const c of clientes.data) {
        const subs = await stripe.subscriptions.list({
          customer: c.id,
          status: 'all',
          limit: 100,
        });

        for (const sub of subs.data) {
          if (!ACTIVE_STATUSES.includes(sub.status)) continue;
          huboSuscripciones = true;

          try {
            await stripe.subscriptions.cancel(sub.id, { invoice_now: false, prorate: false });
            console.log(`🛑 Stripe: cancelada inmediata ${sub.id} (${maskEmail(email)})`);
          } catch (e) {
            console.error('❌ Error cancelando suscripción inmediata en Stripe:', e?.message || e);
            // seguimos con el resto para no dejar el estado a medias
          }
        }
      }
    }
  } catch (errStripe) {
    const msg = sanitizeSnippet(String(errStripe?.message || errStripe));
    console.error('❌ Stripe error (baja inmediata):', msg);
    try { await alertAdmin({
      area: 'stripe_baja_inmediata',
      email, // ← email COMPLETO para soporte al admin
      err: { message: String(errStripe?.message || errStripe), code: errStripe?.code, type: errStripe?.type }
    }); } catch (_) {}
  }

  // 2) Firestore: marcar inactivo ya
  try {
    await firestore.collection('usuariosClub').doc(email).set(
      { activo: false, fechaBaja: nowISO() },
      { merge: true }
    );
     console.log(`📉 Firestore: baja inmediata registrada para ${maskEmail(email)}`);
  } catch (errFS) {
    const msg = sanitizeSnippet(String(errFS?.message || errFS));
    console.error('❌ Error Firestore (usuariosClub):', msg);
    try { await alertAdmin({
      area: 'firestore_baja_inmediata',
      email, // ← email COMPLETO para soporte al admin
      err: { message: String(errFS?.message || errFS), code: errFS?.code, type: errFS?.type }
    }); } catch (_) {}
  }

  // 3) MemberPress: desactivar acceso (idempotente)
  try {
    const resp = await syncMemberpressClub({
      email,
      accion: 'desactivar',
      membership_id: MEMBERPRESS_ID,
    });
    // Log seguro: no volcar resp completo por si arrastra PII
    console.log('🧩 MemberPress sync (inmediata):', { ok: !!resp?.ok, detalle: resp?.detalle || resp?.error || null, email: maskEmail(email) });
    if (!resp?.ok) {
      return { ok: false, mensaje: `Error desactivando en MemberPress: ${resp?.error || 'Sin mensaje'}` };
    }
  } catch (errMP) {
    const msg = sanitizeSnippet(String(errMP?.message || errMP));
    console.error('❌ Error MemberPress (inmediata):', msg);
    try { await alertAdmin({
      area: 'memberpress_baja_inmediata',
      email, // ← email COMPLETO para soporte al admin
      err: { message: String(errMP?.message || errMP), code: errMP?.code, type: errMP?.type }
    }); } catch (_) {}
    return { ok: false, mensaje: 'Error al desactivar en MemberPress.' };
  }

  // Nota: Esta ruta no envía emails (los webhooks ya mandan los correspondientes).
  return { ok: true, cancelada: true, inmediata: true, stripe: { huboSuscripciones } };
}

module.exports = desactivarMembresiaClub;
