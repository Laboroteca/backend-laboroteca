// jobs/stripe_bajasClub_planB.js
// Plan B de resiliencia Stripe ↔ WP (MemberPress).
// - Replayer de eventos (desde checkpoint)
// - Reconciliador de suscripciones
// - Reloj de bajas programadas (Firestore → WP)
// - (Opcional) Sanity WP→Stripe
//
// ENV mínimos:
//   STRIPE_SECRET_KEY
//   MP_SYNC_API_URL_CLUB, MP_SYNC_API_KEY, MP_SYNC_HMAC_SECRET
//
// Opcionales (recomendado para producción):
//   MP_SYNC_DEBUG=1
//   BAJAS_COLL=bajasClub
//   CLUB_MEMBERSHIP_ID=10663
//   ENABLE_PLANB_DAEMON=0|1
//   PLANB_REPLAYER_MS, PLANB_RECONCILER_MS, PLANB_BAJAS_MS, PLANB_SANITY_MS
//   PLANB_ENABLE_SANITY=0|1
//   PLANB_MAX_EVENTS=1000       # límite por ejecución (replayer)
//   PLANB_MAX_ACTS=200          # límite acciones (reconciler/bajas/sanity)
//   PLANB_SLOWDOWN_EVERY=50     # cada N operaciones, dormir
//   PLANB_SLOWDOWN_MS=1000      # milisegundos de pausa

'use strict';

/* ===================== Stripe ===================== */
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.error(JSON.stringify({
    at: new Date().toISOString(),
    area: 'boot',
    msg: '❌ Falta STRIPE_SECRET_KEY en entorno',
  }));
  process.exit(1);
}

const Stripe = require('stripe');
const stripe = new Stripe(STRIPE_SECRET_KEY, { maxNetworkRetries: 2 });

/* ===================== Constantes ===================== */
const CLUB_MEMBERSHIP_ID = parseInt(process.env.CLUB_MEMBERSHIP_ID || '10663', 10);
const BAJAS_COLL = process.env.BAJAS_COLL || 'bajasClub';

const MAX_EVENTS_PER_RUN  = parseInt(process.env.PLANB_MAX_EVENTS || '1000', 10);
const MAX_ACTIONS_PER_RUN = parseInt(process.env.PLANB_MAX_ACTS   || '200', 10);
const SLOWDOWN_EVERY      = parseInt(process.env.PLANB_SLOWDOWN_EVERY || '50', 10);
const SLOWDOWN_MS         = parseInt(process.env.PLANB_SLOWDOWN_MS    || '1000', 10);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ===================== Firebase (locks / bajas) ===================== */
// NO loguea secretos; inicialización en ../firebase
const admin = require('../firebase');
const db = admin.firestore();

/* ===================== Cliente HMAC hacia WP ===================== */
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

/* ===================== Alertas al administrador ===================== */
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

/* ===================== Logger seguro ===================== */
const SENSITIVE_KEYS =
  /(^|_)(private|secret|token|key|password|sig|hmac|authorization|stripe_signature|api|bearer)$/i;
const MAX_LOG_BYTES = 2048;

function mask(s, keepStart = 3, keepEnd = 2) {
  const v = String(s ?? '');
  if (v.length <= keepStart + keepEnd) return '***';
  return v.slice(0, keepStart) + '…' + v.slice(-keepEnd);
}

function redactObject(input) {
  if (input == null) return input;
  if (Array.isArray(input)) return input.map(redactObject);
  if (typeof input === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      out[k] = SENSITIVE_KEYS.test(k) ? mask(v) : redactObject(v);
    }
    return out;
  }
  if (typeof input === 'string') {
    let s = input.replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      (m) => mask(m)
    );
    s = s.replace(
      /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
      '***REDACTED_PRIVATE_KEY***'
    );
    return s.length > 300 ? s.slice(0, 200) + '…[truncated]' : s;
  }
  return input;
}

