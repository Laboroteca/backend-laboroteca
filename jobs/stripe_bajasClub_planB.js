// jobs/stripe_bajasClub_planB.js
// Plan B (AVISO SOLO) — Stripe ↔ MemberPress (checker con HMAC)
// NUNCA desactiva en MemberPress. Solo avisa al ADMIN cuando Stripe está cancelada/no activa
// y MemberPress sigue activo o no verificable. Usa Firestore (bajasClub) para evitar falsos positivos.

'use strict';

/* ========= Versión / banner ========= */
const PLANB_VERSION = 'aviso-only 2025-09-09+hmac';
function banner() {
  console.log(JSON.stringify({ at: new Date().toISOString(), area: 'boot', msg: `PlanB ${PLANB_VERSION}` }));
}
banner();

/* ===================== Stripe ===================== */
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.error(JSON.stringify({ at: new Date().toISOString(), area: 'boot', msg: '❌ Falta STRIPE_SECRET_KEY' }));
  process.exit(1);
}
const Stripe = require('stripe');
const stripe = new Stripe(STRIPE_SECRET_KEY, { maxNetworkRetries: 2 });

/* ===================== Constantes / ENV ===================== */
const BAJAS_COLL = process.env.BAJAS_COLL || 'bajasClub';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'laboroteca@gmail.com';

const MAX_EVENTS_PER_RUN  = parseInt(process.env.PLANB_MAX_EVENTS || '1000', 10);
const MAX_ACTIONS_PER_RUN = parseInt(process.env.PLANB_MAX_ACTS   || '200', 10);
const SLOWDOWN_EVERY      = parseInt(process.env.PLANB_SLOWDOWN_EVERY || '50', 10);
const SLOWDOWN_MS         = parseInt(process.env.PLANB_SLOWDOWN_MS    || '1000', 10);
const ALERT_TTL           = parseInt(process.env.PLANB_ALERT_TTL_SECONDS || '300', 10);

// Checker MU-plugin (WordPress) con HMAC
const MP_CHECK_URL        = process.env.MP_CHECK_URL || 'https://www.laboroteca.es/wp-json/mp/v1/is-active?product_id=10663';
const MP_CHECK_SECRET     = (process.env.MP_CHECK_SECRET || '').trim();
const MP_CHECK_TIMEOUT_MS = parseInt(process.env.MP_CHECK_TIMEOUT_MS || '10000', 10);

const fetch = (global.fetch ? global.fetch : require('node-fetch'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ===================== Firebase (locks / bajas) ===================== */
const admin = require('../firebase');
const db = admin.firestore();

/* ===================== Alertas al administrador ===================== */
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const SMTP2GO_API_URL  = process.env.SMTP2GO_API_URL  || 'https://api.smtp2go.com/v3/email/send';
const SMTP2GO_API_KEY  = process.env.SMTP2GO_API_KEY  || '';
const SMTP2GO_FROM     = process.env.SMTP2GO_FROM_EMAIL || 'laboroteca@laboroteca.es';
const SMTP2GO_FROMNAME = process.env.SMTP2GO_FROM_NAME  || 'Plan B';

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
    for (const [k, v] of Object.entries(input)) out[k] = SENSITIVE_KEYS.test(k) ? mask(v) : redactObject(v);
    return out;
  }
  if (typeof input === 'string') {
    let s = input.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => mask(m));
    s = s.replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, '***REDACTED_PRIVATE_KEY***');
    return s.length > 300 ? s.slice(0, 200) + '…[truncated]' : s;
  }
  return input;
}
function safeStringify(obj) {
  try { let s = JSON.stringify(obj); if (s.length > MAX_LOG_BYTES) s = s.slice(0, MAX_LOG_BYTES) + '…[truncated]'; return s; }
  catch { return String(obj); }
}
function vlog(area, msg, meta = {}) {
  try { console.log(safeStringify({ at: new Date().toISOString(), area, msg, meta: redactObject(meta) })); }
  catch { console.log(`[${area}] ${msg}`); }
}
function verror(area, err, meta = {}) {
  const msg = err?.message || String(err);
  const stack = (err?.stack || '').split('\n').slice(0, 6).join(' | ').slice(0, 600);
  vlog(area, `❌ ${msg}`, { ...meta, stack });
}

