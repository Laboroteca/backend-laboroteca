// jobs/stripe_bajasClub_planB.js
// Plan B (AVISO SOLO) — Stripe ↔ Firestore (usuariosClub + bajasClub) + MemberPress checker HMAC
// AVISA si: Stripe = cancelada/no activa  && Firestore: usuariosClub/{email}.activo === true
// Ignora si en bajasClub hay "programada" o "pendiente" con fecha futura.
// NO desactiva nada. Incluye logs exhaustivos y resultados de cada sistema en el email.

'use strict';

/* ========= Versión / banner ========= */
const PLANB_VERSION = 'aviso-only 2025-09-09 full+logs+hmac';
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
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'laboroteca@gmail.com';
const USERS_COLL  = process.env.USERS_COLL  || 'usuariosClub';
const BAJAS_COLL  = process.env.BAJAS_COLL  || 'bajasClub';

const MAX_EVENTS_PER_RUN  = parseInt(process.env.PLANB_MAX_EVENTS || '1000', 10);
const MAX_ACTIONS_PER_RUN = parseInt(process.env.PLANB_MAX_ACTS   || '200', 10);
const SLOWDOWN_EVERY      = parseInt(process.env.PLANB_SLOWDOWN_EVERY || '50', 10);
const SLOWDOWN_MS         = parseInt(process.env.PLANB_SLOWDOWN_MS    || '1000', 10);
const ALERT_TTL           = parseInt(process.env.PLANB_ALERT_TTL_SECONDS || '300', 10);

const REPLAYER_TYPES = ['customer.subscription.deleted','customer.subscription.updated','invoice.payment_failed'];
const RECON_QUERY = "status:'canceled' OR status:'unpaid' OR status:'incomplete_expired' OR (status:'past_due' AND cancel_at_period_end:'true')";

// MemberPress checker (WordPress) con HMAC
const MP_CHECK_URL        = process.env.MP_CHECK_URL || 'https://www.laboroteca.es/wp-json/mp/v1/is-active?product_id=10663';
const MP_CHECK_SECRET     = (process.env.MP_CHECK_SECRET || '').trim();
const MP_CHECK_TIMEOUT_MS = parseInt(process.env.MP_CHECK_TIMEOUT_MS || '10000', 10);

const fetch = (global.fetch ? global.fetch : require('node-fetch'));
const crypto = require('crypto');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ===================== Firebase ===================== */
const admin = require('../firebase');
const db = admin.firestore();

/* ===================== Alertas ===================== */
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
    const res = await fetch(SMTP2GO_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
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

/* ===================== Stripe utils ===================== */
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
    try {
      const cust = await stripe.customers.retrieve(sub.customer);
      if (cust?.email) return cust.email;
    } catch (e) { verror('email.resolve.customer', e, { customer: sub.customer, subId: sub?.id }); }
  }
  if (!email && evForFallback?.data?.object?.customer && typeof evForFallback.data.object.customer === 'string') {
    try {
      const cust2 = await stripe.customers.retrieve(evForFallback.data.object.customer);
      if (cust2?.email) return cust2.email;
    } catch (e) { verror('email.resolve.event_customer', e, { customer: evForFallback.data.object.customer, subId: sub?.id }); }
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

/* ===================== Firestore helpers ===================== */
async function isUsuarioClubActivo(email) {
  try {
    if (!email) return null;
    const ref = db.collection(USERS_COLL).doc(String(email).toLowerCase());
    const snap = await ref.get();
    if (!snap.exists) {
      vlog('usuariosClub.check', 'not_found', { email });
      return null;
    }
    const d = snap.data() || {};
    const activo = !!d.activo;
    vlog('usuariosClub.check', 'ok', { email, activo, raw: d });
    return activo;
  } catch (e) {
    verror('usuariosClub.check.fail', e, { email });
    return null;
  }
}
async function getBajaEstado(email) {
  try {
    if (!email) return null;
    const ref = db.collection(BAJAS_COLL).doc(String(email).toLowerCase());
    const snap = await ref.get();
    if (!snap.exists) { vlog('bajasClub.read', 'not_found', { email }); return null; }
    const d = snap.data() || {};
    let fechaMs = d.fechaEfectosMs;
    if (!fechaMs && d.fechaEfectos) { try { fechaMs = new Date(d.fechaEfectos).getTime(); } catch { fechaMs = 0; } }
    const out = {
      estadoBaja: d.estadoBaja || null,                          // programada | pendiente | ejecutada | ...
      fechaEfectosMs: fechaMs || 0,
      motivo: d.motivo || d.motivoFinal || null,
    };
    vlog('bajasClub.read', 'ok', { email, out });
    return out;
  } catch (e) { verror('bajasClub.read.fail', e, { email }); return null; }
}

/* ===================== MemberPress checker HMAC ===================== */
function hmacSha256Hex(secret, msg){ return crypto.createHmac('sha256', secret).update(msg).digest('hex'); }
function randNonce(){ return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function buildSignedUrl(email){
  const baseUrl = MP_CHECK_URL.includes('?') ? MP_CHECK_URL : (MP_CHECK_URL + '?product_id=10663');
  const u = new URL(baseUrl); u.searchParams.set('email', email); return u.toString();
}
function buildHeaders(email){
  if (!MP_CHECK_SECRET) return { 'user-agent': 'Laboroteca-PlanB/1.0', 'accept': 'application/json' };
  const ts = Math.floor(Date.now()/1000).toString();
  const nonce = randNonce();
  const url = new URL(MP_CHECK_URL);
  const pid = url.searchParams.get('product_id') || '10663';
  const canonical = `${email}|${pid}|${ts}|${nonce}`;
  const sig = hmacSha256Hex(MP_CHECK_SECRET, canonical);
  return { 'x-mp-ts': ts, 'x-mp-nonce': nonce, 'x-mp-sig': sig, 'user-agent': 'Laboroteca-PlanB/1.0', 'accept': 'application/json' };
}
async function isMpActive(email) {
  if (!MP_CHECK_URL) { vlog('mp.check', 'skip: sin MP_CHECK_URL'); return { ok:false, active:null, reason:'no_url' }; }
  try {
    const url = buildSignedUrl(email);
    const headers = buildHeaders(email);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), MP_CHECK_TIMEOUT_MS);
    const start = Date.now();
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(t);
    const dt = Date.now()-start;
    const bodyText = await res.text();
    let data = {};
    try { data = JSON.parse(bodyText); } catch {}
    const active = (typeof data.active === 'boolean') ? data.active : (String(data.status || '').toLowerCase() === 'active');
    vlog('mp.check', res.ok ? 'ok' : 'non-200', { email, status: res.status, ms: dt, preview: bodyText.slice(0,300), parsedActive: active });
    return { ok: res.ok, active: res.ok ? !!active : null, reason: res.ok ? 'ok' : `http_${res.status}`, raw: bodyText.slice(0,600) };
  } catch (e) {
    verror('mp.check.fail', e, { email });
    return { ok:false, active:null, reason: e.name === 'AbortError' ? 'timeout' : 'exception' };
  }
}