function safeStringify(obj) {
  try {
    let s = JSON.stringify(obj);
    if (s.length > MAX_LOG_BYTES) s = s.slice(0, MAX_LOG_BYTES) + '…[truncated]';
    return s;
  } catch {
    return String(obj);
  }
}

function vlog(area, msg, meta = {}) {
  try {
    const line = {
      at: new Date().toISOString(),
      area,
      msg,
      meta: redactObject(meta),
    };
    console.log(safeStringify(line));
  } catch {
    console.log(`[${area}] ${msg}`);
  }
}

function verror(area, err, meta = {}) {
  const msg = err?.message || String(err);
  const stack = (err?.stack || '').split('\n').slice(0, 6).join(' | ').slice(0, 600);
  vlog(area, `❌ ${msg}`, { ...meta, stack });
}

/* ===================== Alertas (helpers) ===================== */
async function sendAdmin(subject, text, meta = {}) {
  try {
    await alertAdmin({ subject, text, meta }); // el proxy espera {subject, text, meta}
    vlog('alerts', 'sent', { subject });
  } catch (e) {
    verror('alerts.send_fail', e, { subject });
  }
}

const __alertOnce = new Set();
async function notifyOnce(area, err, meta = {}, key = null) {
  try {
    const k = key || `${area}:${JSON.stringify(meta).slice(0, 200)}`;
    if (__alertOnce.has(k)) return;
    __alertOnce.add(k);
    const subject = `[${area}] ${err ? 'ERROR' : 'Aviso'}`;
    const text = err ? (err?.message || String(err)) : 'Evento';
    await sendAdmin(subject, text, meta);
  } catch {
    /* silent */
  }
}

// éxito “Plan B ejecutado” (rate-limit 6h por sub/email)
async function alertPlanBSuccess(source, { email, subId, reason, extra = {} }) {
  // Solo se invoca cuando hubo desactivación real (no skip)
  const key = `planB.success:${source}:${subId || email}`;
  return ensureOnce('alertPlanB', key, 6 * 3600, async () => {
    const subject = 'EL PLAN B HA TENIDO QUE DESACTIVAR (BAJA) EN EL CLUB POR FALLO EN BACKEND';
    const text =
`Se ha ejecutado el Plan B por fallo en el Backend principal y se ha DESACTIVADO el acceso en WordPress para el CLUB LABOROTECA.

Usuario afectado:
- Email: ${email}
- SubID: ${subId || 'N/D'}

Motivo: ${reason || 'coherencia Stripe→WP (doDeactivate)'}
Origen: ${source}

Revisa en MemberPress y Stripe.`;
    await sendAdmin(subject, text, { email, subId, reason, source, ...extra });
  });
}

/* ===================== Idempotencia (locks) ===================== */
async function ensureOnce(ns, key, ttlSeconds, fn) {
  const id = `${ns}:${key}`;
  const ref = db.collection('opsLocks').doc(id);
  const now = Date.now();

  const res = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const d = snap.data() || {};
      if ((d.expiresAt || 0) > now) return { skipped: true, reason: 'locked', id };
    }
    tx.set(ref, { createdAt: now, expiresAt: now + ttlSeconds * 1000 }, { merge: true });
    return { skipped: false, id };
  });

  if (res.skipped) return res;

  try {
    const out = await fn();
    return { ...res, ok: true, out };
  } finally {
    // dejamos expirar por TTL
  }
}

/* ===================== Util Stripe ===================== */
function extractEmailFromSub(sub) {
  // 1) Customer expandido
  if (sub?.customer && typeof sub.customer === 'object' && sub.customer.email) {
    return sub.customer.email;
  }
  // 2) Metadata guardada por tu checkout
  if (sub?.metadata?.email) return sub.metadata.email;
  // 3) Fallback: email de la última factura
  if (sub?.latest_invoice?.customer_email) return sub.latest_invoice.customer_email;
  if (sub?.latest_invoice?.customer && sub.latest_invoice.customer.email) {
    return sub.latest_invoice.customer.email;
  }
  return null;
}