/* ===================== Email helpers ===================== */
async function sendViaProxy(subject, text, meta = {}) {
  try {
    await alertAdmin({ area: meta.area || 'planB', email: ADMIN_EMAIL, err: new Error(text || subject || 'alert'), meta });
    vlog('alerts.proxy', 'sent', { subject, to: ADMIN_EMAIL });
  } catch (e) { verror('alerts.proxy.fail', e, { subject }); throw e; }
}
async function sendViaSMTP2GO(subject, text) {
  try {
    if (!SMTP2GO_API_KEY) throw new Error('SMTP2GO_API_KEY vacío');
    const payload = {
      api_key: SMTP2GO_API_KEY,
      to: [ADMIN_EMAIL],
      sender: SMTP2GO_FROM,
      sender_name: SMTP2GO_FROMNAME,
      subject,
      text_body: text,
    };
    const res = await fetch(SMTP2GO_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    vlog('alerts.smtp2go', 'response', { status: res.status, ok: res.ok, body: body.slice(0, 800) });
    if (!res.ok) throw new Error(`SMTP2GO status ${res.status}`);
  } catch (e) { verror('alerts.smtp2go.fail', e, { subject }); throw e; }
}
async function sendAdmin(subject, text, meta = {}) {
  let proxyErr = null, smtpErr = null;
  try { await sendViaProxy(subject, text, meta); } catch (e) { proxyErr = e; }
  try { await sendViaSMTP2GO(subject, text); } catch (e) { smtpErr = e; }
  if (proxyErr && smtpErr) throw new Error('Ambos envíos fallaron');
}

/* ===== Deduplicación ligera (proceso) ===== */
const __alertOnce = new Set();
async function notifyOnce(area, err, meta = {}, key = null) {
  try {
    const k = key || `${area}:${JSON.stringify(meta).slice(0, 200)}`;
    if (__alertOnce.has(k)) { vlog('notifyOnce', 'skip (dedupe)', { area, key: k }); return; }
    __alertOnce.add(k);
    vlog('notifyOnce', 'arm (first time)', { area, key: k });
    await sendViaProxy(`[${area}]`, err?.message || 'notifyOnce', { ...meta, area });
  } catch (e) { verror('notifyOnce.fail', e, { area }); }
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
  try { const out = await fn(); return { ...res, ok: true, out }; }
  finally { /* expira por TTL */ }
}

/* ===================== Util Stripe ===================== */
function extractEmailFromSub(sub) {
  if (sub?.customer && typeof sub.customer === 'object' && sub.customer.email) return sub.customer.email;
  if (sub?.metadata?.email) return sub.metadata.email;
  if (sub?.latest_invoice?.customer_email) return sub.latest_invoice.customer_email;
  if (sub?.latest_invoice?.customer && sub.latest_invoice.customer.email) return sub.latest_invoice.customer.email;
  return null;
}
function needsDeactivation(sub) {
  if (!sub) return false;
  const s = String(sub.status || '').toLowerCase();
  if (['canceled', 'unpaid', 'incomplete_expired'].includes(s)) return true;
  if (sub.cancel_at_period_end && (sub.current_period_end * 1000) <= Date.now()) return true;
  if (s === 'past_due' && sub.cancel_at_period_end && (sub.current_period_end * 1000) <= Date.now()) return true;
  return false;
}
async function resolveEmail(sub, evForFallback = null) {
  let email = extractEmailFromSub(sub);
  if (email) return email;
  if (typeof sub?.customer === 'string' && sub.customer) {
    try { const cust = await stripe.customers.retrieve(sub.customer); if (cust?.email) return cust.email; }
    catch (e) { verror('email.resolve.customer', e, { customer: sub.customer, subId: sub?.id }); }
  }
  if (!email && evForFallback?.data?.object?.customer && typeof evForFallback.data.object.customer === 'string') {
    try { const cust2 = await stripe.customers.retrieve(evForFallback.data.object.customer); if (cust2?.email) return cust2.email; }
    catch (e) { verror('email.resolve.event_customer', e, { customer: evForFallback.data.object.customer, subId: sub?.id }); }
  }
  if (!email && typeof sub?.latest_invoice === 'string' && sub.latest_invoice) {
    try {
      const inv = await stripe.invoices.retrieve(sub.latest_invoice, { expand: ['customer'] });
      if (inv?.customer_email) return inv.customer_email;
      if (inv?.customer && typeof inv.customer === 'object' && inv.customer.email) return inv.customer.email;
    } catch (e) { verror('email.resolve.invoice', e, { invoice: sub.latest_invoice, subId: sub?.id }); }
  }
  if (!email && typeof sub?.default_payment_method === 'string' && sub.default_payment_method) {
    try {
      const pm = await stripe.paymentMethods.retrieve(sub.default_payment_method);
      if (pm?.billing_details?.email) return pm.billing_details.email;
    } catch (e) { verror('email.resolve.payment_method', e, { pm: sub.default_payment_method, subId: sub?.id }); }
  }
  return null;
}

/* ===================== Firestore bajasClub ===================== */
async function getBajaEstado(email, subscriptionId) {
  try {
    if (!email) return null;
    const ref = db.collection(BAJAS_COLL).doc(String(email).toLowerCase());
    const snap = await ref.get();
    if (!snap.exists) return null;
    const d = snap.data() || {};
    let fechaMs = d.fechaEfectosMs;
    if (!fechaMs && d.fechaEfectos) { try { fechaMs = new Date(d.fechaEfectos).getTime(); } catch { fechaMs = 0; } }
    return {
      estadoBaja: d.estadoBaja || null, // "pendiente" | "programada" | "ejecutada" | ...
      motivoFinal: d.motivoFinal || d.motivo || null,
      fechaEfectosMs: fechaMs || 0,
      subscriptionId: d.subscriptionId || null,
    };
  } catch (e) { verror('bajasClub.read.fail', e, { email, subscriptionId }); return null; }
}

/* ===================== Chequeo MemberPress (vía MU-plugin con HMAC) ===================== */
const crypto = require('crypto');

function hmacSha256Hex(secret, msg){
  return crypto.createHmac('sha256', secret).update(msg).digest('hex');
}
function randNonce(){ return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function buildSignedUrl(email){
  const baseUrl = MP_CHECK_URL.includes('?') ? MP_CHECK_URL : (MP_CHECK_URL + '?product_id=10663');
  const u = new URL(baseUrl);
  u.searchParams.set('email', email);
  return u.toString();
}
function buildHeaders(email){
  if (!MP_CHECK_SECRET) return {};
  const ts = Math.floor(Date.now()/1000).toString();
  const nonce = randNonce();
  const url = new URL(MP_CHECK_URL);
  const pid = url.searchParams.get('product_id') || '10663';
  const canonical = `${email}|${pid}|${ts}|${nonce}`;
  const sig = hmacSha256Hex(MP_CHECK_SECRET, canonical);
  return {
    'x-mp-ts': ts,
    'x-mp-nonce': nonce,
    'x-mp-sig': sig,
    'user-agent': 'Laboroteca-PlanB/1.0',
    'accept': 'application/json'
  };
}

async function isMpActive(email) {
  if (!MP_CHECK_URL) { vlog('mp.check', 'skip: sin MP_CHECK_URL'); return null; }
  try {
    const url = buildSignedUrl(email);
    const headers = buildHeaders(email);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), MP_CHECK_TIMEOUT_MS);
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) { vlog('mp.check.http', 'non-200', { status: res.status }); return null; }
    const data = await res.json().catch(() => ({}));
    const active = (typeof data.active === 'boolean') ? data.active : (String(data.status || '').toLowerCase() === 'active');
    vlog('mp.check', 'ok', { email: email.replace(/@.*/,'@…'), active });
    return !!active;
  } catch (e) { verror('mp.check.fail', e, { email: email.replace(/@.*/,'@…') }); return null; }
}

