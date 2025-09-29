// routes/marketing-cron.js
// ──────────────────────────────────────────────────────────────
// Dispara envíos programados (emailQueue) cuando llega su hora.
// Soporta filtro: onlyCommercial → solo contactos con consent_comercial=true
// POST /marketing/cron-send
//
// Endurecido para producción:
//  • Autenticación doble: x-cron-key + (opcional) HMAC v2 exclusivo de CRON
//    (variable singular: MKT_CRON_HMAC_SECRET).
//  • Lease robusto con rescate: reclama también jobs “processing” cuyo
//    leaseUntil haya expirado (zombis).
//  • Reintentos con backoff exponencial + jitter.
//  • Envío por CHUNKS con checkpoint (lastIndex, contadores por estado)
//    para evitar duplicados si hay fallos parciales.
//  • Deduplicación por destinatario: emailSendDedup: `${jobId}:${sha256(email)}`.
//  • Concurrencia controlada (POOL) + rate opcional entre envíos.
//  • Cache de suppressionList (memoria, TTL configurable).
//  • Inserta pie legal + enlace de baja personalizado y cabeceras
//    List-Unsubscribe en todos los envíos.
// ──────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const admin   = require('firebase-admin');
const crypto  = require('crypto');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

// fetch: nativo (Node 18+) o node-fetch dinámico
const fetch = (global.fetch)
  ? global.fetch
  : (...args) => import('node-fetch').then(m => m.default(...args));

if (!admin.apps.length) { try { admin.initializeApp(); } catch (_) {} }
const db = admin.firestore();

const router = express.Router();

// ───────── CONFIG ─────────
const CRON_KEY               = String(process.env.MKT_CRON_KEY || '').trim(); // cabecera x-cron-key
const CRON_HMAC_SECRET       = String(process.env.MKT_CRON_HMAC_SECRET || '').trim(); // HMAC exclusivo cron
const HMAC_SKEW_SECS         = Number(process.env.CRON_HMAC_SKEW_SECS || 300); // ±5 min
const IP_ALLOWLIST           = String(process.env.CRON_IP_ALLOW || '').trim(); // "1.2.3.4,5.6.7.8"

const SMTP2GO_API_KEY        = String(process.env.SMTP2GO_API_KEY || '').trim();
const SMTP2GO_API_URL        = String(process.env.SMTP2GO_API_URL || 'https://api.smtp2go.com/v3/email/send');
const FROM_EMAIL             = String(process.env.EMAIL_FROM || process.env.SMTP2GO_FROM_EMAIL || 'newsletter@laboroteca.es').trim();
const FROM_NAME              = String(process.env.EMAIL_FROM_NAME || process.env.SMTP2GO_FROM_NAME || 'Laboroteca Newsletter').trim();

const UNSUB_SECRET           = String(process.env.MKT_UNSUB_SECRET || 'laboroteca-unsub').trim();
const UNSUB_PAGE             = String(process.env.MKT_UNSUB_PAGE   || 'https://www.laboroteca.es/baja-newsletter').trim();
// Testing list (modo testOnly)
const TEST_TO                = String(process.env.MKT_TEST_TO || 'ignacio.solsona@icacs.com,laboroteca@gmail.com').split(',').map(s=>s.trim()).filter(Boolean);
const MAX_JOBS_PER_RUN       = Number(process.env.CRON_MAX_JOBS || 6);
const MAX_ATTEMPTS           = Number(process.env.CRON_MAX_ATTEMPTS || 5);
const LEASE_MINUTES          = Number(process.env.CRON_LEASE_MIN || 5);
const RATE_DELAY_MS          = Number(process.env.CRON_RATE_DELAY_MS || 0); // pause entre envíos individuales
const CONCURRENCY            = Math.max(1, Number(process.env.CRON_CONCURRENCY || 5)); // hilos de envío
const CHUNK_SIZE             = Math.max(10, Number(process.env.CRON_CHUNK_SIZE || 200)); // destinatarios por lote
// Límite duro de HTML que se envía por email (protección)
const MAX_HTML_BYTES         = Number(process.env.MKT_SEND_MAX_HTML_BYTES || 250 * 1024);
const SUPPRESSION_TTL_MS     = Number(process.env.CRON_SUPPRESSION_TTL_MS || (10*60*1000)); // 10 min
const LAB_DEBUG              = String(process.env.LAB_DEBUG || '') === '1';

