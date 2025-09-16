// 📁 services/desactivarMembresiaClub.js

const admin = require('../firebase');
const firestore = admin.firestore();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');

const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');
const { registrarBajaClub } = require('./registrarBajaClub');
const { enviarEmailSolicitudBajaVoluntaria } = require('./email'); // acuse inmediato

// Importante: no incluimos 'incomplete' para evitar suscripciones sin period_end estable
const ACTIVE_STATUSES = ['active', 'trialing', 'past_due'];

const nowISO = () => new Date().toISOString();
// ✔️ Sentinel para llamadas autenticadas por HMAC desde WP (no romper otros flujos)
const WP_ASSERTED_SENTINEL = process.env.WP_ASSERTED_SENTINEL || '__WP_ASSERTED__';
// Util PII
const maskEmail = (e='') => {
  const [u,d] = String(e).split('@'); if(!u||!d) return '***';
  return `${u.slice(0,2)}***@***${d.slice(-3)}`;
};

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
    // Procesa todos los clientes con ese email para evitar residuales
    const clientes = await stripe.customers.list({ email, limit: 100 });
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
  // Permitimos el "sentinel" cuando la llamada ya viene autenticada por HMAC desde WP.
  const isWpAsserted = (typeof password === 'string' && password === WP_ASSERTED_SENTINEL);
  // Voluntaria solo si: sentinel válido O password real (≥4) que luego validamos contra WP
  if (!isWpAsserted && (!password || typeof password !== 'string' || password.length < 4)) {
    return { ok: false, mensaje: 'Contraseña incorrecta.' };
  }
  email = email.trim().toLowerCase();

// Paso 0) Validar credenciales en WP (solo si NO viene el sentinel)
  if (!isWpAsserted) {
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
        return { ok: false, mensaje: 'Contraseña incorrecta' };
      }
    } catch (err) {
      try { await alertAdmin({
        area: 'desactivarMembresiaClub_login',
        email: maskEmail(email),
        err: { message: err?.message, code: err?.code, type: err?.type },
        meta: { email: maskEmail(email) }
      }); } catch(_) {}
      return { ok: false, mensaje: 'Contraseña incorrecta' };
    }
  }


  // Paso 1) Stripe — Programar fin de ciclo
  let suscripcionesActualizadas = 0;
  const fechasEfectos = [];
  const subscriptionIds = [];
  let firstSubContext = null;
  const fechaSolicitudISO = nowISO(); // misma fecha para Sheets y email

  try {
    // Procesa TODOS los clientes que compartan email (evita residuales si hay duplicados en Stripe)
    const clientes = await stripe.customers.list({ email, limit: 100 });
    if (!clientes?.data?.length) {
      // sin cliente en Stripe → no hay nada que programar (pero no rompemos)
      try { await alertAdmin({
        area: 'baja_voluntaria_sin_cliente_stripe',
        email: maskEmail(email),
        err: { message: 'Cliente no encontrado en Stripe' },
        meta: {}
      }); } catch(_) {}
    } else {
      for (const c of clientes.data) {
        const subs = await stripe.subscriptions.list({
          customer: c.id,
          status: 'all',
          limit: 100,
        });
        for (const sub of subs.data) {
          if (!ACTIVE_STATUSES.includes(sub.status)) continue;
          if (!firstSubContext) firstSubContext = sub;

          const updated = await stripe.subscriptions.update(sub.id, {
            cancel_at_period_end: true,
            metadata: {
              ...(sub.metadata || {}),
              motivo_baja: 'baja_voluntaria',
              origen_baja: 'formulario_usuario',
              email,
            },
          });

          let refreshed = null;
          try { refreshed = await stripe.subscriptions.retrieve(sub.id); } catch (_) {}

          const fechaEfectosISO = computeFechaEfectosISO({ updated, refreshed, original: sub });
          if (!fechaEfectosISO) {
            try { await alertAdmin({
              area: 'baja_voluntaria_sin_cpe',
              email: maskEmail(email),
              err: { message: 'Sin fecha de efectos fiable' },
              meta: { subscriptionId: sub.id, status: (refreshed || updated || sub)?.status, cancel_at: (refreshed || updated || sub)?.cancel_at }
            }); } catch(_) {}
            continue;
          }

          fechasEfectos.push(fechaEfectosISO);
          subscriptionIds.push(sub.id);
          suscripcionesActualizadas++;
          console.log(`🟢 Stripe: baja voluntaria programada ${sub.id} (efectos=${fechaEfectosISO})`);
        }
      }

      // ——— Una sola escritura en bajasClub + un solo acuse/email ———
      if (suscripcionesActualizadas > 0) {
        // fecha final = la más tardía (cuando realmente se pierde el acceso)
        const fechaEfectosFinal = fechasEfectos.sort().slice(-1)[0];
        try {
          await firestore.collection('bajasClub').doc(email).set(
            {
              tipoBaja: 'voluntaria',
              origen: 'formulario_usuario',
              subscriptionIds,
              fechaSolicitud: fechaSolicitudISO,
              fechaEfectos: fechaEfectosFinal,
              estadoBaja: 'programada',
              comprobacionFinal: 'pendiente',
            },
            { merge: true }
          );
        } catch (e) {
          try { await alertAdmin({
            area: 'desactivarMembresiaClub_firestore_baja',
            email: maskEmail(email),
            err: { message: e?.message, code: e?.code, type: e?.type },
            meta: { subscriptionIds, fechaEfectosFinal },
          }); } catch(_) {}
        }

        try {
          const nombre = await getNombreCompleto(email, firstSubContext);
          await registrarBajaClub({
            email,
            nombre,
            motivo: 'voluntaria',
            fechaSolicitud: fechaSolicitudISO,
            fechaEfectos: fechaEfectosFinal,
            verificacion: 'PENDIENTE'
          });
          await enviarEmailSolicitudBajaVoluntaria(nombre, email, fechaSolicitudISO, fechaEfectosFinal);
          console.log(`[BajaClub] 📩 Acuse de solicitud enviado a ${maskEmail(email)}`);
        } catch (e) {
          try { await alertAdmin({
            area: 'desactivarMembresiaClub_registro_o_email',
            email: maskEmail(email),
            err: { message: e?.message, code: e?.code, type: e?.type },
            meta: { subscriptionIds, fechaEfectos: fechasEfectos }
          }); } catch(_) {}
        }
      }
    }
  } catch (err) {
    try { await alertAdmin({
      area: 'desactivarMembresiaClub_stripe_update',
      email: maskEmail(email),
      err: { message: err?.message, code: err?.code, type: err?.type },
      meta: { email: maskEmail(email) },
    }); } catch(_) {}
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
    subscriptionIds: subscriptionIds.length ? subscriptionIds : undefined,
  };
}

module.exports = desactivarMembresiaClub;
