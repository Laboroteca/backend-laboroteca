// jobs/stripe_planB.js
// Plan B de resiliencia Stripe ↔ WP (MemberPress).
// Replayer de eventos, Reconciliador de suscripciones, Reloj de bajas programadas
// y (opcional) sanity WP→Stripe. Verboso pero sin filtrar secretos.
//
// ENV mínimos:
//   STRIPE_SECRET_KEY
//   MP_SYNC_API_URL_CLUB, MP_SYNC_API_KEY, MP_SYNC_HMAC_SECRET
// Opcionales:
//   MP_SYNC_DEBUG=1, BAJAS_COLL=bajasClub, CLUB_MEMBERSHIP_ID=10663, PLANB_LOG_LEVEL=debug

'use strict';

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const CLUB_MEMBERSHIP_ID = parseInt(process.env.CLUB_MEMBERSHIP_ID || '10663', 10);
const BAJAS_COLL = process.env.BAJAS_COLL || 'bajasClub';

// Firebase (locks / bajas programadas) — NO loguea secretos
const admin = require('../firebase');
const db = admin.firestore();

// Cliente HMAC hacia WP (MU plugin)
const { syncMemberpressClub } = require('../services/syncMemberpressClub');

/* ===================== Logger seguro ===================== */
const SENSITIVE_KEYS = /(^|_)(private|secret|token|key|password|sig|hmac|authorization|stripe_signature)$/i;
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
    // Oculta emails/PEMs y recorta textos larguísimos
    let s = input.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => mask(m));
    s = s.replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '***REDACTED_PRIVATE_KEY***');
    return s.length > 300 ? s.slice(0, 200) + '…[truncated]' : s;
  }
  return input;
}
function safeStringify(obj) {
  let s = JSON.stringify(obj);
  if (s.length > MAX_LOG_BYTES) s = s.slice(0, MAX_LOG_BYTES) + '…[truncated]';
  return s;
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
    // dejamos expirar
  }
}

/* ===================== Util Stripe ===================== */
function extractEmailFromSub(sub) {
  return sub?.customer_details?.email || sub?.metadata?.email || null;
}
function needsDeactivation(sub) {
  if (!sub) return false;
  if (sub.status === 'canceled') return true;
  if (sub.cancel_at_period_end && (sub.current_period_end * 1000) < Date.now()) return true;
  return false;
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
  const since = await getReplayCheckpoint();
  vlog('replayer', 'start', { since });

  let hasMore = true, starting_after;
  let processed = 0, skipped = 0, maxTs = since;

  while (hasMore) {
    const page = await stripe.events.list({
      types: REPLAYER_TYPES, created: { gt: since }, limit: 100, starting_after,
    });

    for (const ev of page.data) {
      maxTs = Math.max(maxTs, ev.created || 0);
      const info = { id: ev.id, type: ev.type, created: ev.created, livemode: ev.livemode };

      const res = await ensureOnce('replayer', ev.id, 3600, async () => {
        vlog('replayer', '→ handle', info);

        let subId = null;
        if (ev.type.startsWith('customer.subscription.')) subId = ev.data?.object?.id;
        else if (ev.type === 'invoice.payment_failed') subId = ev.data?.object?.subscription || null;

        if (!subId) { vlog('replayer', 'no subId en evento, skip', info); return; }

        const sub = await stripe.subscriptions.retrieve(subId);
        const email = extractEmailFromSub(sub);
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
          await syncMemberpressClub({ email, accion: 'desactivar', membership_id: CLUB_MEMBERSHIP_ID });
          vlog('replayer', '→ desactivar OK', { subId, email });
        } else {
          vlog('replayer', 'no-op', { subId, email });
        }
      });

      if (res.skipped) { skipped++; vlog('replayer', 'skip (already handled)', info); }
      else { processed++; vlog('replayer', 'done', info); }
    }

    hasMore = page.has_more;
    starting_after = page.data.length ? page.data[page.data.length - 1].id : undefined;
  }

  if (maxTs > since) await setReplayCheckpoint(maxTs);
  vlog('replayer', 'end', { processed, skipped, newCheckpoint: maxTs });
}

/* ===================== 2) Reconciliación ===================== */
const RECON_QUERY =
  "status:'canceled' OR status:'unpaid' OR status:'incomplete_expired' OR cancel_at_period_end:'true'";
