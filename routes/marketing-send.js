// routes/marketing-send.js
// ──────────────────────────────────────────────────────────────
// Endpoint seguro para enviar / programar newsletters.
// POST /marketing/send
//   Headers: x-lb-ts, x-lb-sig  (HMAC sha256 con MKT_SEND_SECRET)
//   Body: { subject, html, materias:{...}, scheduledAt?, testOnly? }
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
const SECRET = process.env.MKT_SEND_SECRET || '';
const HMAC_WINDOW_MS = 5 * 60 * 1000; // ±5 min
const FROM_EMAIL = process.env.EMAIL_FROM || 'newsletter@laboroteca.es';
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'Laboroteca Newsletter';
const SMTP2GO_API_KEY = process.env.SMTP2GO_API_KEY || '';

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
  const s = String(str).replace(/-/g,'+').replace(/_/g,'/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  return Buffer.from(s + pad, 'base64');
}
function verifyHmac(req) {
  const tsRaw = s(req.headers['x-lb-ts']);
  const sig   = s(req.headers['x-lb-sig']);
  if (!tsRaw || !sig || !SECRET) return false;

  // ventana temporal
  const tsNum = Number(tsRaw);
  const tsMs  = tsNum > 1e11 ? tsNum : tsNum * 1000;
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() - tsMs) > HMAC_WINDOW_MS) return false;

  // 🚫 Obligamos a usar EXACTAMENTE los bytes recibidos (wp_json_encode)
  if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length === 0) return false;

  // HMAC binario sobre "ts.rawBody"
  const macBin = crypto.createHmac('sha256', SECRET)
    .update(String(tsRaw)).update('.').update(req.rawBody).digest();

  // Admitimos firma en hex o en base64/base64url
  if (/^[0-9a-f]{64}$/i.test(sig)) {
    const macHex = Buffer.from(macBin.toString('hex'), 'utf8');
    return timingEq(Buffer.from(sig, 'utf8'), macHex);
  }
  try {
    const sigBin = b64urlToBuf(sig);
    return timingEq(sigBin, macBin);
  } catch {
    return false;
  }
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

  const data = await res.json();
  if (!res.ok || data.data?.succeeded?.length === 0) {
    throw new Error(`SMTP2GO send failed: ${JSON.stringify(data)}`);
  }
  return data;
}

// ───────── Ruta principal ─────────
// Alias: aceptamos /send y /send-newsletter para el panel WP
router.post(['/send', '/send-newsletter'], async (req, res) => {
  const ts = nowISO();
  try {
    if (!SECRET) return res.status(500).json({ ok: false, error: 'MKT_SEND_SECRET missing' });
    if (!verifyHmac(req)) {
      const tsRaw = String(req.headers['x-lb-ts'] || '');
      const sig   = String(req.headers['x-lb-sig'] || '');
      const hasRaw = Buffer.isBuffer(req.rawBody);
      let bodyHash = 'no-raw';
      try {
        if (hasRaw) {
          bodyHash = require('crypto').createHash('sha256').update(req.rawBody).digest('hex').slice(0,12);
        }
      } catch(_) {}
      console.warn('⛔ BAD_HMAC send-newsletter · ts=%s · sig=%s… · hasRaw=%s · sha256(raw)=%s',
        tsRaw, sig.slice(0,12), hasRaw, bodyHash);
      return res.status(401).json({ ok: false, error: 'BAD_HMAC' });
    }

    const subject = s(req.body?.subject).trim();
    const html = s(req.body?.html).trim();
    const scheduledAt = s(req.body?.scheduledAt);
    const materias = req.body?.materias || {};
    const testOnly = !!req.body?.testOnly;

    if (!subject) return res.status(400).json({ ok: false, error: 'SUBJECT_REQUIRED' });
    if (!html) return res.status(400).json({ ok: false, error: 'HTML_REQUIRED' });
    if (!testOnly && !Object.values(materias).some(Boolean)) {
      return res.status(400).json({ ok: false, error: 'MATERIAS_REQUIRED' });
    }

    const job = {
      subject,
      html,
      materias,
      testOnly,
      createdAt: admin.firestore.Timestamp.fromDate(new Date()),
      createdAtISO: ts,
      status: 'pending'
    };

    if (scheduledAt) {
      // Programar → guardar en emailQueue
      job.scheduledAt = admin.firestore.Timestamp.fromDate(new Date(scheduledAt));
      job.scheduledAtISO = scheduledAt;
      const ref = await db.collection('emailQueue').add(job);
      return res.json({ ok: true, scheduled: true, queueId: ref.id });
    } else {
      // Inmediato
      let recipients = [];
      if (testOnly) {
        recipients = ['ignacio.solsona@icacs.com', 'laboroteca@gmail.com'];
      } else {
        // Buscar destinatarios reales
        const snap = await db.collection('marketingConsents')
          .where('consent_marketing', '==', true)
          .get();

        snap.forEach(doc => {
          const d = doc.data() || {};
          let match = false;
          for (const k of Object.keys(materias)) {
            if (materias[k] && d.materias?.[k]) { match = true; break; }
          }
          if (match) recipients.push(d.email);
        });

        // Filtrar suppressionList
        const supSnap = await db.collection('suppressionList').get();
        const sup = new Set(supSnap.docs.map(d => (d.id || '').toLowerCase()));
        recipients = recipients.filter(e => !sup.has(e.toLowerCase()));
      }

      // Enviar
      let sent = 0;
      // Enviar (chunk simple para no exceder SMTP2GO)
      const CHUNK = 80;
      for (let i = 0; i < recipients.length; i += CHUNK) {
        const slice = recipients.slice(i, i + CHUNK);
        try {
          await sendSMTP2GO({ to: slice, subject, html });
          sent += slice.length;
        } catch (e) {
          console.error('❌ sendSMTP2GO error:', e?.message || e);
          try { await alertAdmin({ area:'newsletter_send_fail', err: e, meta:{ subject, testOnly } }); } catch {}
          return res.status(500).json({ ok: false, error: 'SEND_FAIL' });
        }
      }

      // Log en emailSends
      await db.collection('emailSends').add({
        subject, html, materias, testOnly,
        recipients, count: sent,
        createdAt: admin.firestore.Timestamp.fromDate(new Date()),
        createdAtISO: ts
      });

      return res.json({ ok: true, sent });
    }
  } catch (e) {
    console.error('❌ marketing/send error:', e?.message || e);
    try { await alertAdmin({ area:'newsletter_send_unexpected', err: e, meta:{} }); } catch {}
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

module.exports = router;