const LOG_PREFIX = '[marketing/cron-send]';
const now       = () => new Date();
const nowISO    = () => new Date().toISOString();

// ───────── Helpers ─────────
const s = (v, def='') => (v===undefined||v===null) ? def : String(v);
const sha256 = (str) => crypto.createHash('sha256').update(String(str||''), 'utf8').digest('hex');
const sleep  = (ms)  => ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();

// Enmascara emails en logs (RGPD)
function maskEmail(e='') {
  const str = String(e || '');
  const at = str.indexOf('@');
  if (at <= 0) return '***';
  const user = str.slice(0, at);
  const dom  = str.slice(at + 1);
  const uMask = user.length <= 2 ? (user[0] || '*') : (user.slice(0,2) + '***' + user.slice(-1));
  const dMask = dom.length <= 3 ? '***' : ('***' + dom.slice(-3));
  return `${uMask}@${dMask}`;
}

function clientIp(req){
  return (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
}

function requireCronKey(req, res) {
  const key = String(req.headers['x-cron-key'] || '');
  if (!CRON_KEY || key !== CRON_KEY) {
    res.status(401).json({ ok:false, error:'UNAUTHORIZED_CRON_KEY' });
    return false;
  }
  return true;
}

function requireCronHmac(req, res) {
  if (!CRON_HMAC_SECRET) return true; // opcional
  const tsRaw = s(req.headers['x-cron-ts']);
  const sig   = s(req.headers['x-cron-sig']);
  if (!tsRaw || !sig) {
    res.status(401).json({ ok:false, error:'MISSING_HMAC_HEADERS' });
    return false;
  }
  const tsNum = Number(tsRaw);
  if (!Number.isFinite(tsNum)) {
    res.status(401).json({ ok:false, error:'BAD_HMAC_TS' });
    return false;
  }
  const tsMs = tsNum > 1e11 ? tsNum : tsNum * 1000;
  if (Math.abs(Date.now() - tsMs) > Math.max(0,HMAC_SKEW_SECS)*1000) {
    res.status(401).json({ ok:false, error:'HMAC_SKEW' });
    return false;
  }

  // base v2: `${ts}.${METHOD}.${PATH}.${sha256(body)}`
  const method = (req.method || 'POST').toUpperCase();
  const path   = String((req.originalUrl || req.url || '/').split('?')[0]).replace(/\/{2,}/g,'/').replace(/(.)\/$/,(m,p)=>p);
  const raw    = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body||{}),'utf8');
  const bodyHash = sha256(raw.toString('utf8'));

  const tsS   = String(Math.floor(tsMs/1000));
  const tsMS  = String(Math.floor(tsMs));

  const bases = [
    `${tsS}.${method}.${path}.${bodyHash}`,
    `${tsMS}.${method}.${path}.${bodyHash}`,
  ];

  const isHex = /^[0-9a-f]{64}$/i.test(sig);
  const toBuf = (v)=> isHex ? Buffer.from(v,'hex') : b64urlToBuf(v);

  try {
    const sigBuf = toBuf(sig);
    for (const base of bases) {
      const exp = crypto.createHmac('sha256', CRON_HMAC_SECRET).update(base).digest();
      if (exp.length === sigBuf.length && crypto.timingSafeEqual(exp, sigBuf)) return true;
    }
  } catch (_) {}

  res.status(401).json({ ok:false, error:'BAD_HMAC' });
  return false;
}

function b64urlToBuf(str) {
  const ss = String(str).replace(/-/g,'+').replace(/_/g,'/');
  const pad = ss.length % 4 ? '='.repeat(4 - (ss.length % 4)) : '';
  return Buffer.from(ss + pad, 'base64');
}

function makeUnsubToken(email) {
  const ts = Math.floor(Date.now()/1000);
  const base = `${String(email||'').toLowerCase()}.${ts}`;
  const sig  = crypto.createHmac('sha256', UNSUB_SECRET).update(base).digest('hex').slice(0,32);
  const payload = Buffer.from(base).toString('base64url');
  return `${payload}.${sig}`;
}
function buildUnsubUrl(email) {
  const token = makeUnsubToken(email);
  const sep = UNSUB_PAGE.includes('?') ? '&' : '?';
  return `${UNSUB_PAGE}${sep}token=${encodeURIComponent(token)}`;
}

