// 📁 routes/desactivarMembresiaClub.js

const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

const { syncMemberpressClub } = require('../services/syncMemberpressClub');
const { guardarEnGoogleSheets } = require('../services/googleSheets');
const { alertAdmin } = require('../utils/alertAdmin');

const MEMBERPRESS_ID = 10663;
const ACTIVE_STATUSES = ['active', 'trialing', 'incomplete', 'past_due'];

function nowISO() {
  return new Date().toISOString();
}

/**
 * Baja Club:
 * - Voluntaria (con password): programa cancelación al fin de ciclo (cancel_at_period_end=true).
 * - Inmediata (sin password: impago/eliminación/manual inmediata): corta ya.
 *
 * Importante:
 * - En voluntaria: NO desactivar MemberPress ni marcar Firestore activo=false todavía.
 * - En inmediata: desactivar MP y marcar Firestore activo=false al momento.
 */
async function desactivarMembresiaClub(email, password) {
  // 🔐 Validación básica
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { ok: false, mensaje: 'Email inválido.' };
  }
  email = email.trim().toLowerCase();

  // ¿Es baja voluntaria (formulario)?
  const esVoluntaria = typeof password === 'string';

  // 🔐 Validar credenciales solo si es voluntaria
  if (esVoluntaria) {
    if (password.length < 4) {
      return { ok: false, mensaje: 'Contraseña incorrecta.' };
    }
    try {
      const resp = await axios.post(
        'https://www.laboroteca.es/wp-json/laboroteca/v1/eliminar-usuario',
        { email, password, validarSolo: true },
        {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.LABOROTECA_API_KEY,
          },
          timeout: 15000,
        }
      );
      if (!resp?.data?.ok) {
        const msg = resp?.data?.mensaje || 'Credenciales no válidas';
        return { ok: false, mensaje: msg };
      }
    } catch (err) {
      const msg = err?.response?.data?.mensaje || err.message || 'Error al validar credenciales.';
      console.error('❌ Error validando en WP:', msg);
      return { ok: false, mensaje: msg };
    }
  } else {
    console.log(`⚠️ desactivarMembresiaClub: llamada sin contraseña para ${email} (flujo especial: impago/eliminación/manual inmediata)`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 🔻 Paso 1: Stripe — Programar (voluntaria) o cancelar (inmediata)
  // ─────────────────────────────────────────────────────────────────────────────
  let huboSuscripciones = false;
  try {
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

        if (esVoluntaria) {
          // 🟢 VOLUNTARIA → mantener acceso hasta fin de ciclo
          const upd = await stripe.subscriptions.update(sub.id, {
            cancel_at_period_end: true,
            metadata: {
              ...(sub.metadata || {}),
              motivo_baja: 'baja_voluntaria',
              origen_baja: 'formulario_usuario',
            },
          });

          const cpe = upd?.current_period_end ?? sub.current_period_end; // epoch seconds
          const fechaEfectosISO = new Date(cpe * 1000).toISOString();

          // Firestore: registrar baja programada
          try {
            await firestore.collection('bajasClub').doc(email).set(
              {
                tipoBaja: 'voluntaria',
                origen: 'formulario_usuario',
                subscriptionId: sub.id,
                fechaSolicitud: nowISO(),
                fechaEfectos: fechaEfectosISO,
                estadoBaja: 'programada', // pendiente/programada/ejecutada/fallida
                comprobacionFinal: 'pendiente',
              },
              { merge: true }
            );
          } catch (e) {
            console.error('❌ Firestore (bajasClub programada):', e?.message || e);
            await alertAdmin({ area: 'baja_voluntaria_firestore', email, err: e, meta: { subscriptionId: sub.id } });
          }

          // Sheets: C (solicitud), E (efectos), F (PENDIENTE)
          try {
            await guardarEnGoogleSheets({
              email,
              accion: 'baja_voluntaria_programada',
              fechaSolicitudBaja: nowISO(),  // → Columna C
              fechaEfectosBaja: fechaEfectosISO, // → Columna E
              verificacionBaja: 'PENDIENTE', // → Columna F
              producto: 'el club laboroteca',
            });
          } catch (e) {
            await alertAdmin({
              area: 'sheets_baja_voluntaria',
              email,
              err: e,
              meta: { subscriptionId: sub.id },
            });
          }

          console.log(`🟢 Stripe: programada baja voluntaria ${sub.id} (efectos=${fechaEfectosISO})`);
        } else {
          // 🔴 INMEDIATA (impago/elim/manual inmediata)
          await stripe.subscriptions.cancel(sub.id, { invoice_now: false, prorate: false });
          console.log(`🛑 Stripe: cancelada inmediata ${sub.id} (${email})`);
        }
      }
    }
  } catch (errStripe) {
    console.error('❌ Stripe error:', errStripe?.message || errStripe);
    await alertAdmin({ area: 'stripe_baja', email, err: errStripe });
  }

  // Si no había suscripciones activas, seguimos con los pasos locales en caso inmediato.
  // En voluntaria, no hay que cortar nada local ahora.

  // ─────────────────────────────────────────────────────────────────────────────
  // 🔻 Paso 2: Estados locales — SOLO inmediatas
  // ─────────────────────────────────────────────────────────────────────────────
  if (!esVoluntaria) {
    try {
      await firestore.collection('usuariosClub').doc(email).set(
        {
          activo: false,
          fechaBaja: nowISO(),
        },
        { merge: true }
      );
      console.log(`📉 Firestore: baja inmediata registrada para ${email}`);
    } catch (errFS) {
      console.error('❌ Error Firestore (usuariosClub):', errFS?.message || errFS);
      await alertAdmin({ area: 'firestore_baja_inmediata', email, err: errFS });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 🔻 Paso 3: MemberPress — SOLO inmediatas
  // ─────────────────────────────────────────────────────────────────────────────
  if (!esVoluntaria) {
    try {
      const resp = await syncMemberpressClub({
        email,
        accion: 'desactivar',
        membership_id: MEMBERPRESS_ID,
      });
      console.log(`🧩 MemberPress sync`, resp);
      if (!resp?.ok) {
        return { ok: false, mensaje: `Error desactivando en MemberPress: ${resp?.error || 'Sin mensaje'}` };
      }
    } catch (errMP) {
      console.error('❌ Error MemberPress:', errMP?.message || errMP);
      await alertAdmin({ area: 'memberpress_baja_inmediata', email, err: errMP });
      return { ok: false, mensaje: 'Error al desactivar en MemberPress.' };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 🔻 Paso 4: Email 
  // Evitamos enviar emails desde esta ruta para no duplicar notificaciones.
  //  Los webhooks de Stripe (`invoice.payment_failed` y `customer.subscription.deleted`)
  //  ya envían el email correcto según el motivo (impago / voluntaria / eliminación / manual).
  // ─────────────────────────────────────────────────────────────────────────────
// no-op

  // 🔚 No eliminamos usuario en WordPress en este endpoint.
  //     (La eliminación de cuenta es otro flujo diferente.)

  // Respuesta
  return esVoluntaria
    ? { ok: true, cancelada: true, voluntaria: true }
    : { ok: true, cancelada: true, inmediata: true, stripe: { huboSuscripciones } };
}

module.exports = desactivarMembresiaClub;
