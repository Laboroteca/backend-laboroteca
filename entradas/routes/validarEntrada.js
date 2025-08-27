// entradas/routes/validarEntrada.js
// 🔐 VALIDAR ENTRADA QR – Uso privado
// Acepta POST /validar-entrada y /entradas/validar-entrada
// Seguridad: x-api-key + HMAC (x-val-ts, x-val-sig) sobre ts.POST.<path>.sha256(body)

'use strict';

const express   = require('express');
const crypto    = require('crypto');
const admin     = require('../../firebase');
const firestore = admin.firestore();

const { marcarEntradaComoUsada, SHEETS_EVENTOS } = require('../utils/sheetsEntradas');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

const router = express.Router();

// ====== CONFIG ======
const API_KEY        = (process.env.VALIDADOR_API_KEY || '').trim();
const HMAC_SECRET    = (process.env.VALIDADOR_HMAC_SECRET || '').trim();
const SKEW_MS        = Number(process.env.VALIDADOR_SKEW_MS || 5 * 60 * 1000);  // ±5 min
const REQUIRE_HMAC   = String(process.env.VALIDADOR_REQUIRE_HMAC || '1') === '1';
const LEGACY_TOKEN   = (process.env.VALIDADOR_ENTRADAS_TOKEN || '').trim();     // mejor vacío en prod
const IP_ALLOW       = String(process.env.VALIDADOR_IP_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean);
const RATE_PER_MIN   = Number(process.env.VALIDADOR_RATE_PER_MIN || 60);
const MAX_BODY_BYTES = Number(process.env.VALIDADOR_MAX_BODY || 12 * 1024);
const SHEETS_TIMEOUT = Number(process.env.VALIDADOR_SHEETS_TIMEOUT_MS || 10000);
const AUDIT_SUCCESS  = String(process.env.VALIDADOR_AUDIT_SUCCESS || '1') === '1'; // log de éxito

function maskTail(s){ return s ? `••••${String(s).slice(-4)}` : null; }

// ====== RATE LIMIT (simple por IP / 1 min) ======
const rl = new Map(); // key=ip|YYYY-MM-DDTHH:MM -> count
function clientIp(req){
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.ip || req.connection?.remoteAddress || '';
}
function rateLimit(req){
  const ip = clientIp(req);
  if (!ip) return true;
  const key = ip + '|' + new Date().toISOString().slice(0, 16);
  const count = (rl.get(key) || 0) + 1;
  rl.set(key, count);
  return count <= RATE_PER_MIN;
}

// ====== ANTI-REPLAY (nonce en memoria) ======
const seen = new Map(); // ts.sig → expiresAt
function pruneSeen(){
  const now = Date.now();
  for (const [k, exp] of seen.entries()) if (exp <= now) seen.delete(k);
}