// Inserta pie legal y bloque de baja si no existe ya un marcador.
// Marca mínima para evitar duplicados: data-lb-legal / data-lb-unsub
function ensureLegalAndUnsub(html, unsubUrl) {
  const H = String(html || '');
  const hasLegal = /data-lb-legal/.test(H);
  const hasUnsub = /data-lb-unsub/.test(H) || /unsubscribe|darse de baja|baja de la newsletter/i.test(H);

  const pieHtml = `
    <div data-lb-legal style="font-size:12px;color:#777;line-height:1.5;margin-top:28px">
      <hr style="margin:24px 0 12px" />
      En cumplimiento del Reglamento (UE) 2016/679 (RGPD) y la LOPDGDD, le informamos de que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera (DNI 20481042W), con domicilio en calle Enmedio nº 22, 3.º E, 12001 Castellón de la Plana (España).<br /><br />
      Finalidades: prestación de servicios jurídicos, venta de infoproductos, gestión de entradas a eventos, emisión y envío de facturas por email y, en su caso, envío de newsletter y comunicaciones comerciales si usted lo ha consentido. Base jurídica: ejecución de contrato y/o consentimiento. Puede retirar su consentimiento en cualquier momento.<br /><br />
      Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición escribiendo a <a href="mailto:laboroteca@gmail.com">laboroteca@gmail.com</a>. También puede presentar una reclamación ante la autoridad de control competente. Más información en nuestra política de privacidad: <a href="https://www.laboroteca.es/politica-de-privacidad/" target="_blank" rel="noopener">https://www.laboroteca.es/politica-de-privacidad/</a>.
    </div>
  `;

  const unsubHtml = `
    <p data-lb-unsub style="font-size:12px;color:#666;margin-top:18px">
      Si no deseas seguir recibiendo este boletín, puedes darte de baja aquí:
      <a href="${unsubUrl}" target="_blank" rel="noopener">cancelar suscripción</a>.
    </p>
  `;

  let out = H;
  if (!hasUnsub) out += unsubHtml;
  if (!hasLegal) out += pieHtml;
  return out;
}

async function sendSMTP2GO({ to, subject, html, listUnsubUrl }) {
  if (!SMTP2GO_API_KEY) throw new Error('SMTP2GO_API_KEY missing');

  const payload = {
    api_key: SMTP2GO_API_KEY,
    to: [to],
    sender: `${FROM_NAME} <${FROM_EMAIL}>`,
    subject,
    html_body: html
  };

  if (listUnsubUrl) {
    payload.custom_headers = [
      { header: 'List-Unsubscribe',      value: `<${listUnsubUrl}>` },
      { header: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }
    ];
  }

  const res = await fetch(SMTP2GO_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));

  const failuresLen  = Array.isArray(data?.data?.failures) ? data.data.failures.length : 0;
  const succeededNum = typeof data?.data?.succeeded === 'number' ? data.data.succeeded : NaN;
  const succeededArr = Array.isArray(data?.data?.succeeded) ? data.data.succeeded : null;
  const hasSucceeded = (Number.isFinite(succeededNum) && succeededNum > 0) ||
                       (Array.isArray(succeededArr) && succeededArr.length > 0);
  const hasEmailId   = Boolean(data?.data?.email_id);

  if (res.ok && failuresLen === 0 && (hasSucceeded || hasEmailId)) return data;
  throw new Error(`SMTP2GO failed: ${JSON.stringify(data).slice(0,400)}`);
}

// ───────── Suppression cache ─────────
let _supCache = { set: new Set(), exp: 0 };
async function loadSuppressionSetCached() {
  const nowMs = Date.now();
  if (_supCache.exp > nowMs && _supCache.set.size) return _supCache.set;
  const sshot = await db.collection('suppressionList').get();
  _supCache.set = new Set(sshot.docs.map(d => (d.id || '').toLowerCase()));
  _supCache.exp = nowMs + SUPPRESSION_TTL_MS;
  return _supCache.set;
}