function needsDeactivation(sub) {
  if (!sub) return false;
  const s = String(sub.status || '').toLowerCase();
  if (['canceled', 'unpaid', 'incomplete_expired'].includes(s)) return true;
  if (sub.cancel_at_period_end && (sub.current_period_end * 1000) < Date.now()) return true;
  return false;
}

/* ======= Resolver de email (robusto) ======= */
async function resolveEmail(sub, evForFallback = null) {
  let email = extractEmailFromSub(sub);
  if (email) return email;

  // 1) Si sub.customer es un ID, traer el customer
  if (typeof sub?.customer === 'string' && sub.customer) {
    try {
      const cust = await stripe.customers.retrieve(sub.customer);
      if (cust?.email) return cust.email;
    } catch (e) {
      verror('email.resolve.customer', e, { customer: sub.customer, subId: sub?.id });
    }
  }

  // 2) Si venimos de un evento y hay customer en el payload, úsalo
  if (!email && evForFallback?.data?.object?.customer && typeof evForFallback.data.object.customer === 'string') {
    try {
      const cust2 = await stripe.customers.retrieve(evForFallback.data.object.customer);
      if (cust2?.email) return cust2.email;
    } catch (e) {
      verror('email.resolve.event_customer', e, { customer: evForFallback.data.object.customer, subId: sub?.id });
    }
  }

  // 3) latest_invoice como ID (si no estaba expandida)
  if (!email && typeof sub?.latest_invoice === 'string' && sub.latest_invoice) {
    try {
      const inv = await stripe.invoices.retrieve(sub.latest_invoice, { expand: ['customer'] });
      if (inv?.customer_email) return inv.customer_email;
      if (inv?.customer && typeof inv.customer === 'object' && inv.customer.email) return inv.customer.email;
    } catch (e) {
      verror('email.resolve.invoice', e, { invoice: sub.latest_invoice, subId: sub?.id });
    }
  }

  // 4) default_payment_method → billing_details.email
  if (!email && typeof sub?.default_payment_method === 'string' && sub.default_payment_method) {
    try {
      const pm = await stripe.paymentMethods.retrieve(sub.default_payment_method);
      if (pm?.billing_details?.email) return pm.billing_details.email;
    } catch (e) {
      verror('email.resolve.payment_method', e, { pm: sub.default_payment_method, subId: sub?.id });
    }
  }

  return null;
}

/* ======= Deactivación unificada (idempotente + alertas de éxito) ======= */
async function wpDeactivateOnce(email, subId, source, extraMeta = {}, reason = 'doDeactivate') {
  const key = subId ? `sub:${subId}` : `email:${email}`;
  const res = await ensureOnce('wpDeact', key, 24 * 3600, async () => {
    try {
      await syncMemberpressClub({ email, accion: 'desactivar', membership_id: CLUB_MEMBERSHIP_ID });
      vlog(source, '→ desactivar OK', { email, subId, reason });
      // Email al admin SOLO cuando la desactivación se ejecuta (no hay skip)
      await alertPlanBSuccess(source, { email, subId, reason, extra: extraMeta });
    } catch (e) {
      verror(`${source}.sync_fail`, e, { email, subId, reason, ...extraMeta });
      await notifyOnce(`${source}.sync_fail`, e, { email, subId }, `${source}.sync_fail:${subId || email}`);
      throw e;
    }
  });
  if (res.skipped) vlog(source, 'skip wpDeact (recent)', { email, subId });
  return res;
}

/* ===================== 1) Replayer ===================== */
const REPLAYER_TYPES = [
  'customer.subscription.deleted',
  'customer.subscription.updated',
  'invoice.payment_failed',
];

async function getReplayCheckpoint() {
  const ref = db.collection('system').doc('stripeReplay');
  const snap = await ref.get();
  return (snap.exists && snap.data().lastCreated) || 0;
}

async function setReplayCheckpoint(ts) {
  const ref = db.collection('system').doc('stripeReplay');
  await ref.set({ lastCreated: ts, updatedAt: Date.now() }, { merge: true });
}