/* ======= AVISO mismatch (NO desactiva) ======= */
async function alertStripeCancelledButMpActive(source, { email, subId, reason, extra = {} }) {
  const key = `mismatch:${source}:${subId || email || 'noEmail'}`;
  return ensureOnce('alertPlanB', key, ALERT_TTL, async () => {
    const subject = 'AVISO: Stripe CANCELADA/no activa pero MemberPress ACTIVO (NO se ha desactivado)';
    const text =
`Se ha detectado una incoherencia Stripe→MemberPress.
Stripe: CANCELADA / NO ACTIVA
MemberPress: ACTIVO (o no verificado)

Email: ${email || 'N/D'}
SubID: ${subId || 'N/D'}
Origen: ${source}
Motivo: ${reason || 'detected'}

Revisa manualmente en MemberPress y Stripe. (Este Plan B NO desactiva).`;
    vlog('planB.mismatch', 'alerting', { source, email, subId, reason });
    await sendAdmin(subject, text, { email, subId, reason, source, ...extra });
  });
}

/* ===================== 1) Replayer ===================== */
const REPLAYER_TYPES = ['customer.subscription.deleted','customer.subscription.updated','invoice.payment_failed'];

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
      const page = await stripe.events.list({ types: REPLAYER_TYPES, created: { gt: since }, limit: 100, starting_after });

      for (const ev of page.data) {
        if (processed + skipped >= MAX_EVENTS_PER_RUN) { hasMore = false; break; }

        maxTs = Math.max(maxTs, ev.created || 0);
        const info = { id: ev.id, type: ev.type, created: ev.created, livemode: ev.livemode };

        const res = await ensureOnce('replayer', ev.id, 3600, async () => {
          vlog('replayer', '→ handle', info);

          let subId = null;
          if (ev.type.startsWith('customer.subscription.')) subId = ev.data?.object?.id;
          else if (ev.type === 'invoice.payment_failed')   subId = ev.data?.object?.subscription || null;
          if (!subId) { vlog('replayer', 'no subId en evento, skip', info); return; }

          const sub = await stripe.subscriptions.retrieve(subId, { expand: ['customer', 'latest_invoice.customer'] });
          const email = await resolveEmail(sub, ev);
          const doDeactivate = needsDeactivation(sub);

          vlog('replayer', 'evaluated', { ...info, subId, status: sub.status, cancel_at_period_end: sub.cancel_at_period_end, current_period_end: sub.current_period_end, email, doDeactivate });

          if (!doDeactivate) { vlog('replayer', 'no-op active', { subId }); return; }
          if (!email) { await notifyOnce('planB.replayer.no_email', new Error('No email for subscription'), { ...info, subId }); return; }

          // Firestore shield
          const baja = await getBajaEstado(email, subId);
          const now = Date.now();
          if (baja) {
            const est = String(baja.estadoBaja || '').toLowerCase();
            if (est === 'ejecutada') { vlog('replayer', 'skip: ejecutada', { email, subId }); return; }
            if (est === 'programada' && (baja.fechaEfectosMs || 0) > now) { vlog('replayer', 'skip: programada futura', { email, subId }); return; }
          }

          const mpActive = await isMpActive(email);
          if (mpActive === false) { vlog('replayer', 'ok: MP ya inactivo', { email, subId }); return; }

          await alertStripeCancelledButMpActive('replayer', { email, subId, reason: mpActive === true ? 'mp_active' : 'mp_not_verified', extra: info });
        });

        if (res?.skipped) { skipped++; vlog('replayer', 'skip (already handled)', info); }
        else { processed++; }
        if (processed % SLOWDOWN_EVERY === 0) await sleep(SLOWDOWN_MS);
      }

      hasMore = page.has_more;
      starting_after = page.data.length ? page.data[page.data.length - 1].id : undefined;
    }

    if (maxTs > since) await setReplayCheckpoint(maxTs);
    vlog('replayer', 'end', { processed, skipped, newCheckpoint: maxTs });
  } catch (e) {
    verror('replayer.fatal', e); await notifyOnce('planB.replayer.fatal', e); throw e;
  }
}

