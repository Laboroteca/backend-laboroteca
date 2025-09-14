// routes/marketing-send.js
// ──────────────────────────────────────────────────────────────
// Endpoint seguro para enviar / programar newsletters.
// Ruta montada como:  /marketing/send   (alias: /marketing/send-newsletter)
//
// Autenticación: SOLO HMAC
//   Headers: X-Lb-Ts / X-Lb-Sig  (compat: X-Lab-Ts / X-Lab-Sig)
//   Firmas aceptadas (retrocompatible):
//     v0  : HMAC(ts + "." + rawBody)                         (hex/base64url)
//     v1  : HMAC(ts + "." + sha256(body))                    (hex/base64url)
//     v1u : HMAC(ts + "." + sha256(body_unescaped_slashes))  (tolera \/ ↔ /)
//     v2  : HMAC(ts + ".POST." + path + "." + sha256(body))  (con/sin slash final)
//
// Body JSON:
//   { subject, html, materias:{...}, scheduledAt?, testOnly? }
//
// - testOnly: envío solo a la lista restringida
// - scheduledAt vacío = envío inmediato
// - Firestore: registra en emailQueue (si programado) o emailSends (si inmediato)
// - Respeta suppressionList y segmentación por materias
// - Usa SMTP2GO API
// - SIEMPRE añade pie legal + enlace de baja con token único
// - Idempotencia:
//     · Programados: dedupe de job por hash de contenido+fecha (docId determinista)
//     · Inmediatos: dedupe por campaña+destinatario (reserva "create" antes de enviar)
// ──────────────────────────────────────────────────────────────

'use strict';

const express = require('express');
const crypto  = require('crypto');
const admin   = require('firebase-admin');
const fetch   = require('node-fetch');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const router = express.Router();

// ───────── CONFIG ─────────
// Secreto HMAC (coherente con WP)
const SECRET = String(process.env.MKT_SEND_HMAC_SECRET || process.env.MKT_SEND_SECRET || '').trim();
// Ventana de tiempo (por defecto 300s). Permite override con LAB_HMAC_SKEW_SECS (en segundos)
const SKEW_SECS = Number(process.env.LAB_HMAC_SKEW_SECS || 300);
const HMAC_WINDOW_MS = (Number.isFinite(SKEW_SECS) && SKEW_SECS >= 0 ? SKEW_SECS : 300) * 1000;

// Remitente / SMTP
const FROM_EMAIL = process.env.EMAIL_FROM || process.env.SMTP2GO_FROM_EMAIL || 'newsletter@laboroteca.es';
const FROM_NAME  = process.env.EMAIL_FROM_NAME || process.env.SMTP2GO_FROM_NAME || 'Laboroteca Newsletter';
const SMTP2GO_API_KEY = String(process.env.SMTP2GO_API_KEY || '').trim();
const SMTP2GO_API_URL = String(process.env.SMTP2GO_API_URL || 'https://api.smtp2go.com/v3/email/send');

// Baja obligatoria
const UNSUB_SECRET = String(process.env.MKT_UNSUB_SECRET || 'laboroteca-unsub').trim();
const UNSUB_PAGE   = String(process.env.MKT_UNSUB_PAGE || 'https://www.laboroteca.es/baja-newsletter/').trim();

// Rate opcional para inmediatos (ms entre emails)
const SEND_RATE_DELAY_MS = Number(process.env.SEND_RATE_DELAY_MS || 0);

const LOG_PREFIX = '[marketing/send]';
const LAB_DEBUG  = process.env.LAB_DEBUG === '1';

// Firebase
if (!admin.apps.length) { try { admin.initializeApp(); } catch (_) {} }
const db = admin.firestore();

// ───────── Helpers ─────────
const s = v => (v === undefined || v === null) ? '' : String(v);
const nowISO = () => new Date().toISOString();
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));
const sha256 = (str) => crypto.createHash('sha256').update(String(str||''), 'utf8').digest('hex');
const sha256Buf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function timingEq(a, b) {
  try { return a.length === b.length && crypto.timingSafeEqual(a, b); }
  catch { return false; }
}

function b64urlToBuf(str) {
  const ss = String(str).replace(/-/g,'+').replace(/_/g,'/');
  const pad = ss.length % 4 ? '='.repeat(4 - (ss.length % 4)) : '';
  return Buffer.from(ss + pad, 'base64');
}

