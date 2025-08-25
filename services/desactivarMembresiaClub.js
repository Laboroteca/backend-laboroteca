// 📁 services/desactivarMembresiaClub.js

const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

const { alertAdminProxy: alertAdmin } = require('./utils/alertAdminProxy');
const { registrarBajaClub } = require('./registrarBajaClub');
const { enviarEmailSolicitudBajaVoluntaria } = require('./email'); // acuse inmediato

// Importante: no incluimos 'incomplete' para evitar suscripciones sin period_end estable
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

const nowISO = () => new Date().toISOString();

/** Resolución robusta del NOMBRE y APELLIDOS para la fila de baja y el email */
async function getNombreCompleto(email, subContext) {
  // 1) datosFiscalesPorEmail
  try {
    const df = await firestore.collection('datosFiscalesPorEmail').doc(email).get();
    if (df.exists) {
      const d = df.data() || {};
      const full = [d.nombre, d.apellidos].filter(Boolean).join(' ').trim();
      if (full) return full;
    }
  } catch (_) {}
  // 2) usuariosClub
  try {
    const uc = await firestore.collection('usuariosClub').doc(email).get();
    if (uc.exists) {
      const u = uc.data() || {};
      const full = [u.nombre, u.apellidos].filter(Boolean).join(' ').trim();
      if (full) return full;
    }
  } catch (_) {}
  // 3) subscription.metadata (si viene en contexto)
  try {
    const meta = (subContext?.metadata || {});
    const n = (meta.nombre || '').trim();
    const a = (meta.apellidos || '').trim();
    const full = [n, a].filter(Boolean).join(' ').trim();
    if (full) return full;
  } catch (_) {}
  // 4) Stripe Customer.name
  try {
    const custId = subContext?.customer;
    if (custId) {
      const cust = await stripe.customers.retrieve(custId);
      if (cust?.name) return String(cust.name).trim();
    } else if (email) {
      const clientes = await stripe.customers.list({ email, limit: 1 });
      const cust = clientes?.data?.[0];
      if (cust?.name) return String(cust.name).trim();
    }
  } catch (_) {}
  // 5) fallback al local-part del email
  return email.split('@')[0] || 'cliente';
}

/** Calcula la fecha de efectos (ISO) priorizando cancel_at; si no, item.current_period_end; si no, calcula por ancla */
function computeFechaEfectosISO({ updated, refreshed, original }) {
  const s = refreshed || updated || original || {};
  const item0 = s?.items?.data?.[0];

  // 1) Stripe fija cancel_at cuando pones cancel_at_period_end=true → es EL día de efectos correcto
  const cancelAtSec = Number(s?.cancel_at) || 0;
  if (Number.isFinite(cancelAtSec) && cancelAtSec > 0) {
    return new Date(cancelAtSec * 1000).toISOString();
  }

  // 2) current_period_end en el item (más fiable que el root en ciertos casos)
  const itemCpe = Number(item0?.current_period_end) || 0;
  if (Number.isFinite(itemCpe) && itemCpe > 0) {
    return new Date(itemCpe * 1000).toISOString();
  }

  // 3) Fallback al root
  const rootCpe = Number(s?.current_period_end) || 0;
  if (Number.isFinite(rootCpe) && rootCpe > 0) {
    return new Date(rootCpe * 1000).toISOString();
  }

  // 4) Último recurso: aproximar a partir de billing_cycle_anchor + intervalo del plan
  const anchor = Number(s?.billing_cycle_anchor) || 0;
  if (Number.isFinite(anchor) && anchor > 0) {
    const interval = item0?.price?.recurring?.interval || item0?.plan?.interval || 'month';
    const count = Number(item0?.price?.recurring?.interval_count || item0?.plan?.interval_count || 1);
    const mult =
      interval === 'year' ? 365 * 24 * 3600 :
      interval === 'week' ? 7 * 24 * 3600 :
      /* month aprox */     30 * 24 * 3600;
    const efectosSec = anchor + (count * mult);
    if (Number.isFinite(efectosSec) && efectosSec > 0) {
      return new Date(efectosSec * 1000).toISOString();
    }
  }

  return null; // sin fecha fiable
}

/**
 * Baja VOLUNTARIA (usuario y password).
 * OJO: no desactiva MemberPress ni usuariosClub aquí (eso ocurre al llegar la fecha de efectos vía webhook/job).
 */
