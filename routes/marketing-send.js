// routes/marketing-send.js
// ──────────────────────────────────────────────────────────────
// Endpoint seguro para enviar / programar newsletters.
// POST /marketing/send  (alias: /marketing/send-newsletter)
//   Headers: x-lb-ts, x-lb-sig  (HMAC sha256 con MKT_SEND_SECRET)
//   Body: { subject, html, materias:{...}, scheduledAt?, testOnly? }
//
// - testOnly: fuerza envío solo a lista restringida (Ignacio + Laboroteca)
// - scheduledAt vacío = envío inmediato
// - Firestore: registra en emailQueue (si programado) o emailSends (si inmediato)
// - Respeta suppressionList y segmentación por materias
// - Usa SMTP2GO API
// ──────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const fetch = require('node-fetch');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const router = express.Router();

// ───────── CONFIG ─────────
const SECRET = String(process.env.MKT_SEND_SECRET || '').trim();
const HMAC_WINDOW_MS = 5 * 60 * 1000; // ±5 min
const FROM_EMAIL = process.env.EMAIL_FROM || 'newsletter@laboroteca.es';
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'Laboroteca Newsletter';
const SMTP2GO_API_KEY = String(process.env.SMTP2GO_API_KEY || '').trim();
const LOG_PREFIX = '[marketing/send]';

if (!admin.apps.length) { try { admin.initializeApp(); } catch (_) {} }
const db = admin.firestore();

// ───────── Helpers ─────────
const s = v => (v === undefined || v === null) ? '' : String(v);
const nowISO = () => new Date().toISOString();

function timingEq(a, b) {
  try { return a.length === b.length && crypto.timingSafeEqual(a, b); }
  catch { return false; }
}
function b64urlToBuf(str){
  const ss = String(str).replace(/-/g,'+').replace(/_/g,'/');
  const pad = ss.length % 4 ? '='.repeat(4 - (ss.length % 4)) : '';
  return Buffer.from(ss + pad, 'base64');
}
function normalizePath(p) {
  try {
    p = (p || '/').toString().split('#')[0].split('?')[0];
    if (p[0] !== '/') p = '/' + p;
    return p.replace(/\/{2,}/g, '/');
  } catch { return '/'; }
}

/**
 * Verifica HMAC del panel WP. Acepta:
 *  - v0 crudo:   HMAC(ts + "." + rawBody)              (ts en s o ms, firma hex/base64)
 *  - v1 hash:    HMAC(ts + "." + sha256(body))
 *  - v2 path:    HMAC(ts + ".POST." + <path> + "." + sha256(body))
 */