// normaliza path, quita query/hash y barra final (salvo raíz)
function normalizePath(p) {
  try {
    p = (p || '/').toString().split('#')[0].split('?')[0];
    if (p[0] !== '/') p = '/' + p;
    p = p.replace(/\/{2,}/g, '/');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  } catch { return '/'; }
}
function withVariants(path) {
  const base = normalizePath(path);
  return base === '/' ? ['/'] : [base, base + '/'];
}

// 🔎 Huella del secreto (solo debug; no expone el valor)
if (LAB_DEBUG) {
  try {
    const sh = SECRET ? crypto.createHash('sha256').update(SECRET, 'utf8').digest('hex') : '';
    console.warn('%s 🪪 hmac_secret_len=%d hmac_sha=%s skew_s=%d',
      LOG_PREFIX, SECRET.length, sh ? sh.slice(0,12) : '-', HMAC_WINDOW_MS/1000);
  } catch (_) {}
}

/**
 * Verifica HMAC aceptando variantes v0/v1/v1u/v2.
 */
function verifyHmac(req) {
  const tsRaw = s(
    req.headers['x-lb-ts']  || req.headers['x_lb_ts']  ||
    req.headers['x-lab-ts'] || req.headers['x_lab_ts']
  );
  const sig = s(
    req.headers['x-lb-sig']  || req.headers['x_lb_sig']  ||
    req.headers['x-lab-sig'] || req.headers['x_lab_sig']
  );
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

  const raw = req.rawBody;
  const rawStr = raw.toString('utf8');
  const rawUnesc = Buffer.from(rawStr.replace(/\\\//g, '/'), 'utf8'); // tolerancia JSON_UNESCAPED_SLASHES

  // Helpers de variantes binarias
  const withBOM = buf => Buffer.concat([Buffer.from([0xEF,0xBB,0xBF]), buf]);
  const withoutBOM = buf => (buf[0]===0xEF && buf[1]===0xBB && buf[2]===0xBF) ? buf.slice(3) : buf;
  const dropTail = (buf, byte) => (buf.length && buf[buf.length-1]===byte) ? buf.slice(0, -1) : buf;

  // Candidatos de cuerpo binario a probar en v0/v0u
  const binVariantsSet = new Map(); // key hex->Buffer para de-dupe
  const pushVar = b => { const k = b.toString('hex'); if (!binVariantsSet.has(k)) binVariantsSet.set(k, b); };

  const bases = [raw, rawUnesc];
  for (const base of bases) {
    pushVar(base);
    pushVar(Buffer.concat([base, Buffer.from('\n')]));   // + \n
    pushVar(Buffer.concat([base, Buffer.from('\r\n')])); // + \r\n
    pushVar(dropTail(base, 0x0A)); // sin \n
    pushVar(dropTail(base, 0x0D)); // sin \r
    pushVar(withoutBOM(base));
    pushVar(withBOM(base));
  }
  const binVariants = Array.from(binVariantsSet.values());

  // Hashes v1
  const bodyHashRaw  = sha256Buf(raw);
  const bodyHashUnes = sha256Buf(rawUnesc);

  // posibles paths firmables (con/sin slash final, alias)
  const paths = Array.from(new Set([
    ...withVariants((req.baseUrl || '') + (req.path || '')),
    ...withVariants((req.originalUrl || '').split('?')[0]),
    ...withVariants('/marketing/send'),
    ...withVariants('/marketing/send-newsletter'),
    ...withVariants('/send'),
    ...withVariants('/send-newsletter'),
  ]));

  const mk = (tsStr, bufOrHex, isBin) =>
    isBin
      ? crypto.createHmac('sha256', SECRET).update(tsStr).update('.').update(bufOrHex).digest()
      : crypto.createHmac('sha256', SECRET).update(`${tsStr}.${bufOrHex}`).digest('hex');

  const candidates = [];
  // v0/v0u
  for (const b of binVariants) {
    candidates.push({ label:'v0_raw_s',  bin: mk(tsSecStr, b, true) });
    candidates.push({ label:'v0_raw_ms', bin: mk(tsMsStr,  b, true) });
  }

  // v1
  candidates.push({ label:'v1_hash_s',  hex: mk(tsSecStr, bodyHashRaw, false) });
  candidates.push({ label:'v1_hash_ms', hex: mk(tsMsStr,  bodyHashRaw, false) });
  // v1u
  candidates.push({ label:'v1u_hash_s',  hex: mk(tsSecStr, bodyHashUnes, false) });
  candidates.push({ label:'v1u_hash_ms', hex: mk(tsMsStr,  bodyHashUnes, false) });

  // v2
  for (const p of paths) {
    const np = normalizePath(p);
    const baseS  = `${tsSecStr}.POST.${np}.${bodyHashRaw}`;
    const baseMs = `${tsMsStr}.POST.${np}.${bodyHashRaw}`;
    candidates.push({ label:`v2_${np}_s`,  hex: crypto.createHmac('sha256', SECRET).update(baseS ).digest('hex') });
    candidates.push({ label:`v2_${np}_ms`, hex: crypto.createHmac('sha256', SECRET).update(baseMs).digest('hex') });

    // también con el hash de "unescaped"
    const baseS2  = `${tsSecStr}.POST.${np}.${bodyHashUnes}`;
    const baseMs2 = `${tsMsStr}.POST.${np}.${bodyHashUnes}`;
    candidates.push({ label:`v2u_${np}_s`,  hex: crypto.createHmac('sha256', SECRET).update(baseS2 ).digest('hex') });
    candidates.push({ label:`v2u_${np}_ms`, hex: crypto.createHmac('sha256', SECRET).update(baseMs2).digest('hex') });
  }

  // Comparación
  const isHex = /^[0-9a-f]{64}$/i.test(sig);
  if (isHex) {
    try {
      const sigHexBuf = Buffer.from(sig, 'hex'); // firma recibida → binario
      for (const c of candidates) {
        const expBin = c.bin ? c.bin : (c.hex ? Buffer.from(c.hex, 'hex') : null);
        if (expBin && timingEq(sigHexBuf, expBin)) {
          return { ok:true, variant:c.label, bodyHash:bodyHashRaw };
        }
      }
    } catch { /* probaremos base64url abajo */ }
  }
  try {
    const sigBin = b64urlToBuf(sig); // por si la envían en base64url
    for (const c of candidates) {
      const expBin = c.bin ? c.bin : (c.hex ? Buffer.from(c.hex, 'hex') : null);
      if (expBin && timingEq(sigBin, expBin)) {
        return { ok:true, variant:c.label, bodyHash:bodyHashRaw };
      }
    }
  } catch {
    return { ok:false, error:'bad_sig_format', bodyHash:bodyHashRaw };
  }

  return { ok:false, error:'no_variant_match', bodyHash:bodyHashRaw };
}

// ── Baja por token
function makeUnsubToken(email) {
  const ts = Math.floor(Date.now()/1000);
  const base = `${String(email||'').toLowerCase()}.${ts}`;
  const sig  = crypto.createHmac('sha256', UNSUB_SECRET).update(base).digest('hex').slice(0,32);
  const payload = Buffer.from(base).toString('base64url');
  return `${payload}.${sig}`;
}

// Pie legal + bloque de baja (siempre se añade)
function buildLegalFooter({ email }) {
  const token = makeUnsubToken(email);
  const unsubUrl = `${UNSUB_PAGE}${UNSUB_PAGE.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

  const unsubBlock = `
    <hr style="margin-top:32px;margin-bottom:12px" />
    <p style="font-size:13px;color:#555;line-height:1.5">
      Para dejar de recibir esta newsletter, puedes darte de baja desde
      <a href="${unsubUrl}" target="_blank" rel="noopener">este enlace seguro</a>.
    </p>
  `;

  const legalBlock = `
    <div style="font-size:12px;color:#777;line-height:1.5">
      En cumplimiento del Reglamento (UE) 2016/679 (RGPD) y la LOPDGDD, le informamos de que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera (DNI 20481042W), con domicilio en calle Enmedio nº 22, 3.º E, 12001 Castellón de la Plana (España).<br /><br />
      Finalidades: prestación de servicios jurídicos, venta de infoproductos, gestión de entradas a eventos, emisión y envío de facturas por email y, en su caso, envío de newsletter y comunicaciones comerciales si usted lo ha consentido. Base jurídica: ejecución de contrato y/o consentimiento. Puede retirar su consentimiento en cualquier momento.<br /><br />
      Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición escribiendo a
      <a href="mailto:laboroteca@gmail.com">laboroteca@gmail.com</a>. También puede presentar una reclamación ante la autoridad de control competente. Más información en nuestra política de privacidad:
      <a href="https://www.laboroteca.es/politica-de-privacidad/" target="_blank" rel="noopener">https://www.laboroteca.es/politica-de-privacidad/</a>.
    </div>
  `;

  return { unsubUrl, html: `${unsubBlock}${legalBlock}` };
}

async function sendSMTP2GO({ to, subject, html, headers = [] }) {
  if (!SMTP2GO_API_KEY) throw new Error('SMTP2GO_API_KEY missing');

  const payload = {
    api_key: SMTP2GO_API_KEY,
    to: Array.isArray(to) ? to : [to],
    sender: `${FROM_NAME} <${FROM_EMAIL}>`,
    subject,
    html_body: html
  };

  if (headers && headers.length) {
    payload.custom_headers = headers.map(({ header, value }) => ({ header, value }));
  }

  const res = await fetch(SMTP2GO_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));

  // SMTP2GO devuelve { data: { succeeded: number|[], failed: number, failures: [], email_id: string } }
  const failuresLen  = Array.isArray(data?.data?.failures) ? data.data.failures.length : 0;
  const succeededNum = typeof data?.data?.succeeded === 'number' ? data.data.succeeded : NaN;
  const succeededArr = Array.isArray(data?.data?.succeeded) ? data.data.succeeded : null;
  const hasSucceeded = (Number.isFinite(succeededNum) && succeededNum > 0) ||
                       (Array.isArray(succeededArr) && succeededArr.length > 0);
  const hasEmailId   = Boolean(data?.data?.email_id);

  if (res.ok && failuresLen === 0 && (hasSucceeded || hasEmailId)) {
    if (LAB_DEBUG) {
      console.log('%s 📬 SMTP2GO OK: succeeded=%s email_id=%s',
        LOG_PREFIX, (Number.isFinite(succeededNum) ? succeededNum : (succeededArr ? succeededArr.length : '-')),
        data?.data?.email_id || '-'
      );
    }
    return data;
  }

  throw new Error(`SMTP2GO send failed: ${JSON.stringify(data).slice(0,400)}`);
}

// ───────── Ruta principal ─────────
router.post(['/send', '/send-newsletter'], async (req, res) => {
  const ts = nowISO();
  try {
    if (!SECRET) {
      console.error(`${LOG_PREFIX} ❌ falta MKT_SEND_HMAC_SECRET`);
      return res.status(500).json({ ok: false, error: 'MKT_SEND_HMAC_SECRET missing' });
    }

    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.startsWith('application/json')) {
      return res.status(415).json({ ok:false, error:'UNSUPPORTED_MEDIA_TYPE' });
    }

    // HMAC obligatorio (único modo)
    const v = verifyHmac(req);
    if (!v.ok) {
      const tsRaw = String(req.headers['x-lb-ts'] || req.headers['x-lab-ts'] || '');
      const sig   = String(req.headers['x-lb-sig'] || req.headers['x-lab-sig'] || '');
      const hasRaw = Buffer.isBuffer(req.rawBody);
      const bodyHash12 = (v.bodyHash || '').slice(0,12);

      if (LAB_DEBUG && hasRaw && SECRET) {
        try {
          const tsNum = Number(tsRaw);
          const tsMs  = Number.isFinite(tsNum) ? (tsNum > 1e11 ? tsNum : tsNum*1000) : Date.now();
          const tsS   = String(Math.floor(tsMs/1000));
          const tsMS  = String(Math.floor(tsMs));
          const body  = req.rawBody;
          const hHex  = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
          const hBin  = (tsStr, buf) => crypto.createHmac('sha256', SECRET).update(tsStr).update('.').update(buf).digest('hex');
          const bHash = sha256Buf(body);
          const bHashU= sha256(String(body.toString('utf8').replace(/\\\//g,'/')));
          const path  = (req.originalUrl||req.url||'/').split('?')[0];
          const norm  = (p)=>{ p=String(p).split('#')[0].split('?')[0]; if(p[0]!=='/')p='/'+p; p=p.replace(/\/{2,}/g,'/'); return p.length>1&&p.endsWith('/')?p.slice(0,-1):p; };
          const p1 = norm(path), p2 = p1 === '/' ? '/' : p1 + '/';

          const exp = {
            v0_s   : hBin(tsS,  body).slice(0,12),
            v0_ms  : hBin(tsMS, body).slice(0,12),
            v1_s   : hHex(`${tsS}.${bHash}`).slice(0,12),
            v1_ms  : hHex(`${tsMS}.${bHash}`).slice(0,12),
            v1u_s  : hHex(`${tsS}.${bHashU}`).slice(0,12),
            v1u_ms : hHex(`${tsMS}.${bHashU}`).slice(0,12),
            v2_s   : hHex(`${tsS}.POST.${p1}.${bHash}`).slice(0,12),
            v2_ms  : hHex(`${tsMS}.POST.${p1}.${bHash}`).slice(0,12),
            v2s_s  : hHex(`${tsS}.POST.${p2}.${bHash}`).slice(0,12),
            v2s_ms : hHex(`${tsMS}.POST.${p2}.${bHash}`).slice(0,12),
            v2u_s  : hHex(`${tsS}.POST.${p1}.${bHashU}`).slice(0,12),
            v2u_ms : hHex(`${tsMS}.POST.${p1}.${bHashU}`).slice(0,12),
            v2us_s : hHex(`${tsS}.POST.${p2}.${bHashU}`).slice(0,12),
            v2us_ms: hHex(`${tsMS}.POST.${p2}.${bHashU}`).slice(0,12),
          };

          res.setHeader('X-Debug-BodySHA', (bHash||'').slice(0,64));
          res.setHeader('X-Debug-TsS', tsS);
          res.setHeader('X-Debug-TsMS', tsMS);
          res.setHeader('X-Debug-Expected', Object.entries(exp).map(([k,v])=>`${k}=${v}`).join(','));
          console.warn('%s ⛔ BAD_HMAC · ts=%s · sig=%s… · hasRaw=%s · body=%s · err=%s',
            LOG_PREFIX, tsRaw, sig.slice(0,12), hasRaw, (bHash||'').slice(0,12), v.error);
        } catch(e) {
          console.warn('%s debug calc err: %s', LOG_PREFIX, e?.message || e);
        }
      } else {
        console.warn('%s ⛔ BAD_HMAC · ts=%s · sig=%s… · hasRaw=%s · sha256(body)=%s · err=%s',
          LOG_PREFIX, tsRaw, sig.slice(0,12), hasRaw, bodyHash12, v.error);
      }
      return res.status(401).json({ ok: false, error: 'BAD_HMAC' });
    } else if (LAB_DEBUG) {
      try {
        res.setHeader('X-HMAC-Variant', v.variant);
        res.setHeader('X-Body-SHA256', (v.bodyHash||'').slice(0,64));
      } catch {}
      console.log('%s ✅ HMAC ok (%s) · sha256(body)=%s', LOG_PREFIX, v.variant, (v.bodyHash||'').slice(0,12));
    }

    // -------- Validación de payload --------
    const subject = s(req.body?.subject).trim();
    const htmlBase = s(req.body?.html).trim();
    const scheduledAt = s(req.body?.scheduledAt);
    const materias = (req.body && typeof req.body === 'object' && req.body.materias) ? req.body.materias : {};
    const testOnly = !!req.body?.testOnly;

    if (!subject)  return res.status(400).json({ ok: false, error: 'SUBJECT_REQUIRED' });
    if (!htmlBase) return res.status(400).json({ ok: false, error: 'HTML_REQUIRED' });

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

    // ───────── Programado → cola (job idempotente con docId determinista) ─────────
    if (scheduledAt) {
      const when = new Date(scheduledAt);
      if (isNaN(when.getTime())) {
        return res.status(400).json({ ok:false, error:'SCHEDULED_AT_INVALID' });
      }

      const jobPayload = {
        subject,
        html: htmlBase, // el worker añadirá pie+unsub al enviar
        materias: materiasNorm,
        testOnly,
        createdAt: admin.firestore.Timestamp.fromDate(new Date()),
        createdAtISO: ts,
        status: 'pending',
        authVariant: 'hmac',
        needsFooter: true,
        scheduledAt: admin.firestore.Timestamp.fromDate(when),
        scheduledAtISO: when.toISOString()
      };

      // Idempotencia de job: docId = sha256(subject|html|materias|testOnly|scheduledAtISO)
      const jobId = 'job:' + sha256(JSON.stringify({
        subject,
        bodyHash: sha256(htmlBase),
        materias: materiasNorm,
        testOnly: !!testOnly,
        scheduledAtISO: jobPayload.scheduledAtISO
      }));

      const ref = db.collection('emailQueue').doc(jobId);
      const exists = await ref.get().then(s=>s.exists);
      if (exists) {
        return res.json({ ok:true, scheduled:true, queueId: jobId, dedup:true });
      }
      await ref.set(jobPayload, { merge: false });
      return res.json({ ok:true, scheduled:true, queueId: jobId });
    }

    // ───────── Inmediato (idempotente por campaña+destinatario) ─────────
    // Destinatarios
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

    // Clave de campaña estable
    const campaignKey = sha256(JSON.stringify({
      subject,
      bodyHash: sha256(htmlBase),
      materias: materiasNorm,
      testOnly: !!testOnly,
      scheduledAt: '' // inmediato
    }));

    // Envío INDIVIDUAL con dedupe (reserva "create" antes de enviar)
    let sent = 0, skipped = 0, failed = 0;
    for (const rcptRaw of recipients) {
      const rcpt = String(rcptRaw||'').toLowerCase();
      const dedupId = `immediate:${campaignKey}:${sha256(rcpt)}`;
      const dedupRef = db.collection('emailSendDedup').doc(dedupId);

      // Reserva atómica: si existe → ya enviado/reservado
      try {
        await dedupRef.create({
          mode: 'immediate',
          status: 'pending',
          campaignKey,
          email: rcpt,
          subjectHash: sha256(subject),
          bodyHash: sha256(htmlBase),
          createdAt: admin.firestore.Timestamp.fromDate(new Date()),
          createdAtISO: nowISO()
        });
      } catch (e) {
        // ya existe → saltamos
        skipped++;
        continue;
      }

      try {
        const { unsubUrl, html: footerHtml } = buildLegalFooter({ email: rcpt });

        // Header List-Unsubscribe (mejora deliverability)
        const headers = [
          { header: 'List-Unsubscribe',      value: `<${unsubUrl}>` },
          { header: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' }
        ];

        const finalHtml = `${htmlBase}${footerHtml}`;
        await sendSMTP2GO({ to: rcpt, subject, html: finalHtml, headers });

        await dedupRef.set({
          status: 'sent',
          sentAt: admin.firestore.Timestamp.fromDate(new Date()),
          sentAtISO: nowISO()
        }, { merge: true });

        sent++;
        if (SEND_RATE_DELAY_MS > 0) await sleep(SEND_RATE_DELAY_MS);
      } catch (e) {
        failed++;
        // liberar la reserva para permitir reintento futuro
        try { await dedupRef.delete(); } catch (_) {}
        console.error(`${LOG_PREFIX} ❌ SMTP2GO (${rcpt}):`, e?.message || e);
        try { await alertAdmin({ area:'newsletter_send_fail', err: e, meta:{ subject, testOnly, rcpt } }); } catch {}
      }
    }

    try {
      await db.collection('emailSends').add({
        subject, html: htmlBase, materias: materiasNorm, testOnly,
        recipients, count: sent, skipped, failed,
        createdAt: admin.firestore.Timestamp.fromDate(new Date()),
        createdAtISO: ts,
        authVariant: 'hmac',
        needsFooter: true,
        campaignKey
      });
    } catch (e) {
      console.warn(`${LOG_PREFIX} ⚠️ log emailSends`, e?.message || e);
    }

    return res.json({ ok: true, sent, skipped, failed });
  } catch (e) {
    console.error(`${LOG_PREFIX} ❌ error:`, e?.message || e);
    try { await alertAdmin({ area:'newsletter_send_unexpected', err: e, meta:{} }); } catch {}
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR' });
  }
});

module.exports = router;