async function desactivarMembresiaClub(email, password, enviarEmailConfirmacion = true /* compat, no se usa */) {
  // Validaciones
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { ok: false, mensaje: 'Email inválido.' };
  }
  if (!password || typeof password !== 'string' || password.length < 4) {
    return { ok: false, mensaje: 'Contraseña incorrecta.' };
  }
  email = email.trim().toLowerCase();

  // Paso 0) Validar credenciales en WP (solo verifica, no elimina)
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
    if (!resp?.data?.ok) {
      const msg = resp?.data?.mensaje || 'Credenciales no válidas';
      return { ok: false, mensaje: 'Contraseña incorrecta' };
    }
  } catch (err) {
    const msg = err?.response?.data?.mensaje || err?.message || 'Error al validar credenciales.';
    await alertAdmin({ area: 'desactivarMembresiaClub_login', email, err, meta: { email } });
    return { ok: false, mensaje: 'Contraseña incorrecta' };
  }

  // Paso 1) Stripe — Programar fin de ciclo
  let suscripcionesActualizadas = 0;
  const fechasEfectos = [];
  const fechaSolicitudISO = nowISO(); // misma fecha para Sheets y email

  try {
    const clientes = await stripe.customers.list({ email, limit: 1 });
    if (!clientes?.data?.length) {
      // sin cliente en Stripe → no hay nada que programar (pero no rompemos)
      await alertAdmin({
        area: 'baja_voluntaria_sin_cliente_stripe',
        email,
        err: new Error('Cliente no encontrado en Stripe'),
        meta: {}
      });
    } else {
      const customerId = clientes.data[0].id;
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 25,
      });

      for (const sub of subs.data) {
        // Solo suscripciones realmente activas o en ciclo
        if (!ACTIVE_STATUSES.includes(sub.status)) continue;

        // Programar cancelación al fin de ciclo
        const updated = await stripe.subscriptions.update(sub.id, {
          cancel_at_period_end: true,
          metadata: {
            ...(sub.metadata || {}),
            motivo_baja: 'baja_voluntaria',
            origen_baja: 'formulario_usuario',
            email, // redundante pero útil para trazas
          },
        });

        // Releer para obtener cancel_at consistente (Stripe lo rellena)
        let refreshed = null;
        try { refreshed = await stripe.subscriptions.retrieve(sub.id); } catch (_) {}

        // Fecha de efectos robusta
        const fechaEfectosISO = computeFechaEfectosISO({ updated, refreshed, original: sub });
        if (!fechaEfectosISO) {
          await alertAdmin({
            area: 'baja_voluntaria_sin_cpe',
            email,
            err: new Error('Sin fecha de efectos fiable'),
            meta: { subscriptionId: sub.id, status: (refreshed || updated || sub)?.status, cancel_at: (refreshed || updated || sub)?.cancel_at }
          });
          // No cortamos todo el flujo por una subs rara: saltamos esta y seguimos
          continue;
        }

        fechasEfectos.push(fechaEfectosISO);
        suscripcionesActualizadas++;

        // Firestore: baja programada (para job/verificación posterior)
        try {
          await firestore.collection('bajasClub').doc(email).set(
            {
              tipoBaja: 'voluntaria',
              origen: 'formulario_usuario',
              subscriptionId: sub.id,
              fechaSolicitud: fechaSolicitudISO,
              fechaEfectos: fechaEfectosISO,
              estadoBaja: 'programada', // pendiente/programada/ejecutada/fallida
              comprobacionFinal: 'pendiente',
            },
            { merge: true }
          );
        } catch (e) {
          await alertAdmin({
            area: 'desactivarMembresiaClub_firestore_baja',
            email,
            err: e,
            meta: { subscriptionId: sub.id, fechaEfectosISO },
          });
        }

        // Nombre y email de acuse + fila única en Sheets
        try {
          const nombre = await getNombreCompleto(email, (refreshed || updated || sub));

          await registrarBajaClub({
            email,
            nombre,
            motivo: 'voluntaria',
            fechaSolicitud: fechaSolicitudISO,  // una sola marca temporal
            fechaEfectos: fechaEfectosISO,      // fin de ciclo correcto
            verificacion: 'PENDIENTE'           // se actualizará a CORRECTO/FALLIDA en la fecha de efectos
          });

          await enviarEmailSolicitudBajaVoluntaria(nombre, email, fechaSolicitudISO, fechaEfectosISO);
          console.log(`[BajaClub] 📩 Acuse de solicitud enviado a ${email}`);
        } catch (e) {
          await alertAdmin({
            area: 'desactivarMembresiaClub_registro_o_email',
            email,
            err: e,
            meta: { subscriptionId: sub.id, fechaEfectosISO }
          });
        }

        console.log(`🟢 Stripe: baja voluntaria programada ${sub.id} (efectos=${fechaEfectosISO})`);
      }
    }
  } catch (err) {
    await alertAdmin({
      area: 'desactivarMembresiaClub_stripe_update',
      email,
      err,
      meta: { email },
    });
    // No devolvemos error duro por si no hubiera suscripciones activas
  }

  // Paso 2) NO tocar MemberPress ni usuariosClub ahora (se hará al ejecutarse la baja)
  console.log(`ℹ️ Baja voluntaria programada. MP y usuariosClub se desactivarán al llegar la fecha de efectos.`);

  // (Compat) Paso 3) No usamos enviarConfirmacionBajaClub aquí para evitar confusión con “baja ejecutada”.

  // Resultado
  return {
    ok: true,
    cancelada: true,
    voluntaria: true,
    suscripciones: suscripcionesActualizadas,
    fechasEfectos: fechasEfectos.length ? fechasEfectos : undefined,
  };
}

module.exports = desactivarMembresiaClub;