function verifyHmac(req) {
  const tsRaw = s(req.headers['x-lb-ts']);
  const sig   = s(req.headers['x-lb-sig']);
  if (!tsRaw || !sig || !SECRET) return { ok:false, error:'missing_headers_or_secret' };

  const tsNum = Number(tsRaw);
  if (!Number.isFinite(tsNum)) return { ok:false, error:'bad_ts' };
  const tsMs  = tsNum > 1e11 ? tsNum : tsNum * 1000;
  if (Math.abs(Date.now() - tsMs) > HMAC_WINDOW_MS) return { ok:false, error:'skew' };
  const tsSec = Math.floor(tsMs / 1000);
  const tsMsStr  = String(Math.floor(tsMs));
  const tsSecStr = String(tsSec);

  if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length === 0) {
    return { ok:false, error:'no_raw_body' };
  }
  const raw      = req.rawBody;
  const bodyHash = crypto.createHash('sha256').update(raw).digest('hex');

  const paths = Array.from(new Set([
    normalizePath((req.baseUrl || '') + (req.path || '')),
    normalizePath((req.originalUrl || '').split('?')[0]),
    '/marketing/send',
    '/marketing/send-newsletter',
    '/send',
    '/send-newsletter'
  ].filter(Boolean)));

  const candidates = [];
  // v0: ts.rawBody
  candidates.push({ label:'v0_raw_s',  bin: crypto.createHmac('sha256', SECRET).update(tsSecStr).update('.').update(raw).digest() });
  candidates.push({ label:'v0_raw_ms', bin: crypto.createHmac('sha256', SECRET).update(tsMsStr ).update('.').update(raw).digest() });
  // v1: ts.sha256(body)
  candidates.push({ label:'v1_hash_s',  hex: crypto.createHmac('sha256', SECRET).update(`${tsSecStr}.${bodyHash}`).digest('hex') });
  candidates.push({ label:'v1_hash_ms', hex: crypto.createHmac('sha256', SECRET).update(`${tsMsStr}.${bodyHash}` ).digest('hex') });
  // v2: ts.POST.<path>.sha256(body)
  for (const p of paths) {
    const baseS  = `${tsSecStr}.POST.${p}.${bodyHash}`;
    const baseMs = `${tsMsStr}.POST.${p}.${bodyHash}`;
    candidates.push({ label:`v2_${p}_s`,  hex: crypto.createHmac('sha256', SECRET).update(baseS ).digest('hex') });
    candidates.push({ label:`v2_${p}_ms`, hex: crypto.createHmac('sha256', SECRET).update(baseMs).digest('hex') });
  }

  const isHex = /^[0-9a-f]{64}$/i.test(sig);
  if (isHex) {
    const sigHexBuf = Buffer.from(sig, 'utf8');
    for (const c of candidates) {
      const expHex = c.hex || (c.bin && c.bin.toString('hex'));
      if (!expHex) continue;
      const expHexBuf = Buffer.from(expHex, 'utf8');
      if (timingEq(sigHexBuf, expHexBuf)) return { ok:true, variant:c.label, bodyHash };
    }
  } else {
    try {
      const sigBin = b64urlToBuf(sig);
      for (const c of candidates) {
        const expBin = c.bin || (c.hex && Buffer.from(c.hex, 'hex'));
        if (!expBin) continue;
        if (timingEq(sigBin, expBin)) return { ok:true, variant:c.label, bodyHash };
      }
    } catch {
      return { ok:false, error:'bad_sig_format' };
    }
  }
  return { ok:false, error:'no_variant_match', bodyHash };
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !(data?.data?.succeeded?.length > 0)) {
    throw new Error(`SMTP2GO send failed: ${JSON.stringify(data).slice(0,400)}`);
  }
  return data;
}

