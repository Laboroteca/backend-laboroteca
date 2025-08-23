// 📁 jobs/verificarBajasProgramadas.js
const admin = require('../firebase');
const firestore = admin.firestore();
const { syncMemberpressClub } = require('../services/syncMemberpressClub');
const { alertAdmin } = require('../utils/alertAdmin');
const { actualizarVerificacionBaja } = require('../services/registrarBajaClub');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const MEMBERSHIP_ID = parseInt(process.env.MEMBERSHIP_ID || '10663', 10);
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due', 'incomplete']; // consideramos activas para verificación

const nowISO = () => new Date().toISOString();
const fmtES = (d) =>
  new Date(d).toLocaleString('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Verifica y ejecuta bajas voluntarias programadas que ya han llegado a su fecha de efectos.
 * - Comprueba en Stripe que no quede ninguna suscripción activa.
 * - Desactiva en MemberPress (idempotente).
 * - Marca en Firestore la baja como ejecutada/fallida.
 * - Actualiza la MISMA fila en Sheets (col F) a "CORRECTO ✅" o "FALLIDA ❌".
 */
module.exports = async function verificarBajasProgramadas() {
  const ahora = new Date();

  const snap = await firestore
    .collection('bajasClub')
    .where('estadoBaja', 'in', ['pendiente', 'programada'])
    .get();

  for (const doc of snap.docs) {
    const d = doc.data() || {};
    const email = (doc.id || '').toLowerCase();
    const subscriptionId = d.subscriptionId || null;

    // Fecha de efectos (puede venir como Timestamp o ISO/string)
    const fechaEfectos =
      d?.fechaEfectos && typeof d.fechaEfectos?.toDate === 'function'
        ? d.fechaEfectos.toDate()
        : new Date(d?.fechaEfectos || 0);

    if (!email || !email.includes('@')) continue;
    if (isNaN(fechaEfectos.getTime())) continue;
    if (fechaEfectos > ahora) continue; // aún no toca

    // Formato EXACTO del texto que se guardó en la columna E al crear la fila.
    const fechaTxt = fmtES(fechaEfectos);

    try {
      // ─────────────────────────────────────────────────────────────
      // 1) Verificación Stripe — preferir subscriptionId si existe
      // ─────────────────────────────────────────────────────────────
      let stripeOk = true;

      try {
        if (subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          stripeOk = !ACTIVE_STATUSES.includes(sub?.status);
        } else {
          const clientes = await stripe.customers.list({ email, limit: 1 });
          if (clientes?.data?.length) {
            const customerId = clientes.data[0].id;
            const subs = await stripe.subscriptions.list({
              customer: customerId,
              status: 'all',
              limit: 50,
            });
            const sigueActiva = subs.data.some((s) =>
              ACTIVE_STATUSES.includes(s.status)
            );
            stripeOk = !sigueActiva;
          } else {
            // Si no existe customer, lo consideramos OK (no hay subs activas)
            stripeOk = true;
          }
        }
      } catch (e) {
        stripeOk = false;
      }

      // ─────────────────────────────────────────────────────────────
      // 2) Desactivar en MemberPress (idempotente)
      // ─────────────────────────────────────────────────────────────
      const mpResp = await syncMemberpressClub({
        email,
        accion: 'desactivar',
        membership_id: MEMBERSHIP_ID,
      });
      const mpOk = !!mpResp?.ok;

      if (!stripeOk || !mpOk) {
        throw new Error(
          `Verificación baja: stripeOk=${stripeOk}, mpOk=${mpOk}`
        );
      }

      // ─────────────────────────────────────────────────────────────
      // 3) Persistencia correcta
      // ─────────────────────────────────────────────────────────────
      await firestore
        .collection('usuariosClub')
        .doc(email)
        .set({ activo: false, fechaBaja: nowISO() }, { merge: true });

      await firestore
        .collection('bajasClub')
        .doc(email)
        .set(
          {
            estadoBaja: 'ejecutada',
            comprobacionFinal: 'correcto',
            fechaEjecucion: nowISO(),
          },
          { merge: true }
        );

      // Actualizar la MISMA fila en Sheets → F = CORRECTO ✅
      await actualizarVerificacionBaja({
        email,
        fechaTxt, // clave secundaria para encontrar la fila exacta (col E)
        verificacion: 'CORRECTO ✅',
      });

      console.log(
        `[verificarBajasProgramadas] ${email} → CORRECTO (fechaEfectos=${fechaTxt})`
      );
    } catch (err) {
      // ─────────────────────────────────────────────────────────────
      // 4) Fallo → marcar, alertar y actualizar Sheets a FALLIDA ❌
      // ─────────────────────────────────────────────────────────────
      await firestore
        .collection('bajasClub')
        .doc(email)
        .set(
          {
            estadoBaja: 'fallida',
            comprobacionFinal: 'fallida',
            error: String(err?.message || err),
            fechaIntento: nowISO(),
          },
          { merge: true }
        );

      await alertAdmin({
        area: 'baja_programada_fallida',
        email,
        err,
        meta: {
          job: 'verificarBajasProgramadas',
          subscriptionId: subscriptionId || null,
          fechaTxt,
        },
      });

      try {
        await actualizarVerificacionBaja({
          email,
          fechaTxt, // mismo formateo que en la inserción
          verificacion: 'FALLIDA ❌',
        });
      } catch (e) {
        await alertAdmin({
          area: 'sheets_baja_programada_fallida',
          email,
          err: e,
          meta: { job: 'verificarBajasProgramadas', fechaTxt },
        });
      }

      console.warn(
        `[verificarBajasProgramadas] ${email} → FALLIDA (${String(
          err?.message || err
        )})`
      );
    }
  }

  return { ok: true };
};

