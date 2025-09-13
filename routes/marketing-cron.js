// routes/marketing-cron.js
// ──────────────────────────────────────────────────────────────
// Dispara envíos programados (emailQueue) cuando llega su hora.
// POST /marketing/cron-send  (recomendado con cabecera x-cron-key)
//
// Producción: incluye pie legal y enlace de baja con token por
// destinatario + cabecera List-Unsubscribe. Envía 1 a 1 para
// personalizar el enlace de baja.
//
// - Reclama trabajos con scheduledAt <= now y status='pending' (lease)
// - Resuelve destinatarios por materias (o testOnly)
// - Filtra suppressionList
// - Envía por SMTP2GO (uno a uno, con headers)
// - Log en emailSends y marca job done/failed (con reintentos)
// Env: MKT_CRON_KEY, SMTP2GO_API_KEY, SMTP2GO_API_URL?, EMAIL_FROM, EMAIL_FROM_NAME,
//      MKT_UNSUB_SECRET, MKT_UNSUB_PAGE, CRON_MAX_JOBS?, CRON_MAX_ATTEMPTS?,
//      CRON_LEASE_MIN?, CRON_RATE_DELAY_MS?
// ──────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const admin   = require('firebase-admin');
const crypto  = require('crypto');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

// fetch: usa el nativo (Node 18+) y si no existe, carga node-fetch dinámicamente
const fetch = (global.fetch)
  ? global.fetch
  : (...args) => import('node-fetch').then(m => m.default(...args));

if (!admin.apps.length) { try { admin.initializeApp(); } catch (_) {} }
const db = admin.firestore();

const router = express.Router();

// ───────── CONFIG ─────────
const CRON_KEY          = String(process.env.MKT_CRON_KEY || '').trim(); // cabecera x-cron-key
const SMTP2GO_API_KEY   = String(process.env.SMTP2GO_API_KEY || '').trim();
const SMTP2GO_API_URL   = String(process.env.SMTP2GO_API_URL || 'https://api.smtp2go.com/v3/email/send');
const FROM_EMAIL        = String(process.env.EMAIL_FROM || process.env.SMTP2GO_FROM_EMAIL || 'newsletter@laboroteca.es').trim();
const FROM_NAME         = String(process.env.EMAIL_FROM_NAME || process.env.SMTP2GO_FROM_NAME || 'Laboroteca Newsletter').trim();

const UNSUB_SECRET      = String(process.env.MKT_UNSUB_SECRET || 'laboroteca-unsub').trim();
const UNSUB_PAGE        = String(process.env.MKT_UNSUB_PAGE   || 'https://www.laboroteca.es/unsubscribe/').trim();

const MAX_JOBS_PER_RUN  = Number(process.env.CRON_MAX_JOBS || 8);
const MAX_ATTEMPTS      = Number(process.env.CRON_MAX_ATTEMPTS || 3);
const LEASE_MINUTES     = Number(process.env.CRON_LEASE_MIN || 5);
// Throttle suave entre correos (ms) para evitar ráfagas (opcional)
const RATE_DELAY_MS     = Number(process.env.CRON_RATE_DELAY_MS || 0);

const LOG_PREFIX = '[marketing/cron-send]';
const now       = () => new Date();
const nowISO    = () => new Date().toISOString();

// ───────── Helpers ─────────
function requireCronKey(req, res) {
  const key = String(req.headers['x-cron-key'] || '');
  if (!CRON_KEY || key !== CRON_KEY) {
    res.status(401).json({ ok:false, error:'UNAUTHORIZED_CRON' });
    return false;
  }
  return true;
}

const sleep = (ms) => ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();

