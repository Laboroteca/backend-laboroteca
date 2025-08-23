// 📁 services/desactivarMembresiaClub.js

const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

const { enviarConfirmacionBajaClub } = require('./email'); // (no se usa por defecto; ver nota en Paso 4)
const { syncMemberpressClub } = require('./syncMemberpressClub'); // intencionadamente NO usado aquí (solo al final de ciclo)
const { alertAdmin } = require('../utils/alertAdmin');
const { registrarBajaClub } = require('./registrarBajaClub');
const { enviarEmailSolicitudBajaVoluntaria } = require('./email');

const MEMBERSHIP_ID = parseInt(process.env.MEMBERSHIP_ID || '10663', 10);
const ACTIVE_STATUSES = ['active', 'trialing', 'incomplete', 'past_due'];

const nowISO = () => new Date().toISOString();

/**
 * Baja voluntaria del Club (con password):
 * - Valida credenciales en WP.
 * - Programa la cancelación en Stripe al final del ciclo (cancel_at_period_end=true).
 * - Registra en Firestore (bajasClub) y en Google Sheets:
 *   - C = fechaSolicitud
 *   - E = fechaEfectos (current_period_end)
 *   - F = "PENDIENTE"
 * - NO desactiva MemberPress ni marca Firestore usuariosClub.activo=false ahora.
 *   (Eso se hará cuando Stripe envíe `customer.subscription.deleted` al final del ciclo,
 *    o mediante el job de verificación).
 *
 * @param {string} email
 * @param {string} password
 * @param {boolean} enviarEmailConfirmacion  // ⬅ Mantenido por compatibilidad. No enviamos por defecto para evitar confusión.
 * @returns {Promise<{ok:boolean, cancelada:boolean, voluntaria:true, suscripciones:number, fechasEfectos?:string[]}>}
 */