// ───────── Ruta principal ─────────
router.post(['/send', '/send-newsletter'], async (req, res) => {
  const ts = nowISO();
  try {
    if (!SECRET) {
      console.error(`${LOG_PREFIX} ❌ falta MKT_SEND_SECRET`);
      return res.status(500).json({ ok: false, error: 'MKT_SEND_SECRET missing' });
    }

    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      return res.status(415).json({ ok:false, error:'UNSUPPORTED_MEDIA_TYPE' });
    }

    const v = verifyHmac(req);
    if (!v.ok) {
      const tsRaw = String(req.headers['x-lb-ts'] || '');
      const sig   = String(req.headers['x-lb-sig'] || '');
      const hasRaw = Buffer.isBuffer(req.rawBody);
      const bodyHash12 = (v.bodyHash || '').slice(0,12);
      console.warn('[marketing/send] ⛔ BAD_HMAC · ts=%s · sig=%s… · hasRaw=%s · sha256(body)=%s · err=%s',
        tsRaw, sig.slice(0,12), hasRaw, bodyHash12, v.error);
      return res.status(401).json({ ok: false, error: 'BAD_HMAC' });
    } else if (process.env.LAB_DEBUG === '1') {
      console.log('[marketing/send] ✅ HMAC ok (%s) · sha256(body)=%s', v.variant, (v.bodyHash||'').slice(0,12));
    }

    const subject = s(req.body?.subject).trim();
    const html = s(req.body?.html).trim();
    const scheduledAt = s(req.body?.scheduledAt);
    const materias = (req.body && typeof req.body === 'object' && req.body.materias) ? req.body.materias : {};
    const testOnly = !!req.body?.testOnly;

    if (!subject) return res.status(400).json({ ok: false, error: 'SUBJECT_REQUIRED' });
    if (!html) return res.status(400).json({ ok: false, error: 'HTML_REQUIRED' });

    // Normaliza materias válidas
    const allowedKeys = ['derechos','cotizaciones','desempleo','bajas_ip','jubilacion','ahorro_privado','otras_prestaciones'];
    const materiasNorm = {};
    let anyMateria = false;
    for (const k of allowedKeys) {
      const vv = !!(materias && materias[k]);
      materiasNorm[k] = vv;
      if (vv) anyMateria = true;
    }
    if (!testOnly && !anyMateria) {
      return res.status(400).json({ ok: false, error: 'MATERIAS_REQUIRED' });
    }

    const job = {
      subject,
      html,
      materias: materiasNorm,
      testOnly,
      createdAt: admin.firestore.Timestamp.fromDate(new Date()),
      createdAtISO: ts,
      status: 'pending'
    };

    if (scheduledAt) {
      const when = new Date(scheduledAt);
      if (isNaN(when.getTime())) {
        return res.status(400).json({ ok:false, error:'SCHEDULED_AT_INVALID' });
      }
      job.scheduledAt = admin.firestore.Timestamp.fromDate(when);
      job.scheduledAtISO = when.toISOString();
      const ref = await db.collection('emailQueue').add(job);
      return res.json({ ok: true, scheduled: true, queueId: ref.id });
    }

    // Envío inmediato
    let recipients = [];
    if (testOnly) {
      recipients = ['ignacio.solsona@icacs.com', 'laboroteca@gmail.com'];
    } else {
      const snap = await db.collection('marketingConsents')
        .where('consent_marketing', '==', true)
        .get();

      const set = new Set();
      snap.forEach(doc => {
        const d = doc.data() || {};
        let match = false;
        for (const k of Object.keys(materiasNorm)) {
          if (materiasNorm[k] && d.materias?.[k]) { match = true; break; }
        }
        if (match && d.email && typeof d.email === 'string' && d.email.includes('@')) {
          set.add(d.email.toLowerCase());
        }
      });

      const supSnap = await db.collection('suppressionList').get();
      const sup = new Set(supSnap.docs.map(d => (d.id || '').toLowerCase()));
      recipients = Array.from(set).filter(e => !sup.has(e));
    }

    if (!testOnly && recipients.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, note: 'NO_RECIPIENTS' });
    }

    // Envío en chunks
    let sent = 0;
    const CHUNK = 80;
    for (let i = 0; i < recipients.length; i += CHUNK) {
      const slice = recipients.slice(i, i + CHUNK);
      try {
        await sendSMTP2GO({ to: slice, subject, html });
        sent += slice.length;
      } catch (e) {
        console.error(`${LOG_PREFIX} ❌ SMTP2GO:`, e?.message || e);
        try { await alertAdmin({ area:'newsletter_send_fail', err: e, meta:{ subject, testOnly } }); } catch {}
        return res.status(500).json({ ok: false, error: 'SEND_FAIL' });
      }
    }

    try {
      await db.collection('emailSends').add({
        subject, html, materias: materiasNorm, testOnly,
        recipients, count: sent,
        createdAt: admin.firestore.Timestamp.fromDate(new Date()),
        createdAtISO: ts
      });
    } catch (e) {
      console.warn(`${LOG_PREFIX} ⚠️ log emailSends`, e?.message || e);
    }

    return res.json({ ok: true, sent });
  } catch (e) {
    console.error(`${LOG_PREFIX} ❌ error:`, e?.message || e);
    try { await alertAdmin({ area:'newsletter_send_unexpected', err: e, meta:{} }); } catch {}
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

module.exports = router;