/* ===================== 2) Reconciliación ===================== */
const RECON_QUERY = "status:'canceled' OR status:'unpaid' OR status:'incomplete_expired' OR (status:'past_due' AND cancel_at_period_end:'true')";

async function jobReconciler() {
  try {
    vlog('reconciler', 'start', { query: RECON_QUERY });

    let reviewed = 0, acted = 0;
    let page = null;

    do {
      const res = await stripe.subscriptions.search({ query: RECON_QUERY, limit: 100, page: page || undefined, expand: ['data.customer'] });

      for (const sub of res.data) {
        reviewed++;
        if (acted >= MAX_ACTIONS_PER_RUN) { page = null; break; }

        let email = extractEmailFromSub(sub);
        const doDeactivate = needsDeactivation(sub);
        const info = { subId: sub.id, status: sub.status, cancel_at_period_end: sub.cancel_at_period_end, current_period_end: sub.current_period_end, email, doDeactivate };

        if (!doDeactivate) { vlog('reconciler', 'ok/no-op active', info); continue; }

        if (!email) {
          try {
            const subFull = await stripe.subscriptions.retrieve(sub.id, { expand: ['customer', 'latest_invoice.customer'] });
            email = await resolveEmail(subFull, null);
            info.email = email;
          } catch (e) { verror('reconciler.resolve_email', e, { subId: sub.id }); }
        }
        if (!email) { await notifyOnce('planB.reconciler.no_email', new Error('No email for subscription'), { subId: sub.id, status: sub.status }); continue; }

        // Firestore shield
        const baja = await getBajaEstado(email, sub.id);
        const now = Date.now();
        if (baja) {
          const est = String(baja.estadoBaja || '').toLowerCase();
          if (est === 'ejecutada') { vlog('reconciler', 'skip: ejecutada', { email, subId: sub.id }); continue; }
          if (est === 'programada' && (baja.fechaEfectosMs || 0) > now) { vlog('reconciler', 'skip: programada futura', { email, subId: sub.id }); continue; }
        }

        const mpActive = await isMpActive(email);
        if (mpActive === false) { vlog('reconciler', 'ok: MP ya inactivo', { email, subId: sub.id }); continue; }

        const r = await alertStripeCancelledButMpActive('reconciler', { email, subId: sub.id, reason: mpActive === true ? 'mp_active' : 'mp_not_verified', extra: info });
        if (!r?.skipped) acted++;

        if ((reviewed % SLOWDOWN_EVERY) === 0) await sleep(SLOWDOWN_MS);
      }

      page = res.next_page;
    } while (page);

    vlog('reconciler', 'end', { reviewed, acted });
  } catch (e) {
    verror('reconciler.fatal', e); await notifyOnce('planB.reconciler.fatal', e); throw e;
  }
}