function sha256HexBuf(buf) {
  return crypto.createHash('sha256').update(buf || Buffer.alloc(0)).digest('hex');
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
      Si no deseas seguir recibiendo esta newsletter, puedes darte de baja aquí:
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

  const custom_headers = {};
  if (listUnsubUrl) {
    // Cabecera estándar para mejorar deliverability y facilitar baja
    custom_headers['List-Unsubscribe'] = `<${listUnsubUrl}>`;
    // Opcional: List-Unsubscribe-Post: List-Unsubscribe=One-Click (no todos los ESP lo admiten)
    custom_headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const payload = {
    api_key: SMTP2GO_API_KEY,
    to: [to], // individual para token por destinatario
    sender: `${FROM_NAME} <${FROM_EMAIL}>`,
    subject,
    html_body: html,
    custom_headers
  };

  const res = await fetch(SMTP2GO_API_URL, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(()=> ({}));

  // Detección robusta (coherente con /marketing/send)
  const failuresLen  = Array.isArray(data?.data?.failures) ? data.data.failures.length : 0;
  const succeededNum = typeof data?.data?.succeeded === 'number' ? data.data.succeeded : NaN;
  const succeededArr = Array.isArray(data?.data?.succeeded) ? data.data.succeeded : null;
  const hasSucceeded = (Number.isFinite(succeededNum) && succeededNum > 0) ||
                       (Array.isArray(succeededArr) && succeededArr.length > 0);
  const hasEmailId   = Boolean(data?.data?.email_id);

  if (res.ok && failuresLen === 0 && (hasSucceeded || hasEmailId)) {
    return data;
  }
  throw new Error(`SMTP2GO failed: ${JSON.stringify(data).slice(0,400)}`);
}

async function loadSuppressionSet() {
  const s = await db.collection('suppressionList').get();
  return new Set(s.docs.map(d => (d.id || '').toLowerCase()));
}

async function resolveRecipients({ materias, testOnly }) {
  if (testOnly) return ['ignacio.solsona@icacs.com', 'laboroteca@gmail.com'];

  // Nota: para bases grandes conviene indexar cada materia por separado.
  const snap = await db.collection('marketingConsents')
    .where('consent_marketing', '==', true)
    .get();

  const set = new Set();
  snap.forEach(doc => {
    const d = doc.data() || {};
    let match = false;
    for (const k of Object.keys(materias || {})) {
      if (materias[k] && d.materias?.[k]) { match = true; break; }
    }
    if (match && d.email && typeof d.email === 'string' && d.email.includes('@')) {
      set.add(d.email.toLowerCase());
    }
  });

  return Array.from(set);
}

// Reclama un conjunto de jobs (lease) evitando carreras
async function claimJobs(limit) {
  const nowTs = now();
  const leaseUntil = new Date(nowTs.getTime() + LEASE_MINUTES * 60000);

  const q = await db.collection('emailQueue')
    .where('status', '==', 'pending')
    .where('scheduledAt', '<=', admin.firestore.Timestamp.fromDate(nowTs))
    .orderBy('scheduledAt', 'asc')
    .limit(limit)
    .get();

  const claimed = [];
  for (const doc of q.docs) {
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        const d = snap.data() || {};
        if (d.status !== 'pending') return;
        tx.update(doc.ref, {
          status: 'processing',
          leaseUntil: admin.firestore.Timestamp.fromDate(leaseUntil),
          startedAt: admin.firestore.Timestamp.fromDate(nowTs),
          startedAtISO: nowISO(),
          workerId: crypto.randomBytes(6).toString('hex')
        });
      });
      claimed.push(doc.ref);
    } catch (_) {
      // otro worker lo reclamó; ignoramos
    }
  }
  return claimed;
}

async function processJob(ref) {
  const ts = now();
  const tsISO = ts.toISOString();

  const snap = await ref.get();
  if (!snap.exists) return { skipped:true, reason:'missing' };
  const job = snap.data() || {};

  if (job.status !== 'processing') return { skipped:true, reason:'not_processing' };

  let attempts  = Number(job.attempts || 0);
  const subject = String(job.subject || '');
  const html    = String(job.html || '');
  const materias= job.materias || {};
  const testOnly= !!job.testOnly;

  if (!subject || !html) {
    await ref.update({ status:'failed', finishedAtISO:tsISO, error:'INVALID_JOB' });
    return { ok:false, error:'INVALID_JOB' };
  }

  try {
    // Destinatarios + supresión
    let recipients = await resolveRecipients({ materias, testOnly });
    const suppression = await loadSuppressionSet();
    recipients = recipients.filter(e => !suppression.has((e||'').toLowerCase()));

    // Nada que enviar
    if (recipients.length === 0) {
      await ref.update({ status:'done', finishedAtISO:tsISO, sent:0, recipients:[] });
      return { ok:true, sent:0 };
    }

    // Envío 1 a 1 para personalizar link de baja
    let sent = 0;
    for (const to of recipients) {
      const unsubUrl = buildUnsubUrl(to);
      const finalHtml = ensureLegalAndUnsub(html, unsubUrl);

      await sendSMTP2GO({ to, subject, html: finalHtml, listUnsubUrl: unsubUrl });
      sent += 1;

      if (RATE_DELAY_MS > 0) await sleep(RATE_DELAY_MS);
    }

    // Log envío
    await db.collection('emailSends').add({
      subject, html, materias, testOnly,
      recipientsCount: sent,
      createdAt: admin.firestore.Timestamp.fromDate(ts),
      createdAtISO: tsISO,
      jobId: ref.id
    });

    // Completar job
    await ref.update({
      status: 'done',
      finishedAt: admin.firestore.Timestamp.fromDate(ts),
      finishedAtISO: tsISO,
      sent,
      error: admin.firestore.FieldValue.delete()
    });

    return { ok:true, sent };
  } catch (e) {
    attempts += 1;
    const retry = attempts < MAX_ATTEMPTS;
    const next = new Date(ts.getTime() + Math.min(60 * attempts, 15) * 60000); // backoff: 1m,2m,… máx 15m

    await ref.update({
      status: retry ? 'pending' : 'failed',
      attempts,
      lastError: String(e?.message || e),
      nextAttemptAt: admin.firestore.Timestamp.fromDate(next),
      nextAttemptAtISO: next.toISOString()
    });

    try { await alertAdmin({ area:'cron_send_fail', err:e, meta:{ jobId:ref.id, attempts, retry } }); } catch {}

    return { ok:false, error: e?.message || 'SEND_FAIL', attempts, retry };
  }
}

// ───────── Endpoint cron ─────────
router.post('/cron-send', async (req, res) => {
  if (!requireCronKey(req, res)) return;

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
