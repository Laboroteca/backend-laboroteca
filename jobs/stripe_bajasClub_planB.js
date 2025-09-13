// jobs/stripe_bajasClub_planB.js
// Reporte ULTRA SIMPLE: envía un email con 3 listados de BAJAS del último N días.
// - Stripe: eventos de cancelación (customer.subscription.deleted / updated→canceled)
// - Firestore: documentos en bajasClub con fechaEfectosMs en el rango
// - MemberPress: vía MP_SYNC_API_URL_CLUB si existe; si no, fallback a checker HMAC (estado actual)
//
// Ejecuta:  node jobs/stripe_bajasClub_planB.js report --days=31
// Programable 1/semana por cron. No desactiva nada. No hace reconciliación.
//
// Requiere ENV (las que ya tienes):
// STRIPE_SECRET_KEY, ADMIN_EMAIL, SMTP2GO_* (o proxy), USERS_COLL, BAJAS_COLL,
// MP_CHECK_URL, MP_CHECK_SECRET (para fallback), MP_CHECK_TIMEOUT_MS,
// MP_SYNC_API_URL_CLUB (opcional), MP_SYNC_API_KEY (opcional), MP_SYNC_HMAC_SECRET (opcional)

'use strict';

/* =================== Banner / versión =================== */
const PLANB_VERSION = 'report-only 2025-09-09 ultra-simple';
function banner(msg = '') {
  console.log(JSON.stringify({ at: new Date().toISOString(), area: 'boot', msg: `PlanB ${PLANB_VERSION} ${msg}` }));
}
banner();

/* =================== Dependencias / ENV =================== */
const fetch = (global.fetch ? global.fetch : require('node-fetch'));
const crypto = require('crypto');
const Stripe = require('stripe');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
if (!STRIPE_SECRET_KEY) {
  console.error(JSON.stringify({ at: new Date().toISOString(), area: 'boot', msg: '❌ Falta STRIPE_SECRET_KEY' }));
  process.exit(1);
}
const stripe = new Stripe(STRIPE_SECRET_KEY, { maxNetworkRetries: 2 });

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'laboroteca@gmail.com';
const USERS_COLL  = process.env.USERS_COLL  || 'usuariosClub';
const BAJAS_COLL  = process.env.BAJAS_COLL  || 'bajasClub';

const SMTP2GO_API_URL  = process.env.SMTP2GO_API_URL  || 'https://api.smtp2go.com/v3/email/send';
const SMTP2GO_API_KEY  = process.env.SMTP2GO_API_KEY  || '';
const SMTP2GO_FROM     = process.env.SMTP2GO_FROM_EMAIL || 'laboroteca@laboroteca.es';
const SMTP2GO_FROMNAME = process.env.SMTP2GO_FROM_NAME  || 'Plan B Report';

const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy'); // ya existente en el repo

// MP checker HMAC (fallback)
const MP_CHECK_URL        = process.env.MP_CHECK_URL || '';
const MP_CHECK_SECRET     = (process.env.MP_CHECK_SECRET || '').trim();
const MP_CHECK_TIMEOUT_MS = parseInt(process.env.MP_CHECK_TIMEOUT_MS || '10000', 10);

// MP sync API (si existe, mejor) — contrato flexible: GET ?since=ISO ó ?since_ms=epoch
const MP_SYNC_API_URL_CLUB = (process.env.MP_SYNC_API_URL_CLUB || '').trim(); // p.ej. https://.../mp-sync/club-cancellations
const MP_SYNC_API_KEY      = (process.env.MP_SYNC_API_KEY || '').trim();
const MP_SYNC_HMAC_SECRET  = (process.env.MP_SYNC_HMAC_SECRET || '').trim();

// Firebase Admin ya lo tienes centralizado en ../firebase
const admin = require('../firebase');
const db = admin.firestore();