async function jobReconciler() {
  vlog('reconciler', 'start', { query: RECON_QUERY });

  let reviewed = 0, acted = 0;
  let page = null;

  do {
    const res = await stripe.subscriptions.search({ query: RECON_QUERY, limit: 100, page: page || undefined });

    for (const sub of res.data) {
      reviewed++;
      const email = extractEmailFromSub(sub);
      const doDeactivate = needsDeactivation(sub);
      const info = {
        subId: sub.id,
        status: sub.status,
        cancel_at_period_end: sub.cancel_at_period_end,
        current_period_end: sub.current_period_end,
        email,
        doDeactivate,
      };

      if (!doDeactivate || !email) { vlog('reconciler', 'ok/no-op', info); continue; }

      const lock = await ensureOnce('reconciler', sub.id, 24 * 3600, async () => {
        vlog('reconciler', '→ desactivar en WP', info);
        await syncMemberpressClub({ email, accion: 'desactivar', membership_id: CLUB_MEMBERSHIP_ID });
      });
      if (!lock.skipped) { acted++; vlog('reconciler', 'ok', info); }
      else { vlog('reconciler', 'skip (locked)', info); }
    }

    page = res.next_page;
  } while (page);

  vlog('reconciler', 'end', { reviewed, acted });
}

/* ===================== 3) Reloj de bajas programadas ===================== */
async function jobBajasScheduler() {
  const now = Date.now();
  vlog('bajaScheduler', 'start', { coll: BAJAS_COLL, now });

  const snap = await db.collection(BAJAS_COLL)
    .where('estadoBaja', '==', 'programada')
    .where('fechaEfectosMs', '<=', now)
    .limit(200).get();

  if (snap.empty) { vlog('bajaScheduler', 'no pending'); return; }

  let done = 0, skipped = 0;
  for (const doc of snap.docs) {
    const d = doc.data();
    const email = d.email;
    const key = `bajaProg:${doc.id}`;
    const info = { id: doc.id, email, motivo: d.motivo, fechaEfectosMs: d.fechaEfectosMs };

    const res = await ensureOnce('bajaScheduler', key, 6 * 3600, async () => {
      vlog('bajaScheduler', '→ desactivar en WP', info);
      await syncMemberpressClub({ email, accion: 'desactivar', membership_id: CLUB_MEMBERSHIP_ID });
      await doc.ref.set({ estadoBaja: 'ejecutada', ejecutadaAt: Date.now() }, { merge: true });
    });

    if (res.skipped) { skipped++; vlog('bajaScheduler', 'skip (locked)', info); }
    else { done++; vlog('bajaScheduler', 'ok', info); }
  }

  vlog('bajaScheduler', 'end', { done, skipped });
}

/* ===================== 4) (Opcional) Sanity ===================== */
async function tryImport(fnPath) { try { return require(fnPath); } catch { return null; } }
async function jobSanity() {
  const svc = await tryImport('../services/wpMemberPressList');
  if (!svc || typeof svc.getWpClubMembers !== 'function') {
    vlog('sanity', 'skip: falta services/wpMemberPressList.getWpClubMembers()');
    return;
  }
  const emails = await svc.getWpClubMembers();
  vlog('sanity', 'start', { candidates: emails.length });
  let fixed = 0;

  for (const email of emails) {
    const res = await stripe.subscriptions.search({
      query: `status:'active' AND metadata['email']:'${email}'`,
      limit: 1,
    });
    if (!res.data.length) {
      vlog('sanity', '→ desactivar (sin sub activa en Stripe)', { email });
      await syncMemberpressClub({ email, accion: 'desactivar', membership_id: CLUB_MEMBERSHIP_ID });
      fixed++;
    } else {
      vlog('sanity', 'ok', { email, subId: res.data[0].id });
    }
  }
  vlog('sanity', 'end', { fixed });
}

/* ===================== CLI ===================== */
async function main() {
  const cmd = (process.argv[2] || '').toLowerCase();
  try {
    if (cmd === 'replayer')       await jobReplayer();
    else if (cmd === 'reconciler')await jobReconciler();
    else if (cmd === 'bajas')     await jobBajasScheduler();
    else if (cmd === 'sanity')    await jobSanity();
    else {
      console.log(`Usage:
  node jobs/stripe_planB.js replayer
  node jobs/stripe_planB.js reconciler
  node jobs/stripe_planB.js bajas
  node jobs/stripe_planB.js sanity`);
      process.exitCode = 2;
    }
  } catch (e) {
    verror('planB', e);
    process.exitCode = 1;
  }
}
if (require.main === module) main();