async function jobReplayer() {
  try {
    const since = await getReplayCheckpoint();
    vlog('replayer', 'start', { since });

    let hasMore = true, starting_after;
    let processed = 0, skipped = 0, maxTs = since;

    while (hasMore) {
      const page = await stripe.events.list({
        types: REPLAYER_TYPES,
        created: { gt: since },
        limit: 100,
        starting_after,
      });

      for (const ev of page.data) {
        if (processed + skipped >= MAX_EVENTS_PER_RUN) {
          hasMore = false;
          break;
        }

        maxTs = Math.max(maxTs, ev.created || 0);
        const info = { id: ev.id, type: ev.type, created: ev.created, livemode: ev.livemode };

        const res = await ensureOnce('replayer', ev.id, 3600, async () => {
          vlog('replayer', '→ handle', info);

          let subId = null;
          if (ev.type.startsWith('customer.subscription.')) subId = ev.data?.object?.id;
          else if (ev.type === 'invoice.payment_failed') subId = ev.data?.object?.subscription || null;

          if (!subId) { vlog('replayer', 'no subId en evento, skip', info); return; }

          const sub = await stripe.subscriptions.retrieve(subId, {
            expand: ['customer', 'latest_invoice.customer'],
          });
          let email = await resolveEmail(sub, ev);
          const doDeactivate = needsDeactivation(sub);

          vlog('replayer', 'evaluated', {
            ...info,
            subId,
            status: sub.status,
            cancel_at_period_end: sub.cancel_at_period_end,
            current_period_end: sub.current_period_end,
            email,
            doDeactivate,
          });

          if (doDeactivate && email) {
            await wpDeactivateOnce(email, subId, 'replayer', info, 'replayer_doDeactivate');
          } else if (doDeactivate && !email) {
            await notifyOnce('planB.replayer.no_email', new Error('No email found for subscription'), { ...info, subId });
            vlog('replayer', 'no-op (missing email)', { subId });
          } else {
            vlog('replayer', 'no-op', { subId, email });
          }
        });

        if (res?.skipped) { skipped++; vlog('replayer', 'skip (already handled)', info); }
        else { processed++; }

        if (processed % SLOWDOWN_EVERY === 0) { await sleep(SLOWDOWN_MS); }
      }

      hasMore = page.has_more;
      starting_after = page.data.length ? page.data[page.data.length - 1].id : undefined;
    }

    if (maxTs > since) await setReplayCheckpoint(maxTs);
    vlog('replayer', 'end', { processed, skipped, newCheckpoint: maxTs });
  } catch (e) {
    verror('replayer.fatal', e);
    await notifyOnce('planB.replayer.fatal', e);
    throw e;
  }
}

/* ===================== 2) Reconciliación ===================== */
// ⚠️ Stripe Search no soporta `cancel_at_period_end`; esa parte la cubre el replayer.
const RECON_QUERY = "status:'canceled' OR status:'unpaid' OR status:'incomplete_expired'";