/* =================== Utilidades =================== */
const SENSITIVE_KEYS =
  /(^|_)(private|secret|token|key|password|sig|hmac|authorization|stripe_signature|api|bearer)$/i;

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
    return s.length > 400 ? s.slice(0, 400) + '…[truncated]' : s;
  }
  return input;
}
function safeStringify(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}
function vlog(area, msg, meta = {}) {
  try { console.log(safeStringify({ at: new Date().toISOString(), area, msg, meta: redactObject(meta) })); }
  catch { console.log(`[${area}] ${msg}`); }
}
function verror(area, err, meta = {}) {
  const msg = err?.message || String(err);
  const stack = (err?.stack || '').split('\n').slice(0, 4).join(' | ').slice(0, 600);
  vlog(area, `❌ ${msg}`, { ...meta, stack });
}

function fmtDate(ms) { try { return new Date(ms).toISOString().slice(0, 19).replace('T', ' '); } catch { return String(ms); } }
function uniq(arr) { return Array.from(new Set(arr)); }

/* =================== Email helpers =================== */
async function sendViaProxy(subject, text, meta = {}) {
  try {
    await alertAdmin({ area: meta.area || 'planB-report', email: ADMIN_EMAIL, err: new Error(text || subject || 'report'), meta });
    vlog('alerts.proxy', 'sent', { subject, to: ADMIN_EMAIL });
  } catch (e) { verror('alerts.proxy.fail', e, { subject }); throw e; }
}
async function sendViaSMTP2GO(subject, text) {
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
  vlog('alerts.smtp2go', res.ok ? 'ok' : 'non-200', { status: res.status, preview: body.slice(0, 200) });
  if (!res.ok) throw new Error(`SMTP2GO status ${res.status}`);
}
async function sendAdmin(subject, text, meta = {}) {
  let proxyErr = null, smtpErr = null;
  try { await sendViaProxy(subject, text, meta); } catch (e) { proxyErr = e; }
  try { await sendViaSMTP2GO(subject, text); } catch (e) { smtpErr = e; }
  if (proxyErr && smtpErr) throw new Error('Ambos envíos fallaron');
}

/* =================== Stripe: bajas último periodo =================== */
// Email helpers desde Subscription
function extractEmailFromSub(sub) {
  if (sub?.customer && typeof sub.customer === 'object' && sub.customer.email) return sub.customer.email;
  if (sub?.metadata?.email) return sub.metadata.email;
  if (sub?.latest_invoice?.customer_email) return sub.latest_invoice.customer_email;
  if (sub?.latest_invoice?.customer && sub.latest_invoice.customer.email) return sub.latest_invoice.customer.email;
  return null;
}
async function resolveEmailFromSub(sub) {
  let email = extractEmailFromSub(sub);
  if (email) return email;

  if (typeof sub?.customer === 'string' && sub.customer) {
    try { const c = await stripe.customers.retrieve(sub.customer); if (c?.email) return c.email; } catch {}
  }
  if (typeof sub?.latest_invoice === 'string' && sub.latest_invoice) {
    try {
      const inv = await stripe.invoices.retrieve(sub.latest_invoice, { expand: ['customer'] });
      if (inv?.customer_email) return inv.customer_email;
      if (inv?.customer && typeof inv.customer === 'object' && inv.customer.email) return inv.customer.email;
    } catch {}
  }
  if (typeof sub?.default_payment_method === 'string' && sub.default_payment_method) {
    try { const pm = await stripe.paymentMethods.retrieve(sub.default_payment_method); if (pm?.billing_details?.email) return pm.billing_details.email; } catch {}
  }
  return null;
}