// ───────── Resolución de destinatarios ─────────
async function resolveRecipients({ materias, testOnly, onlyCommercial }) {
  if (testOnly) return TEST_TO;

  const snap = await db.collection('marketingConsents')
    .where('consent_marketing', '==', true)
    .get();

  const set = new Set();
  snap.forEach(doc => {
    const d = doc.data() || {};
    // Si hay materias seleccionadas, exige coincidencia con ≥1 materia.
    // Si NO hay materias y onlyCommercial=true, no se filtra por materias.
    const hasAnyMateria = Object.values(materias || {}).some(Boolean);
    let match = true;
    if (hasAnyMateria) {
      match = false;
      for (const k of Object.keys(materias || {})) {
        if (materias[k] && d.materias?.[k]) { match = true; break; }
      }
    }
    // Filtro consentimiento comercial cuando se solicita
    if (onlyCommercial === true && d.consent_comercial !== true) {
      match = false;
    }
    // Siempre requiere estar en newsletter (consent_marketing=true)
    if (d.consent_marketing !== true) match = false;
    if (match && d.email && typeof d.email === 'string' && d.email.includes('@')) {
      set.add(d.email.toLowerCase());
    }
  });

  // filtra por suppression (cache)
  const sup = await loadSuppressionSetCached();
  return Array.from(set).filter(e => !sup.has((e||'').toLowerCase()));
}

// ───────── Lease y reclamación de jobs ─────────
async function claimJobs(limit) {
  const nowTs = now();
  const leaseUntil = new Date(nowTs.getTime() + LEASE_MINUTES * 60000);

  const pendingQ = await db.collection('emailQueue')
    .where('status', '==', 'pending')
    .where('scheduledAt', '<=', admin.firestore.Timestamp.fromDate(nowTs))
    .orderBy('scheduledAt', 'asc')
    .limit(limit)
    .get();

  // También rescatar “processing” expirados
  const processingQ = await db.collection('emailQueue')
    .where('status', '==', 'processing')
    .where('leaseUntil', '<=', admin.firestore.Timestamp.fromDate(nowTs))
    .orderBy('leaseUntil', 'asc')
    .limit(limit)
    .get();

  const candidates = [...pendingQ.docs, ...processingQ.docs].slice(0, limit);

  const claimed = [];
  for (const doc of candidates) {
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        const d = snap.data() || {};
        const isPending    = d.status === 'pending';
        const isExpiredProc= d.status === 'processing' && d.leaseUntil && d.leaseUntil.toDate() <= nowTs;
        if (!isPending && !isExpiredProc) return;

        const workerId = crypto.randomBytes(6).toString('hex');
        tx.update(doc.ref, {
          status: 'processing',
          leaseUntil: admin.firestore.Timestamp.fromDate(leaseUntil),
          startedAt: admin.firestore.Timestamp.fromDate(nowTs),
          startedAtISO: nowISO(),
          workerId
        });
      });
      claimed.push(doc.ref);
    } catch (_) { /* otro worker lo reclamó */ }
  }
  return claimed;
}

// ───────── Backoff exponencial + jitter ─────────
function nextAttemptDate(ts, attempts) {
  // 1m, 2m, 4m, 8m, ... máx 15m, con jitter ±20%
  const baseMin = Math.min(2 ** Math.max(0, attempts - 1), 15);
  const jitter  = 0.2 * baseMin;
  const realMin = baseMin + (Math.random()*2*jitter - jitter);
  return new Date(ts.getTime() + Math.max(1, Math.round(realMin*60000)));
}

// ───────── Pool de concurrencia ─────────
async function withPool(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0, active = 0;
  return new Promise((resolve) => {
    const kick = () => {
      if (i >= items.length && active === 0) return resolve(results);
      while (active < limit && i < items.length) {
        const idx = i++, item = items[idx];
        active++;
        Promise.resolve().then(() => worker(item, idx))
          .then(r=>{ results[idx]=r; })
          .catch(e=>{ results[idx]={ ok:false, error: String(e?.message||e) }; })
          .finally(()=>{ active--; kick(); });
      }
    };
    kick();
  });
}