// ====== AUTORIZACIÓN (logs imprescindibles) ======
function verifyAuth(req){
  // 0) Tipo y tamaño
  const ct = String(req.headers['content-type'] || '');
  if (!ct.toLowerCase().startsWith('application/json')) {
    console.warn('[AUTH]', 'Bad Content-Type', { ct, ip: clientIp(req) });
    return { ok:false, code:415, msg:'Content-Type inválido' };
  }

  // rawBody debe venir del app-level express.json({verify})
  let rawStr = (typeof req.rawBody === 'string') ? req.rawBody : '';
  if (!rawStr) { try { rawStr = JSON.stringify(req.body ?? {}); } catch { rawStr = ''; } }
  const rawLen = Buffer.byteLength(rawStr, 'utf8');
  if (rawLen > MAX_BODY_BYTES) {
    console.warn('[AUTH]', 'Payload demasiado grande', { bytes: rawLen, ip: clientIp(req) });
    return { ok:false, code:413, msg:'Payload demasiado grande' };
  }

  // 1) Allowlist por IP (opcional)
  const ip = clientIp(req);
  if (IP_ALLOW.length && !IP_ALLOW.includes(ip)) {
    console.warn('[AUTH]', 'IP no autorizada', { ip });
    return { ok:false, code:401, msg:'IP no autorizada' };
  }

  // 2) Rate limit
  if (!rateLimit(req)) {
    console.warn('[AUTH]', 'Too Many Requests', { ip });
    return { ok:false, code:429, msg:'Too Many Requests' };
  }

  // 3) HMAC headers
  const hdrKey = String(req.headers['x-api-key'] || '').trim();
  const ts     = String(req.headers['x-val-ts'] || req.headers['x-entr-ts'] || req.headers['x-e-ts'] || '');
  const sig    = String(req.headers['x-val-sig']|| req.headers['x-entr-sig']|| req.headers['x-e-sig']|| '');

  const haveHmac = API_KEY && HMAC_SECRET && hdrKey && ts && sig;
  if (haveHmac) {
    if (hdrKey !== API_KEY) {
      console.warn('[AUTH]', 'API key mismatch', { got: maskTail(hdrKey), exp: maskTail(API_KEY), ip });
      return { ok:false, code:401, msg:'Unauthorized' };
    }
    if (!/^\d+$/.test(ts)) {
      console.warn('[AUTH]', 'Timestamp inválido', { ts, ip });
      return { ok:false, code:401, msg:'Unauthorized' };
    }
    const skew = Math.abs(Date.now() - Number(ts));
    if (skew > SKEW_MS) {
      console.warn('[AUTH]', 'Skew excedido', { skewMs: skew, ip });
      return { ok:false, code:401, msg:'Expired/Skew' };
    }

    // Validación firma
    const pathSeen = new URL(req.originalUrl, 'http://x').pathname; // p.ej. /validar-entrada
    const bodyHash = crypto.createHash('sha256').update(rawStr, 'utf8').digest('hex');
    const candidates = Array.from(new Set([ pathSeen, '/validar-entrada', '/entradas/validar-entrada' ]));

    let ok = false;
    for (const p of candidates) {
      const base = `${ts}.POST.${p}.${bodyHash}`;
      const exp  = crypto.createHmac('sha256', HMAC_SECRET).update(base).digest('hex');
      try {
        const a = Buffer.from(exp, 'utf8');
        const b = Buffer.from(sig, 'utf8');
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) { ok = true; break; }
      } catch {}
    }
    if (!ok) {
      console.warn('[AUTH]', 'Bad signature', { ip });
      return { ok:false, code:401, msg:'Unauthorized' };
    }

    // anti-replay
    pruneSeen();
    const nonceKey = ts + '.' + String(sig).slice(0,16);
    if (seen.has(nonceKey)) {
      console.warn('[AUTH]', 'Replay detectado', { ip });
      return { ok:false, code:401, msg:'Replay' };
    }
    seen.set(nonceKey, Date.now() + SKEW_MS);

    return { ok:true, mode:'HMAC' };
  }

  // 4) Fallback legacy (desaconsejado)
  if (!REQUIRE_HMAC) {
    const legacy = String(req.headers['x-laboroteca-token'] || '').trim();
    if (legacy && LEGACY_TOKEN && legacy === LEGACY_TOKEN) return { ok:true, mode:'LEGACY' };
  }

  console.warn('[AUTH]', 'Faltan cabeceras o config', { ip });
  return { ok:false, code:401, msg:'Unauthorized' };
}

// ====== NORMALIZACIÓN CÓDIGO ======
function limpiarCodigoEntrada(input){
  let c = String(input || '').trim();
  if (!c) return '';
  if (/^https?:\/\//i.test(c)) { try { const u = new URL(c); c = u.searchParams.get('codigo') || c; } catch {} }
  c = c.replace(/\s+/g,'').toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(c)) return '';
  if (c.includes('//') || c.length > 80) return '';
  return c;
}

// ====== Helpers ======
function timeoutMs(promise, ms, label='op'){
  let t; const timer = new Promise((_, rej)=>{ t=setTimeout(()=>rej(new Error(`${label}_timeout`)), ms); });
  return Promise.race([promise, timer]).finally(()=>clearTimeout(t));
}

