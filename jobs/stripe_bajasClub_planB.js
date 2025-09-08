// jobs/stripe_bajasClub_planB.js
// Plan B de resiliencia Stripe ↔ WP (MemberPress) — MODO AVISO SOLO.
// - Replayer de eventos (Stripe → desde checkpoint)
// - Reconciliador de suscripciones (Stripe Search)
// - Reloj de bajas programadas (Firestore → aviso)
// - (Opcional) Sanity WP→Stripe
//
// REGLA DE ORO: NUNCA DESACTIVAR EN MEMBERPRESS DESDE AQUÍ.
//               SOLO AVISAR AL ADMIN CUANDO HAY MISMATCH.
//
// ENV mínimos:
//   STRIPE_SECRET_KEY
//
// Opcionales:
//   ADMIN_EMAIL=laboroteca@gmail.com
//   BAJAS_COLL=bajasClub
//   ENABLE_PLANB_DAEMON=0|1
//   PLANB_REPLAYER_MS, PLANB_RECONCILER_MS, PLANB_BAJAS_MS, PLANB_SANITY_MS
//   PLANB_MAX_EVENTS=1000
//   PLANB_MAX_ACTS=200
//   PLANB_SLOWDOWN_EVERY=50
//   PLANB_SLOWDOWN_MS=1000
//   PLANB_ALERT_TTL_SECONDS=300
//   PLANB_ENABLE_SANITY=0|1

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
const BAJAS_COLL = process.env.BAJAS_COLL || 'bajasClub';

const MAX_EVENTS_PER_RUN  = parseInt(process.env.PLANB_MAX_EVENTS || '1000', 10);
const MAX_ACTIONS_PER_RUN = parseInt(process.env.PLANB_MAX_ACTS   || '200', 10);
const SLOWDOWN_EVERY      = parseInt(process.env.PLANB_SLOWDOWN_EVERY || '50', 10);
const SLOWDOWN_MS         = parseInt(process.env.PLANB_SLOWDOWN_MS    || '1000', 10);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ===================== Firebase (locks / bajas) ===================== */
const admin = require('../firebase');
const db = admin.firestore();

/* ===================== (NO USAR) Cliente HMAC hacia WP ===================== */
// ❌ No lo importamos para impedir llamadas accidentales a “desactivar”.
// const { syncMemberpressClub } = require('../services/syncMemberpressClub');

/* ===================== Alertas al administrador ===================== */
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'laboroteca@gmail.com';

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
    const payload = {
      area: meta.area || String(subject || 'planB').replace(/^\[|\]$/g, ''),
      email: ADMIN_EMAIL, // fuerza destinatario ADMIN siempre
      err: new Error(text || subject || 'alert'),
      meta,
    };
    await alertAdmin(payload);
    vlog('alerts', 'sent', { area: payload.area, email: payload.email, subject });
  } catch (e) {
    verror('alerts.send_fail', e, { subject });
  }
}

