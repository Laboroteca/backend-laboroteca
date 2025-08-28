// routes/marketing-cron.js
// ──────────────────────────────────────────────────────────────
// Dispara envíos programados (emailQueue) cuando llega su hora.
// POST /marketing/cron-send  (recomendado con cabecera x-cron-key)
// - Reclama trabajos con scheduledAt <= now y status='pending' (lease)
// - Resuelve destinatarios por materias (o testOnly)
// - Filtra suppressionList
// - Envía por SMTP2GO en chunks
// - Log en emailSends y marca job done/failed (con reintentos)
// Env: MKT_CRON_KEY, SMTP2GO_API_KEY, EMAIL_FROM, EMAIL_FROM_NAME
// ──────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

if (!admin.apps.length) { try { admin.initializeApp(); } catch (_) {} }
const db = admin.firestore();

const router = express.Router();

// ───────── CONFIG ─────────
const CRON_KEY = process.env.MKT_CRON_KEY || ''; // cabecera x-cron-key
const SMTP2GO_API_KEY = process.env.SMTP2GO_API_KEY || '';
const FROM_EMAIL = process.env.EMAIL_FROM || 'newsletter@laboroteca.es';
const FROM_NAME  = process.env.EMAIL_FROM_NAME || 'Laboroteca Newsletter';

const MAX_JOBS_PER_RUN = Number(process.env.CRON_MAX_JOBS || 8);
const CHUNK_SIZE = Number(process.env.CRON_CHUNK_SIZE || 80); // destinatarios por llamada SMTP
const MAX_ATTEMPTS = Number(process.env.CRON_MAX_ATTEMPTS || 3);
const LEASE_MINUTES = Number(process.env.CRON_LEASE_MIN || 5);

const now = () => new Date();
const nowISO = () => new Date().toISOString();

// ───────── Helpers ─────────
function requireCronKey(req, res) {
  const key = String(req.headers['x-cron-key'] || '');
  if (!CRON_KEY || key !== CRON_KEY) {
    res.status(401).json({ ok:false, error:'UNAUTHORIZED_CRON' });
    return false;
  }
  return true;
}

async function sendSMTP2GO({ to, subject, html }) {
  if (!SMTP2GO_API_KEY) throw new Error('SMTP2GO_API_KEY missing');

  const payload = {
    api_key: SMTP2GO_API_KEY,
    to: Array.isArray(to) ? to : [to],
    sender: `${FROM_NAME} <${FROM_EMAIL}>`,
    subject,
    html_body: html
  };

  const res = await fetch('https://api.smtp2go.com/v3/email/send', {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(()=> ({}));
  const ok = res.ok && (Array.isArray(data?.data?.succeeded) ? data.data.succeeded.length > 0 : true);
  if (!ok) {
    throw new Error(`SMTP2GO failed: ${JSON.stringify(data)}`);
  }
  return data;
}

function chunk(arr, size) {
  const r = [];
  for (let i=0; i<arr.length; i+=size) r.push(arr.slice(i, i+size));
  return r;
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

async function loadSuppressionSet() {
  const s = await db.collection('suppressionList').get();
  return new Set(s.docs.map(d => (d.id || '').toLowerCase()));
}

async function resolveRecipients({ materias, testOnly }) {
  if (testOnly) {
    return ['ignacio.solsona@icacs.com', 'laboroteca@gmail.com'];
  }
  // Nota: para bases grandes conviene indexar y consultar por cada materia true y hacer unión.
  const snap = await db.collection('marketingConsents')
    .where('consent_marketing', '==', true)
    .get();

  const result = [];
  snap.forEach(doc => {
    const d = doc.data() || {};
    let match = false;
    for (const k of Object.keys(materias || {})) {
      if (materias[k] && d.materias && d.materias[k]) { match = true; break; }
    }
    if (match) result.push(d.email);
  });
  return Array.from(new Set(result.map(e => String(e||'').toLowerCase()))); // dedup
}

async function processJob(ref) {
  const ts = now();
  const tsISO = ts.toISOString();

  const snap = await ref.get();
  if (!snap.exists) return { skipped:true, reason:'missing' };
  const job = snap.data() || {};

  // Si perdió el lease o alguien lo cambió, devolvemos
  if (job.status !== 'processing') return { skipped:true, reason:'not_processing' };

  let attempts = Number(job.attempts || 0);
  const subject  = String(job.subject || '');
  const html     = String(job.html || '');
  const materias = job.materias || {};
  const testOnly = !!job.testOnly;

  if (!subject || !html) {
    await ref.update({ status:'failed', finishedAtISO:tsISO, error:'INVALID_JOB' });
    return { ok:false, error:'INVALID_JOB' };
  }

  try {
    // Destinatarios
    let recipients = await resolveRecipients({ materias, testOnly });
    const suppression = await loadSuppressionSet();
    recipients = recipients.filter(e => !suppression.has((e||'').toLowerCase()));

    // Enviar por chunks
    let sent = 0;
    if (recipients.length === 0) {
      // Nada que enviar (segmentación vacía tras supresión)
      await ref.update({ status:'done', finishedAtISO:tsISO, sent:0, recipients:[] });
      return { ok:true, sent:0 };
    }

    const chunks = chunk(recipients, CHUNK_SIZE);
    for (const c of chunks) {
      await sendSMTP2GO({ to: c, subject, html });
      sent += c.length;
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
    const next = new Date(ts.getTime() + Math.min(60 * attempts, 15) * 60000); // backoff: 1m,2m,3m… máx 15m

    await ref.update({
      status: retry ? 'pending' : 'failed',
      attempts,
      lastError: String(e?.message || e),
      nextAttemptAt: admin.firestore.Timestamp.fromDate(next),
      nextAttemptAtISO: next.toISOString()
    });

    try {
      await alertAdmin(`❌ Cron newsletter: fallo enviando job ${ref.id}`, {
        attempts, retry, error: e?.message || String(e)
      });
    } catch (_) {}

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
    try {
      await alertAdmin(`❌ Error en /marketing/cron-send: ${e?.message || e}`, {});
    } catch (_) {}
    return res.status(500).json({ ok:false, error:'SERVER_ERROR' });
  }
});

module.exports = router;