// ====== HANDLER (ambos paths) ======
const paths = ['/validar-entrada','/entradas/validar-entrada'];
router.post(paths, async (req, res) => {
  const auth = verifyAuth(req);
  if (!auth.ok) {
    try {
      await alertAdmin({
        area: 'validador.auth',
        email: String(req.body?.validadorEmail || '-').toLowerCase(),
        err: new Error(auth.msg || 'Unauthorized'),
        meta: {
          code: auth.code || 401,
          ip: clientIp(req),
          path: req.originalUrl || '',
          ct: String(req.headers['content-type'] || ''),
        }
      });
    } catch (_) {}
    return res.status(auth.code || 401).json({ error: auth.msg || 'Unauthorized', errorCode: 'unauthorized' });
  }

  try {
    const slugEventoRaw = String(req.body?.slugEvento || '').trim(); // opcional
    const codigoLimpio  = limpiarCodigoEntrada(req.body?.codigoEntrada);
    if (!codigoLimpio) {
      return res.status(400).json({ error: 'Falta código de entrada.', errorCode: 'bad_params' });
    }

    // Allowlist opcional por ENV (solo si llega slug)
    const SLUG_ALLOW = String(process.env.VALIDADOR_SLUG_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean);
    if (slugEventoRaw && SLUG_ALLOW.length && !SLUG_ALLOW.includes(slugEventoRaw)) {
      return res.status(401).json({ error: 'Evento no autorizado.', errorCode: 'slug_not_allowed' });
    }

    // Idempotencia por código
    const docRef = firestore.collection('entradasValidadas').doc(codigoLimpio);
    const snap = await docRef.get();
    if (snap.exists) {
      console.warn('[VAL]', 'ALREADY_VALIDATED', { codigo: codigoLimpio });
      return res.status(409).json({ error: 'Entrada ya validada.', errorCode: 'already_validated' });
    }

    // Orden de búsqueda en Sheets
    const allSlugs = Object.keys(SHEETS_EVENTOS);
    const primary  = (slugEventoRaw && allSlugs.includes(slugEventoRaw)) ? [slugEventoRaw] : [];
    const rest     = allSlugs.filter(s => s !== slugEventoRaw);
    const candidates = [...primary, ...rest];

    let resultado = null;
    let matchedSlug = null;
    let lastError = null;

    for (const slug of candidates) {
      try {
        const r = await timeoutMs(marcarEntradaComoUsada(codigoLimpio, slug), SHEETS_TIMEOUT, `sheets_${slug}`);
        if (r && r.ok) { resultado = r; matchedSlug = slug; break; }          // encontrado
        if (r && r.error) { lastError = r.error; continue; }                  // seguimos con el siguiente
      } catch (e) {
        lastError = e?.message || String(e);
        continue;
      }
    }

    if (!resultado || !matchedSlug) {
      console.warn('[VAL]', 'NOT_FOUND', { codigo: codigoLimpio, tried: candidates });
      try {
        await alertAdmin({
          area: 'validador.not_found',
          email: String(req.body?.validadorEmail || '-').toLowerCase(),
          err: new Error('Código no encontrado'),
          meta: { codigo: codigoLimpio, tried: candidates, lastError }
        });
      } catch (_) {}
      return res.status(404).json({ error: 'Código no encontrado.', errorCode: 'not_found' });
    }

    const { emailComprador, descripcionProd, nombreAsistente } = resultado;
    const validadorEmail = String(req.body?.validadorEmail || '').trim() || null;
    const validadorWpId  = Number(req.body?.validadorWpId || 0) || null;

    try {
      await docRef.create({
        validado: true,
        fechaValidacion: admin.firestore.FieldValue.serverTimestamp(),
        fechaValidacionIso: new Date().toISOString(),
        validador: validadorEmail || 'Ignacio',
        validadorWpId,
        emailComprador: emailComprador || null,
        nombreAsistente: nombreAsistente || null,
        descripcionProducto: descripcionProd || null,
        evento: (codigoLimpio.split('-')[0] || '').toUpperCase(),
        slugEvento: matchedSlug,
        authMode: auth.mode || 'HMAC'
      });
    } catch (e) {
      if (String(e?.message || '').includes('Already exists')) {
        console.warn('[VAL]', 'ALREADY_VALIDATED_RACE', { codigo: codigoLimpio });
        return res.status(409).json({ error: 'Entrada ya validada.', errorCode: 'already_validated' });
      }
      console.error('[VAL]', 'FIRESTORE_ERROR', e?.message || e);
      try {
        await alertAdmin({
          area: 'validador.firestore',
          email: String(req.body?.validadorEmail || '-').toLowerCase(),
          err: e,
          meta: { codigo: codigoLimpio, slug: matchedSlug }
        });
      } catch (_) {}
      return res.status(500).json({ error: 'Error registrando validación.', errorCode: 'firestore_error' });
    }

    if (AUDIT_SUCCESS) console.info('[VAL]', 'VALIDADA', { codigo: codigoLimpio, slug: matchedSlug });
    return res.json({ ok: true, mensaje: 'Entrada validada correctamente.', slug: matchedSlug });

  } catch (err) {
    console.error('[VAL]', 'INTERNAL_ERROR', err?.stack || err);
    try {
      await alertAdmin({
        area: 'validador.route',
        email: String(req.body?.validadorEmail || '-').toLowerCase(),
        err: err,
        meta: {
          ip: clientIp(req),
          path: req.originalUrl || '',
          bodyKeys: Object.keys(req.body || {})
        }
      });
    } catch (_) {}
    return res.status(500).json({ error: 'Error interno al validar entrada.', errorCode: 'internal' });
  }
});

module.exports = router;