/* ===== Deduplicación ligera (proceso) para avisos genéricos ===== */
const __alertOnce = new Set();
async function notifyOnce(area, err, meta = {}, key = null) {
  try {
    const k = key || `${area}:${JSON.stringify(meta).slice(0, 200)}`;
    if (__alertOnce.has(k)) {
      vlog('notifyOnce', 'skip (dedupe)', { area, key: k });
      return;
    }
    __alertOnce.add(k);
    vlog('notifyOnce', 'arm (first time)', { area, key: k });
    await alertAdmin({ area, email: ADMIN_EMAIL, err, meta, dedupeKey: k });
  } catch (e) {
    verror('notifyOnce.fail', e, { area });
  }
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
      if ((d.expiresAt || 0) > now) {
        const ttl = Math.max(0, Math.round(((d.expiresAt || 0) - now) / 1000));
        vlog('ensureOnce', 'skip (locked)', { ns, key, id, ttl_s: ttl });
        return { skipped: true, reason: 'locked', id, ttl };
      }
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

  if (typeof sub?.customer === 'string' && sub.customer) {
    try {
      const cust = await stripe.customers.retrieve(sub.customer);
      if (cust?.email) return cust.email;
    } catch (e) {
      verror('email.resolve.customer', e, { customer: sub.customer, subId: sub?.id });
    }
  }

  if (!email && evForFallback?.data?.object?.customer && typeof evForFallback.data.object.customer === 'string') {
    try {
      const cust2 = await stripe.customers.retrieve(evForFallback.data.object.customer);
      if (cust2?.email) return cust2.email;
    } catch (e) {
      verror('email.resolve.event_customer', e, { customer: evForFallback.data.object.customer, subId: sub?.id });
    }
  }

  if (!email && typeof sub?.latest_invoice === 'string' && sub.latest_invoice) {
    try {
      const inv = await stripe.invoices.retrieve(sub.latest_invoice, { expand: ['customer'] });
      if (inv?.customer_email) return inv.customer_email;
      if (inv?.customer && typeof inv.customer === 'object' && inv.customer.email) return inv.customer.email;
    } catch (e) {
      verror('email.resolve.invoice', e, { invoice: sub.latest_invoice, subId: sub?.id });
    }
  }

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

/* ===================== Comprobación de estado en MemberPress ===================== */
// Usa services/wpMemberPressList si está disponible (opcional).
async function tryImport(fnPath) { try { return require(fnPath); } catch { return null; } }

let __mpCache = { at: 0, set: null }; // caché 60s
async function isMpActive(email) {
  const svc = await tryImport('../services/wpMemberPressList');
  if (!svc) { vlog('mp.check', 'skip: no svc'); return null; }

  try {
    // Si el servicio expone un método directo, úsalo:
    if (typeof svc.isWpClubActive === 'function') {
      const active = await svc.isWpClubActive(email);
      vlog('mp.check', 'direct', { email, active });
      return !!active;
    }

    // Fallback: listar miembros activos y cachear 60s
    const now = Date.now();
    if (!__mpCache.set || (now - __mpCache.at) > 60_000) {
      const list = await svc.getWpClubMembers(); // debe devolver array de emails activos
      __mpCache = { at: now, set: new Set((list || []).map(e => String(e || '').toLowerCase())) };
      vlog('mp.check', 'refreshed', { size: __mpCache.set.size });
    }
    const ok = __mpCache.set.has(String(email || '').toLowerCase());
    vlog('mp.check', 'cached', { email, active: ok });
    return ok;
  } catch (e) {
    verror('mp.check.fail', e, { email });
    return null; // desconocido
  }
}

/* ======= AVISO de mismatch (NO desactiva) ======= */
async function alertStripeCancelledButMpActive(source, { email, subId, reason, extra = {} }) {
  const key = `planB.mismatch:${source}:${subId || email || 'noEmail'}`;
  const ALERT_TTL = Number(process.env.PLANB_ALERT_TTL_SECONDS || 300);
  return ensureOnce('alertPlanB', key, ALERT_TTL, async () => {
    const subject = 'AVISO: Stripe CANCELADA pero MemberPress ACTIVO (NO se ha desactivado)';
    const text =
`Se ha detectado una incoherencia Stripe→MemberPress.

Estado:
- Stripe: CANCELADA/NO ACTIVA
- MemberPress: ACTIVO

Usuario:
- Email: ${email || 'N/D'}
- SubID: ${subId || 'N/D'}

Origen: ${source}
Motivo: ${reason || 'reconciliación/replay'}

Revisa manualmente en MemberPress y Stripe. (Este Plan B NO desactiva).`;
    await sendAdmin(subject, text, { email, subId, reason, source, ...extra });
  });
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
          const email = await resolveEmail(sub, ev);
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

          if (doDeactivate) {
            if (!email) {
              await notifyOnce('planB.replayer.no_email', new Error('No email found for subscription'), { ...info, subId });
              vlog('replayer', 'no-op (missing email)', { subId });
              return;
            }
            const mpActive = await isMpActive(email);
            if (mpActive === false) {
              vlog('replayer', 'ok: MP ya inactivo', { email, subId });
              return;
            }
            // Si MP activo o desconocido -> avisar
            await alertStripeCancelledButMpActive('replayer', { email, subId, reason: 'replayer_detected', extra: info });
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

        // Si hay que actuar y falta email, intenta resolverlo
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

        const mpActive = await isMpActive(email);
        if (mpActive === false) {
          vlog('reconciler', 'ok: MP ya inactivo', { email, subId: sub.id });
          continue;
        }

        const r = await alertStripeCancelledButMpActive('reconciler', { email, subId: sub.id, reason: 'reconciler_detected', extra: info });
        if (!r?.skipped) acted++;

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
      .limit(500)
      .get();

    const docs = snap.docs.filter(d => {
      const data = d.data() || {};
      let fechaMs = data.fechaEfectosMs;
      if (!fechaMs && data.fechaEfectos) {
        try { fechaMs = new Date(data.fechaEfectos).getTime(); }
        catch { fechaMs = 0; }
      }
      return (fechaMs || 0) <= now;
    });

    if (!docs.length) { vlog('bajaScheduler', 'no pending'); return; }

    let done = 0, skipped = 0;
    for (const doc of docs) {
      if ((done + skipped) >= MAX_ACTIONS_PER_RUN) break;

      const d = doc.data();
      const email = d.email || doc.id;
      let fechaMs = d.fechaEfectosMs;
      if (!fechaMs && d.fechaEfectos) {
        try { fechaMs = new Date(d.fechaEfectos).getTime(); }
        catch { fechaMs = 0; }
      }
      const info = { id: doc.id, email, motivo: d.motivo, fechaEfectosMs: fechaMs };

      const res = await ensureOnce('bajaScheduler', `bajaProg:${doc.id}`, 6 * 3600, async () => {
        // Aquí solo se avisa de que llegó la fecha programada; no comprobamos MP.
        await sendAdmin(
          'Aviso: llegó fecha de BAJA programada (NO se desactiva)',
          `Documento: ${doc.id}\nEmail: ${email}\nMotivo: ${d.motivo || 'N/D'}\nFecha(ms): ${fechaMs}`,
          { email, docId: doc.id, motivo: d.motivo }
        );
        try {
          await doc.ref.set({ estadoBaja: 'avisada', avisadaAt: Date.now() }, { merge: true });
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
        // Antes: desactivar en WP. Ahora: solo aviso.
        vlog('sanity', '⚠️ Miembro en WP sin sub activa en Stripe — aviso', { email });
        await sendAdmin(
          'AVISO: WP activo pero sin suscripción activa en Stripe (NO se desactiva)',
          `Email: ${email}\nOrigen: sanity`,
          { email }
        );
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

/* ===================== Agregador: ejecutar TODO el Plan B ===================== */
async function runAllPlanB() {
  const out = { ok: true, steps: {} };
  try { out.steps.reconciler = await jobReconciler(); }
  catch (e) { verror('planB.full.reconciler', e); out.reconcilerError = e?.message || String(e); out.ok = false; }

  try { out.steps.replayer = await jobReplayer(); }
  catch (e) { verror('planB.full.replayer', e); out.replayerError = e?.message || String(e); out.ok = false; }

  try { out.steps.scheduler = await jobBajasScheduler(); }
  catch (e) { verror('planB.full.scheduler', e); out.schedulerError = e?.message || String(e); out.ok = false; }

  vlog('planB.full', 'end', { ok: out.ok });
  return out;
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
  setTimeout(tick, 1000);
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
    else if (cmd === 'full') {
      const r = await runAllPlanB(); console.log(JSON.stringify({ area: 'planB.full', ...r }));
    }
    else if (cmd === 'daemon')     startDaemon();
    else {
      console.log(`Usage:
  node jobs/stripe_bajasClub_planB.js replayer
  node jobs/stripe_bajasClub_planB.js reconciler
  node jobs/stripe_bajasClub_planB.js bajas
  node jobs/stripe_bajasClub_planB.js sanity
  node jobs/stripe_bajasClub_planB.js full
  node jobs/stripe_bajasClub_planB.js testalert
  node jobs/stripe_bajasClub_planB.js daemon`);
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
  runAllPlanB,
  startDaemon,
};
