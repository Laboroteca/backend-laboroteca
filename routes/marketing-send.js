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

/**
 * Verifica HMAC del panel WP:
 *   firma = HMAC_SHA256( ts + "." + body_crudo )
 * Acepta firma en hex (64 chars) o base64/url.
 * Considera dos candidatos de cuerpo:
 *   A) raw tal cual (wp_json_encode)
 *   B) raw con slashes des-escapados (JSON_UNESCAPED_SLASHES)
 */
function verifyHmac(req) {
  const tsRaw = s(req.headers['x-lb-ts']);
  const sig   = s(req.headers['x-lb-sig']);
  if (!tsRaw || !sig || !SECRET) return false;

  // Ventana temporal
  const tsNum = Number(tsRaw);
  const tsMs  = tsNum > 1e11 ? tsNum : tsNum * 1000;
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(Date.now() - tsMs) > HMAC_WINDOW_MS) return false;

  // Debe existir rawBody (capturado en index.js con express.json({ verify }))
  if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length === 0) return false;

  // Candidatos de cuerpo
  const candidates = [ req.rawBody ];
  try {
    const unescaped = Buffer.from(
      req.rawBody.toString('utf8').replace(/\\\//g, '/'),
      'utf8'
    );
    if (!unescaped.equals(req.rawBody)) candidates.push(unescaped);
  } catch (_) {}

  const isHex = /^[0-9a-f]{64}$/i.test(sig);

  for (const raw of candidates) {
    const macBin = crypto.createHmac('sha256', SECRET)
      .update(String(tsRaw)).update('.').update(raw).digest();

    if (isHex) {
      const macHex = Buffer.from(macBin.toString('hex'), 'utf8');
      if (timingEq(Buffer.from(sig, 'utf8'), macHex)) return true;
    } else {
      try {
        const sigBin = b64urlToBuf(sig);
        if (timingEq(sigBin, macBin)) return true;
      } catch { /* ignore */ }
    }
  }
  return false;
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
// Alias: aceptamos /send y /send-newsletter para el panel WP
router.post(['/send', '/send-newsletter'], async (req, res) => {
  const ts = nowISO();
  try {
    if (!SECRET) {
      console.error(`${LOG_PREFIX} ❌ falta MKT_SEND_SECRET`);
      return res.status(500).json({ ok: false, error: 'MKT_SEND_SECRET missing' });
    }

    // Content-Type debe ser JSON
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      return res.status(415).json({ ok:false, error:'UNSUPPORTED_MEDIA_TYPE' });
    }

    if (!verifyHmac(req)) {
      const tsRaw = String(req.headers['x-lb-ts'] || '');
      const sig   = String(req.headers['x-lb-sig'] || '');
      const hasRaw = Buffer.isBuffer(req.rawBody);
      let rawHash = 'no-raw', rawUnescHash = '-';
      try {
        if (hasRaw) {
          const c = require('crypto');
          rawHash = c.createHash('sha256').update(req.rawBody).digest('hex').slice(0,12);
          rawUnescHash = c.createHash('sha256').update(req.rawBody.toString('utf8').replace(/\\\//g,'/'),'utf8').digest('hex').slice(0,12);
        }
      } catch(_) {}
      console.warn(`${LOG_PREFIX} ⛔ BAD_HMAC · ts=%s · sig=%s… · hasRaw=%s · sha256(raw)=%s · sha256(unesc)=%s`,
        tsRaw, sig.slice(0,12), hasRaw, rawHash, rawUnescHash);
      return res.status(401).json({ ok: false, error: 'BAD_HMAC' });
    }

    // Parseamos el JSON ya que la firma usa raw; express.json lo habrá hidratado
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
      const v = !!(materias && materias[k]);
      materiasNorm[k] = v;
      if (v) anyMateria = true;
    }
    if (!testOnly && !anyMateria) {
      return res.status(400).json({ ok: false, error: 'MATERIAS_REQUIRED' });
    }

    // Construye job/base
    const job = {
      subject,
      html,
      materias: materiasNorm,
      testOnly,
      createdAt: admin.firestore.Timestamp.fromDate(new Date()),
      createdAtISO: ts,
      status: 'pending'
    };

    // Programado → cola
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

    // Inmediato
    let recipients = [];
    if (testOnly) {
      recipients = ['ignacio.solsona@icacs.com', 'laboroteca@gmail.com'];
    } else {
      // Buscar consentimientos
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

      // Filtrar suppressionList
      const supSnap = await db.collection('suppressionList').get();
      const sup = new Set(supSnap.docs.map(d => (d.id || '').toLowerCase()));
      recipients = Array.from(set).filter(e => !sup.has(e));
    }

    // Nada que enviar (poco probable, pero mejor responder limpio)
    if (!testOnly && recipients.length === 0) {
      return res.status(200).json({ ok: true, sent: 0, note: 'NO_RECIPIENTS' });
    }

    // Envío por trozos
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

    // Log en emailSends
    try {
      await db.collection('emailSends').add({
        subject, html, materias: materiasNorm, testOnly,
        recipients, count: sent,
        createdAt: admin.firestore.Timestamp.fromDate(new Date()),
        createdAtISO: ts
      });
    } catch (e) {
      // No bloquea la respuesta al cliente
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