// ───────── Proceso de un CHUNK ─────────
async function processChunk({ ref, job, recipients, startIndex, chunkSize }) {
  const subject  = String(job.subject || '');
  const htmlBase = String(job.html || '');
  const jobId    = ref.id;

  let sent=0, skipped=0, failed=0;

  const slice = recipients.slice(startIndex, startIndex + chunkSize);

  // Enviar en paralelo con límite de concurrencia
  await withPool(slice, CONCURRENCY, async (to, idxInChunk) => {
    const absIndex = startIndex + idxInChunk;

    // Deduplicación por destinatario & campaña: immediate y cron comparten colección
    const dedupId  = `cron:${jobId}:${sha256(to)}`;
    const dedupRef = db.collection('emailSendDedup').doc(dedupId);

    // Reserva: si existe, no reenviar
    try {
      await dedupRef.create({
        mode: 'cron',
        jobId,
        emailHash: sha256(to.toLowerCase()),
        createdAt: admin.firestore.Timestamp.fromDate(new Date()),
        createdAtISO: nowISO(),
        status: 'pending'
      });
    } catch {
      skipped++;
      return;
    }

    try {
      const unsubUrl  = buildUnsubUrl(to);
      const finalHtml = ensureLegalAndUnsub(htmlBase, unsubUrl);

      // Protección: tamaño máximo del HTML final
      const bytes = Buffer.byteLength(finalHtml || '', 'utf8');
      if (bytes > MAX_HTML_BYTES) {
        throw new Error(`HTML_TOO_LARGE (${bytes} > ${MAX_HTML_BYTES})`);
      }

      await sendSMTP2GO({
        to,
        subject,
        html: finalHtml,
        listUnsubUrl: unsubUrl
      });

      await dedupRef.set({
        status: 'sent',
        sentAt: admin.firestore.Timestamp.fromDate(new Date()),
        sentAtISO: nowISO()
      }, { merge: true });

      sent++;

      if (RATE_DELAY_MS > 0) await sleep(RATE_DELAY_MS);
    } catch (e) {
      failed++;
      // liberar para futuros reintentos del mismo job
      try { await dedupRef.delete(); } catch {}
      if (LAB_DEBUG) console.warn('%s fallo envío → %s : %s', LOG_PREFIX, maskEmail(to), e?.message||e);
    }

    // checkpoint parcial cada ~25 envíos o al final del slice
    if ((absIndex % 25 === 0) || absIndex === (startIndex + slice.length - 1)) {
      try {
        await ref.update({
          'progress.lastIndex': absIndex + 1, // siguiente a procesar
          'progress.sent': admin.firestore.FieldValue.increment(sent),
          'progress.skipped': admin.firestore.FieldValue.increment(skipped),
          'progress.failed': admin.firestore.FieldValue.increment(failed),
          updatedAt: admin.firestore.Timestamp.fromDate(new Date()),
          updatedAtISO: nowISO()
        });
        // reinicia contadores parciales tras persistir (para no sumar dos veces)
        sent=0; skipped=0; failed=0;
      } catch {}
    }
  });

  return { sent, skipped, failed };
}