async function jobReconciler() {
  try {
    vlog('reconciler', 'start', { query: RECON_QUERY });

    let reviewed = 0, acted = 0;
    let page = null;

    do {
      const res = await stripe.subscriptions.search({
        query: RECON_QUERY,
        limit: 100,
        page: page || undefined,
        expand: ['data.customer'],
      });

      for (const sub of res.data) {
        reviewed++;
        if (acted >= MAX_ACTIONS_PER_RUN) { page = null; break; }

        let email = extractEmailFromSub(sub);
        const doDeactivate = needsDeactivation(sub);
        const info = {
          subId: sub.id,
          status: sub.status,
          cancel_at_period_end: sub.cancel_at_period_end,
          current_period_end: sub.current_period_end,
          email,
          doDeactivate,
        };

        // Si hay que actuar y falta email, consulta puntual para resolverlo
        if (doDeactivate && !email) {
          try {
            const subFull = await stripe.subscriptions.retrieve(sub.id, {
              expand: ['customer', 'latest_invoice.customer'],
            });
            email = await resolveEmail(subFull, null);
            info.email = email;
          } catch (e) {
            verror('reconciler.resolve_email', e, { subId: sub.id });
          }
        }

        if (!doDeactivate) { vlog('reconciler', 'ok/no-op', info); continue; }
        if (!email) {
          await notifyOnce('planB.reconciler.no_email', new Error('No email found for subscription'), { subId: sub.id, status: sub.status });
          vlog('reconciler', 'no-op (missing email)', { subId: sub.id });
          continue;
        }

        

        const r = await wpDeactivateOnce(email, null, 'reconciler', info, 'reconciler_doDeactivate');
        if (!r.skipped) acted++;

        if ((reviewed % SLOWDOWN_EVERY) === 0) { await sleep(SLOWDOWN_MS); }
      }

      page = res.next_page;
    } while (page);

    vlog('reconciler', 'end', { reviewed, acted });
  } catch (e) {
    verror('reconciler.fatal', e);
    await notifyOnce('planB.reconciler.fatal', e);
    throw e;
  }
}

/* ===================== 3) Reloj de bajas programadas ===================== */
async function jobBajasScheduler() {
  try {
    const now = Date.now();
    vlog('bajaScheduler', 'start', { coll: BAJAS_COLL, now });

    const snap = await db.collection(BAJAS_COLL)
      .where('estadoBaja', '==', 'programada')
      .limit(500) // traemos más docs y filtramos en memoria
      .get();

    const docs = snap.docs.filter(d => {
      const data = d.data() || {};
      return (data.fechaEfectosMs || 0) <= now;
    });

    if (!docs.length) { vlog('bajaScheduler', 'no pending'); return; }

    let done = 0, skipped = 0;
    for (const doc of docs) {
      if ((done + skipped) >= MAX_ACTIONS_PER_RUN) break;

      const d = doc.data();
      const email = d.email;
      const info = { id: doc.id, email, motivo: d.motivo, fechaEfectosMs: d.fechaEfectosMs };

      const res = await ensureOnce('bajaScheduler', `bajaProg:${doc.id}`, 6 * 3600, async () => {
        await wpDeactivateOnce(email, null, 'bajaScheduler', info, 'baja_programada');
        try {
          await doc.ref.set({ estadoBaja: 'ejecutada', ejecutadaAt: Date.now() }, { merge: true });
        } catch (e) {
          verror('bajaScheduler.firestore_update_fail', e, info);
          await notifyOnce('planB.bajas.firestore_update_fail', e, info, `planB.bajas.firestore_update_fail:${doc.id}`);
          throw e;
        }
      });

      if (res?.skipped) { skipped++; vlog('bajaScheduler', 'skip (locked)', info); }
      else { done++; vlog('bajaScheduler', 'ok', info); }

      if (((done + skipped) % SLOWDOWN_EVERY) === 0) { await sleep(SLOWDOWN_MS); }
    }

    vlog('bajaScheduler', 'end', { done, skipped });
  } catch (e) {
    verror('bajaScheduler.fatal', e);
    await notifyOnce('planB.bajas.fatal', e);
    throw e;
  }
}

/* ===================== 4) (Opcional) Sanity ===================== */
async function tryImport(fnPath) {
  try { return require(fnPath); } catch { return null; }
}