/* ======= Email de discordancia (NO desactiva) ======= */
async function alertDiscordancia(source, ctx) {
  const { email, subStatus, subId, ucActivo, baja, mp } = ctx;
  const key = `discord:${source}:${subId || email || 'noEmail'}`;
  return ensureOnce('alertPlanB', key, ALERT_TTL, async () => {
    const bajaInfo = baja ? `${baja.estadoBaja || 'N/D'} @ ${baja.fechaEfectosMs || 'N/D'} (motivo: ${baja.motivo || 'N/D'})` : 'sin registro';
    const mpLine = mp ? `MP: ${mp.active === true ? 'ACTIVO' : (mp.active === false ? 'inactivo' : 'no verificable')} (ok:${mp.ok} reason:${mp.reason})` : 'MP: N/D';
    const subject = 'AVISO: Discordancia STRIPE ↔ Firestore (usuariosClub activo)';
    const text =
`Se detectó DISCORDANCIA:

Stripe: ${subStatus || 'N/D'} (subId: ${subId || 'N/D'})
usuariosClub.activo: ${ucActivo}
bajasClub: ${bajaInfo}
${mpLine}

Email: ${email || 'N/D'}
Origen: ${source}

Regla: Stripe no-activa && usuariosClub.activo === true && (sin baja programada/pending futura)
Acción: Solo AVISO. No se desactiva nada.`;
    vlog('planB.discord', 'alerting', { source, email, subId, subStatus, ucActivo, baja: baja || null, mp: mp || null });
    await sendAdmin(subject, text, { email, subId, subStatus, ucActivo, baja, mp, source });
  });
}

/* ===================== Decisor de alerta ===================== */
function stripeIsNonActiveStatus(status, cancel_at_period_end, current_period_end) {
  const s = String(status || '').toLowerCase();
  if (['canceled','unpaid','incomplete_expired'].includes(s)) return true;
  if (s === 'past_due' && cancel_at_period_end && (current_period_end*1000) <= Date.now()) return true;
  if (cancel_at_period_end && (current_period_end*1000) <= Date.now()) return true;
  return false;
}