/** Devuelve [{email, subId, whenMs, note}] */
async function listStripeBajasSince(sinceSec) {
  const out = [];
  let hasMore = true, starting_after;

  // Tipos que reflejan baja reciente
  const TYPES = ['customer.subscription.deleted','customer.subscription.updated'];

  while (hasMore) {
    const page = await stripe.events.list({
      types: TYPES,
      created: { gte: sinceSec },
      limit: 100,
      starting_after
    });

    for (const ev of page.data) {
      const obj = ev.data?.object;
      if (!obj || obj.object !== 'subscription') continue;

      let isRealCancel = false;
      let note = ev.type;

      if (ev.type === 'customer.subscription.deleted') {
        isRealCancel = true;
      } else if (ev.type === 'customer.subscription.updated') {
        // si el update cambió a canceled
        const prev = ev.data?.previous_attributes || {};
        if ((prev.status && String(obj.status).toLowerCase() === 'canceled') || String(obj.status).toLowerCase() === 'canceled') {
          isRealCancel = true;
          note = 'updated→canceled';
        }
      }

      if (!isRealCancel) continue;

      let email = await resolveEmailFromSub(obj);
      const subId = obj.id;
      const whenMs = (ev.created || 0) * 1000;

      out.push({ email, subId, whenMs, note });
    }

    hasMore = page.has_more;
    starting_after = page.data.length ? page.data[page.data.length - 1].id : undefined;
  }

  // Dedupe por (email,subId,whenMs)
  const seen = new Set();
  return out.filter(x => {
    const k = `${x.email}|${x.subId}|${x.whenMs}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
}

/* =================== Firestore: bajasClub último periodo =================== */
/** Devuelve [{email, whenMs, estado}] a partir de fechaEfectosMs (o fallback) */
async function listFirestoreBajasSince(sinceMs) {
  const coll = db.collection(BAJAS_COLL);
  const out = [];

  async function tryQuery(field) {
    try {
      const snap = await coll.where(field, '>=', sinceMs).get();
      snap.forEach(doc => {
        const d = doc.data() || {};
        const whenMs = d[field] || 0;
        out.push({ email: doc.id, whenMs, estado: d.estadoBaja || null });
      });
      return true;
    } catch (e) {
      vlog('firestore.bajas.query.fail', 'non-index or field missing', { field, err: e.message });
      return false;
    }
  }

  // preferimos fechaEfectosMs; si no, probamos otros; al final, fallback brutito
  let ok = await tryQuery('fechaEfectosMs');
  if (!ok) ok = await tryQuery('fechaBajaMs');
  if (!ok) ok = await tryQuery('createdAt');

  if (!ok) {
    // Fallback: leer todo y filtrar (para colecciones pequeñas)
    vlog('firestore.bajas', 'fallback full scan');
    const all = await coll.get();
    all.forEach(doc => {
      const d = doc.data() || {};
      const whenMs = d.fechaEfectosMs || d.fechaBajaMs || d.createdAt || 0;
      if (whenMs >= sinceMs) out.push({ email: doc.id, whenMs, estado: d.estadoBaja || null });
    });
  }

  // Dedupe por email+when
  const seen = new Set();
  return out.filter(x => {
    const k = `${x.email}|${x.whenMs}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
}

/* =================== MemberPress: bajas último periodo =================== */
/** Intento 1: MP_SYNC_API_URL_CLUB (si existe) -> devuelve [{email, whenMs}] */
async function listMemberPressBajasSince_viaSync(sinceMs) {
  if (!MP_SYNC_API_URL_CLUB) return { ok: false, reason: 'no_sync_url', items: [] };

  const url1 = new URL(MP_SYNC_API_URL_CLUB);
  url1.searchParams.set('since', new Date(sinceMs).toISOString());

  // También probamos ?since_ms= por si tu endpoint lo usa
  const url2 = new URL(MP_SYNC_API_URL_CLUB);
  url2.searchParams.set('since_ms', String(sinceMs));

  const headers = { 'accept': 'application/json', 'user-agent': 'Laboroteca-PlanB/1.0' };
  if (MP_SYNC_API_KEY) headers['x-api-key'] = MP_SYNC_API_KEY;
  if (MP_SYNC_HMAC_SECRET) {
    const base = `${sinceMs}|${Math.floor(Date.now()/1000)}`;
    const sig = crypto.createHmac('sha256', MP_SYNC_HMAC_SECRET).update(base).digest('hex');
    headers['x-sig'] = sig;
    headers['x-sig-base'] = base; // opcional para debug del server
  }

  async function hit(u) {
    try {
      const r = await fetch(u.toString(), { headers, method: 'GET' });
      const text = await r.text();
      if (!r.ok) return { ok: false, reason: `http_${r.status}`, raw: text };
      let data = [];
      try { data = JSON.parse(text); } catch { return { ok: false, reason: 'bad_json', raw: text }; }
      // aceptar formatos [{email, whenMs}] o [{email, when_iso}]
      const items = [];
      for (const it of (Array.isArray(data)?data:[])) {
        const email = it.email || it.user_email || null;
        const whenMs = ('whenMs' in it) ? Number(it.whenMs) :
                       (it.when_iso ? Date.parse(it.when_iso) : 0);
        if (email && whenMs) items.push({ email, whenMs });
      }
      return { ok: true, items };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  const a = await hit(url1);
  if (a.ok) return a;
  const b = await hit(url2);
  if (b.ok) return b;

  vlog('mp.sync.fail', 'both attempts failed', { a: a.reason, b: b.reason });
  return { ok: false, reason: 'both_failed', items: [] };
}

/** Fallback: para una lista de emails, consulta checker HMAC actual y marca inactivo (fecha N/A) */
function hmacSha256Hex(secret, msg){ return crypto.createHmac('sha256', secret).update(msg).digest('hex'); }
function randNonce(){ return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function buildSignedUrl(email){
  if (!MP_CHECK_URL) return '';
  const u = new URL(MP_CHECK_URL.includes('?') ? MP_CHECK_URL : (MP_CHECK_URL + '?product_id=10663'));
  u.searchParams.set('email', email);
  return u.toString();
}
function buildHeaders(email){
  if (!MP_CHECK_SECRET) return { 'user-agent': 'Laboroteca-PlanB/1.0', 'accept': 'application/json' };
  const ts = Math.floor(Date.now()/1000).toString();
  const nonce = randNonce();
  // Para HMAC, el plugin calcula HMAC(email|product_id|ts|nonce) — producto lo extrae del query
  const url = new URL(MP_CHECK_URL.includes('?') ? MP_CHECK_URL : (MP_CHECK_URL + '?product_id=10663'));
  const pid = url.searchParams.get('product_id') || '10663';
  const canonical = `${email}|${pid}|${ts}|${nonce}`;
  const sig = hmacSha256Hex(MP_CHECK_SECRET, canonical);
  return { 'x-mp-ts': ts, 'x-mp-nonce': nonce, 'x-mp-sig': sig, 'user-agent': 'Laboroteca-PlanB/1.0', 'accept': 'application/json' };
}

async function mpCheckActive(email) {
  if (!MP_CHECK_URL) return { ok:false, active:null, reason:'no_checker_url' };
  try {
    const url = buildSignedUrl(email);
    const headers = buildHeaders(email);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), MP_CHECK_TIMEOUT_MS);
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(t);
    const txt = await res.text();
    if (!res.ok) return { ok:false, active:null, reason:`http_${res.status}`, raw:txt.slice(0,200) };
    let data = {};
    try { data = JSON.parse(txt); } catch { return { ok:false, active:null, reason:'bad_json' }; }
    const active = (typeof data.active === 'boolean') ? data.active : (String(data.status||'').toLowerCase()==='active');
    return { ok:true, active: !!active };
  } catch (e) {
    return { ok:false, active:null, reason: e.name==='AbortError' ? 'timeout' : e.message };
  }
}

/* =================== Reporte: armado y envío =================== */
function buildSection(title, rows, mapper) {
  const lines = [ `\n=== ${title} (${rows.length}) ===` ];
  for (const r of rows) lines.push(mapper(r));
  return lines.join('\n');
}

async function buildAndSendReport(daysBack) {
  const nowMs = Date.now();
  const sinceMs = nowMs - daysBack * 24*60*60*1000;
  const sinceSec = Math.floor(sinceMs/1000);

  vlog('report', 'start', { daysBack, since: fmtDate(sinceMs) });

  // 1) STRIPE
  let stripeBajas = [];
  try { stripeBajas = await listStripeBajasSince(sinceSec); }
  catch (e) { verror('stripe.list.fail', e); }

  // 2) FIRESTORE
  let fsBajas = [];
  try { fsBajas = await listFirestoreBajasSince(sinceMs); }
  catch (e) { verror('fs.list.fail', e); }

  // 3) MEMBERPRESS
  let mpRes = await listMemberPressBajasSince_viaSync(sinceMs);
  let mpBajas = mpRes.ok ? mpRes.items : [];
  let mpNote = mpRes.ok ? 'via sync API' : `fallback (sync: ${mpRes.reason || 'N/A'})`;

  // Fallback si no hay sync: mirar estado actual de emails que ya vimos
  if (!mpRes.ok) {
    const candidates = uniq([ ...stripeBajas.map(x=>x.email).filter(Boolean),
                              ...fsBajas.map(x=>x.email).filter(Boolean) ]);
    const tmp = [];
    for (const email of candidates) {
      const r = await mpCheckActive(email);
      if (r.ok && r.active === false) {
        tmp.push({ email, whenMs: 0 }); // fecha N/A
      }
    }
    mpBajas = tmp;
  }

  // ===== Construir email =====
  const secStripe = buildSection(
    `Stripe — bajas en ${daysBack} días`,
    stripeBajas.sort((a,b)=>a.whenMs-b.whenMs),
    r => `- ${fmtDate(r.whenMs)} | ${r.email || '—'} | sub:${r.subId} | ${r.note}`
  );

  const secFS = buildSection(
    `Firestore (${BAJAS_COLL}) — bajas en ${daysBack} días`,
    fsBajas.sort((a,b)=>a.whenMs-b.whenMs),
    r => `- ${fmtDate(r.whenMs)} | ${r.email || '—'} | estado:${r.estado || '—'}`
  );

  const secMP = buildSection(
    `MemberPress — bajas en ${daysBack} días (${mpNote})`,
    mpBajas.sort((a,b)=>a.whenMs-b.whenMs),
    r => `- ${r.whenMs ? fmtDate(r.whenMs) : 'fecha N/A'} | ${r.email || '—'}`
  );

  const subject = `[PlanB][Reporte bajas][${daysBack}d]`;
  const header =
`Reporte de bajas (últimos ${daysBack} días)
Rango: desde ${fmtDate(sinceMs)} hasta ${fmtDate(nowMs)}
Env: ${process.env.RAILWAY_SERVICE_NAME || 'railway'} • Version: ${PLANB_VERSION}

Conteos:
- Stripe:     ${stripeBajas.length}
- Firestore:  ${fsBajas.length}
- MemberPress:${mpBajas.length} (${mpNote})
`;

  const text = [header, secStripe, secFS, secMP, '\n--\nFin del reporte.\n'].join('\n');

  await sendAdmin(subject, text, {
    area: 'planB-report',
    counts: { stripe: stripeBajas.length, firestore: fsBajas.length, memberpress: mpBajas.length },
    daysBack
  });

  vlog('report', 'sent', { subject });
}

/* =================== CLI =================== */
function parseDays(argv) {
  const d = (argv.find(a => a.startsWith('--days=')) || '').split('=')[1];
  const n = parseInt(d || '31', 10);
  return Number.isFinite(n) && n > 0 ? n : 31;
}

async function main() {
  const cmd = (process.argv[2] || 'report').toLowerCase();
  if (cmd !== 'report' && cmd !== 'testalert') {
    console.log(`Usage:
  node jobs/stripe_bajasClub_planB.js report [--days=31]
  node jobs/stripe_bajasClub_planB.js testalert
`); process.exit(2); return;
  }

  try {
    if (cmd === 'testalert') {
      await sendAdmin('[PlanB][TEST] Reporte', 'Prueba de envío OK', { area: 'planB-report' });
      return;
    }
    const days = parseDays(process.argv.slice(3));
    await buildAndSendReport(days);
  } catch (e) {
    verror('main.fail', e, { cmd });
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { buildAndSendReport };