async function jobSanity() {
  try {
    const svc = await tryImport('../services/wpMemberPressList');
    if (!svc || typeof svc.getWpClubMembers !== 'function') {
      vlog('sanity', 'skip: falta services/wpMemberPressList.getWpClubMembers()');
      return;
    }
    const emails = await svc.getWpClubMembers();
    vlog('sanity', 'start', { candidates: emails.length });

    let fixed = 0, reviewed = 0;
    for (const email of emails) {
      reviewed++;
      if (fixed >= MAX_ACTIONS_PER_RUN) break;

      const res = await stripe.subscriptions.search({
        query: `status:'active' AND metadata['email']:'${email}'`,
        limit: 1,
      });

      if (!res.data.length) {
        vlog('sanity', '→ desactivar (sin sub activa en Stripe)', { email });
        await wpDeactivateOnce(email, null, 'sanity', { email }, 'sin_sub_activa');
        fixed++;
      } else {
        vlog('sanity', 'ok', { email, subId: res.data[0].id });
      }

      if ((reviewed % SLOWDOWN_EVERY) === 0) { await sleep(SLOWDOWN_MS); }
    }
    vlog('sanity', 'end', { fixed });
  } catch (e) {
    verror('sanity.fatal', e);
    await notifyOnce('planB.sanity.fatal', e);
    throw e;
  }
}

/* ===================== Daemon interno (opcional) ===================== */
function makePoller(name, ms, fn) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await fn(); }
    catch (e) { verror(`${name}.poll`, e); }
    finally { running = false; }
  };
  setInterval(tick, ms);
  setTimeout(tick, 1000); // primer disparo pronto
  vlog('planB.daemon', `poller ${name} armado`, { everyMs: ms });
}

function startDaemon() {
  const REPLAYER_MS   = parseInt(process.env.PLANB_REPLAYER_MS   || '120000', 10);  // 2 min
  const RECONC_MS     = parseInt(process.env.PLANB_RECONCILER_MS || '300000', 10);  // 5 min
  const BAJAS_MS      = parseInt(process.env.PLANB_BAJAS_MS      || '60000',  10);  // 1 min
  const SANITY_MS     = parseInt(process.env.PLANB_SANITY_MS     || '3600000',10);  // 60 min
  const ENABLE_SANITY = String(process.env.PLANB_ENABLE_SANITY || '0') === '1';

  makePoller('replayer',   REPLAYER_MS, jobReplayer);
  makePoller('reconciler', RECONC_MS,   jobReconciler);
  makePoller('bajas',      BAJAS_MS,    jobBajasScheduler);
  if (ENABLE_SANITY) makePoller('sanity', SANITY_MS, jobSanity);

  vlog('planB.daemon', 'iniciado', { REPLAYER_MS, RECONC_MS, BAJAS_MS, SANITY_MS, ENABLE_SANITY });
}

/* ===================== CLI ===================== */
async function main() {
  const cmd = (process.argv[2] || '').toLowerCase();
  try {
    if (cmd === 'replayer')        await jobReplayer();
    else if (cmd === 'reconciler') await jobReconciler();
    else if (cmd === 'bajas')      await jobBajasScheduler();
    else if (cmd === 'sanity')     await jobSanity();
    else if (cmd === 'testalert')  await sendAdmin('[PlanB][TEST]', 'Prueba de alertas OK', { service: 'Fallback Plan B' });
    else if (cmd === 'daemon')     startDaemon();
    else {
      console.log(`Usage:
  node jobs/stripe_bajasClub_planB.js replayer
  node jobs/stripe_bajasClub_planB.js reconciler
  node jobs/stripe_bajasClub_planB.js bajas
  node jobs/stripe_bajasClub_planB.js sanity
  node jobs/stripe_bajasClub_planB.js testalert
  node jobs/stripe_bajasClub_planB.js daemon   # planificador interno`);
      process.exitCode = 2;
    }
  } catch (e) {
    verror('planB.main', e, { cmd });
    await notifyOnce('planB.main.fatal', e, { cmd });
    process.exitCode = 1;
  }
}

/* ===================== Arranque directo ===================== */
if (require.main === module) {
  main();
} else {
  if (String(process.env.ENABLE_PLANB_DAEMON || '0') === '1') {
    try { startDaemon(); vlog('planB.daemon', 'autostart via import + ENABLE_PLANB_DAEMON=1'); }
    catch (e) { verror('planB.daemon.autostart', e); }
  }
}

module.exports = {
  jobReplayer,
  jobReconciler,
  jobBajasScheduler,
  jobSanity,
  startDaemon,
};