async function decideAndMaybeAlert(source, sub) {
  const subId = sub?.id;
  const status = sub?.status;
  const email = await resolveEmail(sub, null);
  vlog('decision.input', 'stripe', { subId, status, email, cancel_at_period_end: sub?.cancel_at_period_end, current_period_end: sub?.current_period_end });

  if (!stripeIsNonActiveStatus(status, sub?.cancel_at_period_end, sub?.current_period_end)) {
    vlog('decision', 'skip: stripe still active', { subId, status });
    return;
  }
  if (!email) {
    await notifyOnce('planB.no_email_for_sub', new Error('Stripe sin email'), { subId, status });
    return;
  }

  // Firestore usuariosClub
  const ucActivo = await isUsuarioClubActivo(email);             // true | false | null
  // Firestore bajasClub
  const baja = await getBajaEstado(email);                       // puede ser null
  let bajaBlocks = false;
  if (baja) {
    const est = String(baja.estadoBaja || '').toLowerCase();
    const now = Date.now();
    if ((est === 'programada' || est === 'pendiente') && (baja.fechaEfectosMs || 0) > now) bajaBlocks = true;
  }

  // MemberPress (solo para informar; no bloquea el aviso)
  const mp = await isMpActive(email); // {ok, active, reason}

  // Logs de resumen de los tres sistemas
  vlog('decision.summary', 'results', {
    email, subId, stripeStatus: status,
    usuariosClub_activo: ucActivo,
    bajasClub: baja || null,
    bajaBlocks,
    mp: mp || null
  });

  // Regla: avisar si Stripe no-activa && usuariosClub.activo === true && NO baja programada futura
  if (ucActivo === true && !bajaBlocks) {
    await alertDiscordancia(source, { email, subId, subStatus: status, ucActivo, baja, mp });
  } else {
    vlog('decision', 'no-alert', { reason:
      ucActivo !== true ? 'uc_inactivo_o_desconocido' :
      (bajaBlocks ? 'baja_programada_futura' : 'otro')
    });
  }
}

/* ===================== 1) Replayer ===================== */
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

          let sub = null;
          try {
            sub = await stripe.subscriptions.retrieve(subId, { expand: ['customer','latest_invoice.customer'] });
            vlog('replayer.stripe', 'ok', { subId, status: sub.status });
          } catch (e) { verror('replayer.stripe.fail', e, { subId }); return; }

          await decideAndMaybeAlert('replayer', sub);
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
async function jobReconciler() {
  try {
    vlog('reconciler', 'start', { query: RECON_QUERY });

    let reviewed = 0, acted = 0;
    let page = null;

    do {
      let res;
      try {
        res = await stripe.subscriptions.search({ query: RECON_QUERY, limit: 100, page: page || undefined, expand: ['data.customer'] });
        vlog('reconciler.stripe', 'search.ok', { count: res.data?.length || 0, page: !!page });
      } catch (e) { verror('reconciler.stripe.search.fail', e, { page }); break; }

      for (const sub of res.data) {
        reviewed++;
        if (acted >= MAX_ACTIONS_PER_RUN) { page = null; break; }

        const email = extractEmailFromSub(sub);
        vlog('reconciler.item', 'stripe', { subId: sub.id, status: sub.status, email });

        if (!needsDeactivation(sub)) { vlog('reconciler', 'no-op active', { subId: sub.id }); continue; }

        try {
          // asegurar email completo si no venía expandido
          if (!email) {
            const subFull = await stripe.subscriptions.retrieve(sub.id, { expand: ['customer','latest_invoice.customer'] });
            sub.customer = subFull.customer; sub.latest_invoice = subFull.latest_invoice;
          }
        } catch (e) { verror('reconciler.stripe.retrieve.fail', e, { subId: sub.id }); }

        await decideAndMaybeAlert('reconciler', sub);
        if ((reviewed % SLOWDOWN_EVERY) === 0) await sleep(SLOWDOWN_MS);
      }

      page = res.next_page;
    } while (page);

    vlog('reconciler', 'end', { reviewed, acted });
  } catch (e) {
    verror('reconciler.fatal', e); await notifyOnce('planB.reconciler.fatal', e); throw e;
  }
}

/* ===================== Agregador / Daemon / CLI ===================== */
async function runAllPlanB() {
  const out = { ok: true, steps: {} };
  try { out.steps.reconciler = await jobReconciler(); } catch (e) { verror('planB.full.reconciler', e); out.reconcilerError = e?.message || String(e); out.ok = false; }
  try { out.steps.replayer   = await jobReplayer();   } catch (e) { verror('planB.full.replayer', e);   out.replayerError   = e?.message || String(e); out.ok = false; }
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

  makePoller('replayer',   REPLAYER_MS, jobReplayer);
  makePoller('reconciler', RECONC_MS,   jobReconciler);

  vlog('planB.daemon', 'iniciado', { REPLAYER_MS, RECONC_MS });
}

/* ===================== Main ===================== */
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

async function main() {
  const cmd = (process.argv[2] || '').toLowerCase();
  try {
    if (cmd === 'replayer')        await jobReplayer();
    else if (cmd === 'reconciler') await jobReconciler();
    else if (cmd === 'full')       { const r = await runAllPlanB(); console.log(JSON.stringify({ area: 'planB.full', ...r })); }
    else if (cmd === 'testalert')  await sendAdmin('[PlanB][TEST]', 'Prueba de alertas OK', { service: 'PlanB aviso-only' });
    else if (cmd === 'daemon')     startDaemon();
    else {
      console.log(`Usage:
  node jobs/stripe_bajasClub_planB.js replayer
  node jobs/stripe_bajasClub_planB.js reconciler
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

module.exports = { jobReplayer, jobReconciler, runAllPlanB, startDaemon };