/* ===================== 3) Reloj de bajas programadas ===================== */
async function jobBajasScheduler() {
  try {
    const now = Date.now();
    vlog('bajaScheduler', 'start', { coll: BAJAS_COLL, now });

    const snap = await db.collection(BAJAS_COLL).where('estadoBaja', 'in', ['pendiente','programada']).limit(500).get();

    const docs = snap.docs.filter(d => {
      const data = d.data() || {};
      let fechaMs = data.fechaEfectosMs;
      if (!fechaMs && data.fechaEfectos) { try { fechaMs = new Date(data.fechaEfectos).getTime(); } catch { fechaMs = 0; } }
      return (fechaMs || 0) <= now; // ya debería haberse ejecutado
    });

    if (!docs.length) { vlog('bajaScheduler', 'no pending vencidas'); return; }

    let done = 0, skipped = 0;
    for (const doc of docs) {
      if ((done + skipped) >= MAX_ACTIONS_PER_RUN) break;

      const d = doc.data();
      const email = d.email || doc.id;
      let fechaMs = d.fechaEfectosMs;
      if (!fechaMs && d.fechaEfectos) { try { fechaMs = new Date(d.fechaEfectos).getTime(); } catch { fechaMs = 0; } }
      const info = { id: doc.id, email, motivo: d.motivo || d.motivoFinal, fechaEfectosMs: fechaMs };

      const res = await ensureOnce('bajaScheduler', `bajaProg:${doc.id}`, 6 * 3600, async () => {
        await sendAdmin(
          'Aviso: BAJA programada vencida (NO se desactiva)',
          `Documento: ${doc.id}\nEmail: ${email}\nMotivo: ${d.motivo || d.motivoFinal || 'N/D'}\nFecha(ms): ${fechaMs}`,
          { email, docId: doc.id, motivo: d.motivo || d.motivoFinal }
        );
        try { await doc.ref.set({ estadoBaja: 'avisada', avisadaAt: Date.now() }, { merge: true }); }
        catch (e) { verror('bajaScheduler.firestore_update_fail', e, info); await notifyOnce('planB.bajas.firestore_update_fail', e, info, `planB.bajas.firestore_update_fail:${doc.id}`); throw e; }
      });

      if (res?.skipped) { skipped++; vlog('bajaScheduler', 'skip (locked)', info); }
      else { done++; vlog('bajaScheduler', 'ok', info); }

      if (((done + skipped) % SLOWDOWN_EVERY) === 0) await sleep(SLOWDOWN_MS);
    }

    vlog('bajaScheduler', 'end', { done, skipped });
  } catch (e) {
    verror('bajaScheduler.fatal', e); await notifyOnce('planB.bajas.fatal', e); throw e;
  }
}