// ───────── Proceso de un JOB ─────────
async function processJob(ref) {
  const ts = now();
  const tsISO = ts.toISOString();

  const snap = await ref.get();
  if (!snap.exists) return { skipped:true, reason:'missing' };
  const job = snap.data() || {};

  if (job.status !== 'processing') return { skipped:true, reason:'not_processing' };

  let attempts   = Number(job.attempts || 0);
  const subject  = String(job.subject || '');
  const html     = String(job.html || '');
  const materias = job.materias || {};
  const testOnly = !!job.testOnly;
  const onlyCommercial = !!job.onlyCommercial;

  if (!subject || !html) {
    await ref.update({ status:'failed', finishedAtISO:tsISO, error:'INVALID_JOB' });
    return { ok:false, error:'INVALID_JOB' };
  }

  try {
    // Recupera (o resuelve) destinatarios y estado de progreso
    let recipients = Array.isArray(job.recipientsSnapshot) ? job.recipientsSnapshot : null;
    if (!recipients) {
      recipients = await resolveRecipients({ materias, testOnly, onlyCommercial });
      // Guarda snapshot para consistencia del job
      await ref.update({
        recipientsSnapshot: recipients,
        'progress.total': recipients.length,
        'progress.lastIndex': Number(job.progress?.lastIndex || 0),
        updatedAt: admin.firestore.Timestamp.fromDate(new Date()),
        updatedAtISO: nowISO()
      });
    }

    const total = recipients.length;
    let lastIndex = Number(job.progress?.lastIndex || 0);
    let aggSent   = Number(job.progress?.sent || 0);
    let aggSkip   = Number(job.progress?.skipped || 0);
    let aggFail   = Number(job.progress?.failed || 0);

    if (total === 0) {
      await ref.update({ status:'done', finishedAtISO:tsISO, sent:0, recipients:[] });
      return { ok:true, sent:0 };
    }

    // Procesa por chunks hasta completar
    while (lastIndex < total) {
      // Extiende lease en cada chunk para evitar caducidad
      const leaseUntil = new Date(Date.now() + LEASE_MINUTES * 60000);
      try {
        await ref.update({
          leaseUntil: admin.firestore.Timestamp.fromDate(leaseUntil),
          heartbeatAt: admin.firestore.Timestamp.fromDate(new Date()),
          heartbeatAtISO: nowISO()
        });
      } catch {}

      const { sent, skipped, failed } = await processChunk({
        ref, job, recipients, startIndex: lastIndex, chunkSize: CHUNK_SIZE
      });

      aggSent += sent; aggSkip += skipped; aggFail += failed;
      lastIndex += CHUNK_SIZE;

      // Si hubo demasiados fallos en este ciclo, corta para reintentar luego
      if (failed > 0 && (failed >= Math.ceil(CHUNK_SIZE * 0.25))) break;
    }

    // Si completado
    if (lastIndex >= total) {
      // Log envío
      await db.collection('emailSends').add({
        subject, html, materias, testOnly, onlyCommercial,
        recipientsCount: total,
        createdAt: admin.firestore.Timestamp.fromDate(ts),
        createdAtISO: tsISO,
        jobId: ref.id,
        stats: { sent: aggSent, skipped: aggSkip, failed: aggFail }
      });

      await ref.update({
        status: 'done',
        finishedAt: admin.firestore.Timestamp.fromDate(new Date()),
        finishedAtISO: nowISO(),
        sent: aggSent,
        skipped: aggSkip,
        failed: aggFail,
        error: admin.firestore.FieldValue.delete()
      });

      return { ok:true, sent: aggSent, skipped: aggSkip, failed: aggFail };
    }

    // Si no completado (break antes), reagenda con backoff suave
    attempts += 1;
    const retry = attempts < MAX_ATTEMPTS;
    const next  = nextAttemptDate(new Date(), attempts);

    await ref.update({
      status: retry ? 'pending' : 'failed',
      attempts,
      lastError: aggFail ? `partial_failures=${aggFail}` : 'partial_progress',
      nextAttemptAt: admin.firestore.Timestamp.fromDate(next),
      nextAttemptAtISO: next.toISOString(),
      updatedAt: admin.firestore.Timestamp.fromDate(new Date()),
      updatedAtISO: nowISO(),
      'progress.sent': aggSent,
      'progress.skipped': aggSkip,
      'progress.failed': aggFail,
      'progress.lastIndex': lastIndex
    });

    if (!retry) {
      try { await alertAdmin({ area:'cron_send_deadletter', err:new Error('DLQ'), meta:{ jobId: ref.id } }); } catch {}
    }

    return { ok:false, partial:true, sent: aggSent, skipped: aggSkip, failed: aggFail, retry };

  } catch (e) {
    attempts += 1;
    const retry = attempts < MAX_ATTEMPTS;
    const next  = nextAttemptDate(ts, attempts);

    await ref.update({
      status: retry ? 'pending' : 'failed',
      attempts,
      lastError: String(e?.message || e),
      nextAttemptAt: admin.firestore.Timestamp.fromDate(next),
      nextAttemptAtISO: next.toISOString(),
      updatedAt: admin.firestore.Timestamp.fromDate(new Date()),
      updatedAtISO: nowISO()
    });

    try { await alertAdmin({ area:'cron_send_fail', err:e, meta:{ jobId:ref.id, attempts, retry } }); } catch {}

    return { ok:false, error: e?.message || 'SEND_FAIL', attempts, retry };
  }
}

// ───────── Endpoint cron ─────────
router.post('/cron-send', async (req, res) => {
  // IP allowlist opcional
  if (IP_ALLOWLIST) {
    const allow = new Set(IP_ALLOWLIST.split(',').map(x => x.trim()).filter(Boolean));
    if (!allow.has(clientIp(req))) {
      return res.status(403).json({ ok:false, error:'IP_FORBIDDEN' });
    }
  }

  if (!requireCronKey(req, res)) return;
  if (!requireCronHmac(req, res)) return;

  const startedAtISO = nowISO();
  try {
    const claimed = await claimJobs(MAX_JOBS_PER_RUN);
    const results = [];
    for (const ref of claimed) {
      const r = await processJob(ref);
      results.push({ id: ref.id, ...r });
    }

    if (claimed.length === 0) {
      return res.json({ ok:true, message:'No pending jobs', startedAtISO });
    }
    return res.json({ ok:true, startedAtISO, processed: results.length, results });
  } catch (e) {
    console.error('❌ marketing/cron-send error:', e?.message || e);
    try { await alertAdmin({ area:'cron_send_unexpected', err:e, meta:{} }); } catch {}
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});

module.exports = router;