async function desactivarMembresiaClub(email, password, enviarEmailConfirmacion = true) {
  // ────────────────────────────────────────────────────────────────────────────
  // Validación de entrada
  // ────────────────────────────────────────────────────────────────────────────
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { ok: false, mensaje: 'Email inválido.' };
  }
  if (!password || typeof password !== 'string' || password.length < 4) {
    return { ok: false, mensaje: 'Contraseña incorrecta.' };
  }
  email = email.trim().toLowerCase();

  // ────────────────────────────────────────────────────────────────────────────
  // Paso 0: Validar credenciales en WP (no elimina usuario, solo verifica acceso)
  // ────────────────────────────────────────────────────────────────────────────
  try {
    const resp = await axios.post(
      'https://www.laboroteca.es/wp-json/laboroteca/v1/verificar-login',
      { email, password },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.LABOROTECA_API_KEY,
        },
        timeout: 15000,
      }
    );

    console.log(`[BajaClub] 🔐 Validación WP para ${email}:`, resp.data);
    if (!resp?.data?.ok) {
      const msg = resp?.data?.mensaje || 'Credenciales no válidas';
      console.warn(`[BajaClub] ❌ Validación incorrecta para ${email}: ${msg}`);
      return { ok: false, mensaje: 'Contraseña incorrecta' };
    }
  } catch (err) {
    const msg = err?.response?.data?.mensaje || err?.message || 'Error al validar credenciales.';
    console.error(`[BajaClub] ❌ Error validando en WP: ${msg}`);
    await alertAdmin({
      area: 'desactivarMembresiaClub_login',
      email,
      err,
      meta: { email },
    });
    return { ok: false, mensaje: 'Contraseña incorrecta' };
  }

  console.log(`[BajaClub] 🔄 Iniciando baja VOLUNTARIA (programada fin de ciclo) para ${email}`);

  // ────────────────────────────────────────────────────────────────────────────
  // Paso 1: Stripe — Programar cancelación al final del ciclo
  // ────────────────────────────────────────────────────────────────────────────
  let suscripcionesActualizadas = 0;
  const fechasEfectos = [];

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

        const upd = await stripe.subscriptions.update(sub.id, {
          cancel_at_period_end: true,
          metadata: {
            ...(sub.metadata || {}),
            motivo_baja: 'baja_voluntaria',
            origen_baja: 'formulario_usuario',
            email, // redundante pero útil para trazas
          },
        });

        const cpe = upd?.current_period_end ?? sub.current_period_end; // epoch seconds
        const fechaEfectosISO = new Date(cpe * 1000).toISOString();
        fechasEfectos.push(fechaEfectosISO);
        suscripcionesActualizadas++;

        // Firestore: baja programada
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
          await alertAdmin({
            area: 'desactivarMembresiaClub_firestore_baja',
            email,
            err: e,
            meta: { subscriptionId: sub.id, fechaEfectosISO },
          });
        }

        // Registrar UNA fila y enviar email inmediato al usuario
        try {
          // nombre/apellidos
          let nombre = '';
          try {
            const df = await firestore.collection('datosFiscalesPorEmail').doc(email).get();
            if (df.exists) {
              const d = df.data() || {};
              nombre = [d.nombre, d.apellidos].filter(Boolean).join(' ').trim();
            }
            if (!nombre) {
              const uc = await firestore.collection('usuariosClub').doc(email).get();
              if (uc.exists) {
                const u = uc.data() || {};
                nombre = [u.nombre, u.apellidos].filter(Boolean).join(' ').trim();
              }
            }
          } catch (_) {}
          await registrarBajaClub({
            email,
            nombre,
            motivo: 'voluntaria',
            fechaSolicitud: nowISO(),
            fechaEfectos: fechaEfectosISO,
            verificacion: 'PENDIENTE'
          });
          await enviarEmailSolicitudBajaVoluntaria(nombre, email, nowISO(), fechaEfectosISO);
        } catch (e) {
          await alertAdmin({ area: 'desactivarMembresiaClub_registro_o_email', email, err: e, meta: { subscriptionId: sub.id, fechaEfectosISO } });
        }

        console.log(`🟢 Stripe: programada baja voluntaria ${sub.id} (efectos=${fechaEfectosISO})`);
      }
    }
  } catch (err) {
    console.error(`❌ Error Stripe (programar baja voluntaria):`, err?.message || err);
    await alertAdmin({
      area: 'desactivarMembresiaClub_stripe_update',
      email,
      err,
      meta: { email },
    });
    // No devolvemos error duro: el cliente podría no tener suscripciones activas.
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Paso 2: NO marcar inactivo ni tocar MemberPress aquí (se hará al final de ciclo)
  // ────────────────────────────────────────────────────────────────────────────
  console.log(`ℹ️ No se desactiva MemberPress ni usuariosClub ahora (baja voluntaria programada).`);

  // ────────────────────────────────────────────────────────────────────────────
  // Paso 3: (Opcional) Email de acuse de solicitud
  //  Nota: Mantenemos silencio por defecto para evitar confusión con “baja inmediata”.
  //        Si deseas enviar un acuse, activa el bloque y adapta la plantilla.
  // ────────────────────────────────────────────────────────────────────────────
  if (false && enviarEmailConfirmacion) { // (bloque heredado, lo mantenemos desactivado)
    try {
      const ref = firestore.collection('usuariosClub').doc(email);
      const doc = await ref.get();
      const nombre = doc.exists ? (doc.data()?.nombre || '') : '';
      // OJO: enviarConfirmacionBajaClub puede decir “baja confirmada”.
      // Cambia por una plantilla de “baja solicitada” si la tienes.
      await enviarConfirmacionBajaClub(email, nombre);
      console.log(`📩 Email de solicitud de baja enviado a ${email}`);
    } catch (err) {
      console.error(`❌ Error al enviar email de solicitud de baja:`, err?.message || err);
      await alertAdmin({
        area: 'desactivarMembresiaClub_email_baja_voluntaria',
        email,
        err,
        meta: { email },
      });
      // No romper el flujo por el email.
    }
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Resultado
  // ────────────────────────────────────────────────────────────────────────────
  return {
    ok: true,
    cancelada: true,
    voluntaria: true,
    suscripciones: suscripcionesActualizadas,
    fechasEfectos: fechasEfectos.length ? fechasEfectos : undefined,
  };
}

module.exports = desactivarMembresiaClub;