/* ===================== 4) (Opcional) Sanity ===================== */
async function jobSanity() {
  try {
    // Comprobar miembros activos en WP que NO tengan sub activa en Stripe (solo aviso)
    // Este job es opcional; activar con ENABLE_PLANB_SANITY=1 en daemon.
    vlog('sanity', 'skip (no listado masivo implementado en este modo)');
  } catch (e) { verror('sanity.fatal', e); await notifyOnce('planB.sanity.fatal', e); throw e; }
}

/* ===================== Agregador / Daemon / CLI ===================== */
async function runAllPlanB() {
  const out = { ok: true, steps: {} };
  try { out.steps.reconciler = await jobReconciler(); } catch (e) { verror('planB.full.reconciler', e); out.reconcilerError = e?.message || String(e); out.ok = false; }
  try { out.steps.replayer   = await jobReplayer();   } catch (e) { verror('planB.full.replayer', e);   out.replayerError   = e?.message || String(e); out.ok = false; }
  try { out.steps.scheduler  = await jobBajasScheduler(); } catch (e) { verror('planB.full.scheduler', e);  out.schedulerError  = e?.message || String(e); out.ok = false; }
  vlog('planB.full', 'end', { ok: out.ok }); return out;
}

function makePoller(name, ms, fn) {
  let running = false;
  const tick = async () => { if (running) return; running = true; try { await fn(); } catch (e) { verror(`${name}.poll`, e); } finally { running = false; } };
  setInterval(tick, ms); setTimeout(tick, 1000);
  vlog('planB.daemon', `poller ${name} armado`, { everyMs: ms });
}
function startDaemon() {
  const REPLAYER_MS   = parseInt(process.env.PLANB_REPLAYER_MS   || '120000', 10);
  const RECONC_MS     = parseInt(process.env.PLANB_RECONCILER_MS || '300000', 10);
  const BAJAS_MS      = parseInt(process.env.PLANB_BAJAS_MS      || '60000',  10);
  const SANITY_MS     = parseInt(process.env.PLANB_SANITY_MS     || '3600000',10);
  const ENABLE_SANITY = String(process.env.PLANB_ENABLE_SANITY || '0') === '1';

  makePoller('replayer',   REPLAYER_MS, jobReplayer);
  makePoller('reconciler', RECONC_MS,   jobReconciler);
  makePoller('bajas',      BAJAS_MS,    jobBajasScheduler);
  if (ENABLE_SANITY) makePoller('sanity', SANITY_MS, jobSanity);

  vlog('planB.daemon', 'iniciado', { REPLAYER_MS, RECONC_MS, BAJAS_MS, SANITY_MS, ENABLE_SANITY });
}

async function main() {
  const cmd = (process.argv[2] || '').toLowerCase();
  try {
    if (cmd === 'replayer')        await jobReplayer();
    else if (cmd === 'reconciler') await jobReconciler();
    else if (cmd === 'bajas')      await jobBajasScheduler();
    else if (cmd === 'sanity')     await jobSanity();
    else if (cmd === 'testalert')  await sendAdmin('[PlanB][TEST]', 'Prueba de alertas OK', { service: 'PlanB aviso-only' });
    else if (cmd === 'full')       { const r = await runAllPlanB(); console.log(JSON.stringify({ area: 'planB.full', ...r })); }
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
    verror('planB.main', e, { cmd }); await notifyOnce('planB.main.fatal', e, { cmd }); process.exitCode = 1;
  }
}

if (require.main === module) { main(); }
else {
  if (String(process.env.ENABLE_PLANB_DAEMON || '0') === '1') {
    try { startDaemon(); vlog('planB.daemon', 'autostart via import + ENABLE_PLANB_DAEMON=1'); }
    catch (e) { verror('planB.daemon.autostart', e); }
  }
}

module.exports = { jobReplayer, jobReconciler, jobBajasScheduler, jobSanity, runAllPlanB, startDaemon };
