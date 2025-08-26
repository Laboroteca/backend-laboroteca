// 🔐 VALIDAR ENTRADA QR (privado)
// Acepta: /validar-entrada y /entradas/validar-entrada
'use strict';

const express = require('express');
const crypto  = require('crypto');
const admin   = require('../../firebase');
const firestore = admin.firestore();
const { marcarEntradaComoUsada } = require('../utils/sheetsEntradas');

const router = express.Router();
console.log('[VAL ROUTER] /validar-entrada cargado');

/* ====== Config ====== */
const API_KEY      = (process.env.VALIDADOR_API_KEY || '').trim();
const HMAC_SECRET  = (process.env.VALIDADOR_HMAC_SECRET || '').trim();
const SKEW_MS      = Number(process.env.VALIDADOR_SKEW_MS || 5*60*1000);
const REQUIRE_HMAC = String(process.env.VALIDADOR_REQUIRE_HMAC || '1') === '1';
const LEGACY_TOKEN = (process.env.VALIDADOR_ENTRADAS_TOKEN || '').trim();
const IP_ALLOW     = String(process.env.VALIDADOR_IP_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean);
const RATE_PER_MIN = Number(process.env.VALIDADOR_RATE_PER_MIN || 60);
const MAX_BODY     = Number(process.env.VALIDADOR_MAX_BODY || 12*1024);
const BYPASS       = String(process.env.VALIDADOR_BYPASS_SHEETS || '') === '1'; // 👈 toggle de diagnóstico
const SHEETS_TO    = Number(process.env.VALIDADOR_SHEETS_TIMEOUT_MS || 10000);

function maskTail(s){ return s ? `••••${String(s).slice(-4)}` : null; }
function sha10(s){ return s ? crypto.createHash('sha256').update(String(s)).digest('hex').slice(0,10) : null; }

console.log('[VAL CFG]', {
  apiKeyMasked: API_KEY ? maskTail(API_KEY) : '(none)',
  secretSha10: sha10(HMAC_SECRET) || '(none)',
  requireHmac : REQUIRE_HMAC,
  skewMs      : SKEW_MS,
  bypassSheets: BYPASS
});

/* ====== Logs de entrada ====== */
router.use((req, _res, next) => {
  console.log('[VAL REQ]', req.method, req.originalUrl, 'ip=', (req.headers['x-forwarded-for']||req.ip||''));
  next();
});

/* ====== Rate limit simple ====== */
const rl = new Map();
function clientIp(req){ const xf=String(req.headers['x-forwarded-for']||'').split(',')[0].trim(); return xf||req.ip||req.connection?.remoteAddress||''; }
function rateLimit(req){
  const ip = clientIp(req);
  if (!ip) return true;
  const key = ip + '|' + new Date().toISOString().slice(0,16);
  const c = (rl.get(key)||0)+1; rl.set(key,c);
  return c <= RATE_PER_MIN;
}

/* ====== Anti-replay ====== */
const seen = new Map();
function pruneSeen(){ const now=Date.now(); for (const [k,exp] of seen.entries()) if (exp<=now) seen.delete(k); }

/* ====== Auth HMAC ====== */
function verifyAuth(req){
  const ct = String(req.headers['content-type']||'');
  if (!ct.toLowerCase().startsWith('application/json')) return { ok:false, code:415, msg:'Content-Type inválido' };

  let rawStr = typeof req.rawBody === 'string' ? req.rawBody : '';
  if (!rawStr) { try { rawStr = JSON.stringify(req.body ?? {}); } catch { rawStr = ''; } }
  if (Buffer.byteLength(rawStr,'utf8') > MAX_BODY) return { ok:false, code:413, msg:'Payload demasiado grande' };

  const ip = clientIp(req);
  if (IP_ALLOW.length && !IP_ALLOW.includes(ip)) return { ok:false, code:401, msg:'IP no autorizada' };
  if (!rateLimit(req)) return { ok:false, code:429, msg:'Too Many Requests' };

  const key = String(req.headers['x-api-key']||'').trim();
  const ts  = String(req.headers['x-val-ts']||req.headers['x-entr-ts']||req.headers['x-e-ts']||'');
  const sig = String(req.headers['x-val-sig']||req.headers['x-entr-sig']||req.headers['x-e-sig']||'');

  console.log('[VAL HDRS]', { keyMasked: key?maskTail(key):'(none)', hasTs:!!ts, hasSig:!!sig, ct });

  const have = API_KEY && HMAC_SECRET && key && ts && sig;
  if (!have) {
    if (!REQUIRE_HMAC) {
      const legacy = String(req.headers['x-laboroteca-token']||'').trim();
      if (legacy && LEGACY_TOKEN && legacy===LEGACY_TOKEN) return { ok:true, mode:'LEGACY' };
    }
    return { ok:false, code:401, msg:'Unauthorized' };
  }

  if (key !== API_KEY) return { ok:false, code:401, msg:'Unauthorized (key)' };
  if (!/^\d+$/.test(ts))  return { ok:false, code:401, msg:'Unauthorized (ts)' };

  const now = Date.now();
  if (Math.abs(now-Number(ts)) > SKEW_MS) return { ok:false, code:401, msg:'Expired/Skew' };

  const seenPath = new URL(req.originalUrl,'http://x').pathname;
  const bodyHash = crypto.createHash('sha256').update(rawStr,'utf8').digest('hex');
  const candidates = Array.from(new Set([seenPath,'/validar-entrada','/entradas/validar-entrada']));

  let ok = false, chosen = '';
  for (const p of candidates) {
    const base = `${ts}.POST.${p}.${bodyHash}`;
    const exp  = crypto.createHmac('sha256', HMAC_SECRET).update(base).digest('hex');
    try {
      const a = Buffer.from(exp,'utf8'); const b = Buffer.from(sig,'utf8');
      if (a.length===b.length && crypto.timingSafeEqual(a,b)) { ok=true; chosen=p; break; }
    } catch {}
  }

  console.log('[VAL HMAC]', { path_seen: seenPath, chosen_path: ok?chosen:null, sig10: String(sig).slice(0,10), bodyHash10: bodyHash.slice(0,10) });

  if (!ok) return { ok:false, code:401, msg:'Bad signature' };

  pruneSeen();
  const nonceKey = ts + '.' + String(sig).slice(0,16);
  if (seen.has(nonceKey)) return { ok:false, code:401, msg:'Replay' };
  seen.set(nonceKey, now + SKEW_MS);

  return { ok:true, mode:'HMAC' };
}

/* ====== Normalización de código ====== */
function limpiarCodigoEntrada(input){
  let c = String(input||'').trim();
  if (!c) return '';
  if (/^https?:\/\//i.test(c)) { try { const u=new URL(c); c = u.searchParams.get('codigo') || c; } catch {} }
  c = c.replace(/\s+/g,'').toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(c)) return '';
  if (c.includes('//') || c.length > 80) return '';
  return c;
}

/* ====== Util ====== */
function timeoutMs(p, ms, label='op'){ let t; const timer=new Promise((_,rej)=>{t=setTimeout(()=>rej(new Error(`${label}_timeout`)),ms)}); return Promise.race([p,timer]).finally(()=>clearTimeout(t)); }

/* ====== Handler ====== */
const paths = ['/validar-entrada','/entradas/validar-entrada'];
router.post(paths, async (req, res) => {
  const auth = verifyAuth(req);
  console.log('[VAL AUTH]', auth);
  if (!auth.ok) return res.status(auth.code||401).json({ error: auth.msg || 'Unauthorized', errorCode: 'unauthorized' });

  try {
    const slugEventoRaw = String(req.body?.slugEvento || '').trim();
    const codigoLimpio  = limpiarCodigoEntrada(req.body?.codigoEntrada);
    console.log('[VAL FLOW] payload', { slug: slugEventoRaw, codigoLen: (codigoLimpio||'').length });

    if (!codigoLimpio || !slugEventoRaw) {
      return res.status(400).json({ error: 'Faltan campos obligatorios.', errorCode: 'bad_params' });
    }

    const SLUG_ALLOW = String(process.env.VALIDADOR_SLUG_ALLOW || '').split(',').map(s=>s.trim()).filter(Boolean);
    if (SLUG_ALLOW.length && !SLUG_ALLOW.includes(slugEventoRaw)) {
      return res.status(401).json({ error: 'Evento no autorizado.', errorCode: 'slug_not_allowed' });
    }

    // Idempotencia: si ya existe, 409
    const docRef = firestore.collection('entradasValidadas').doc(codigoLimpio);
    const snap = await docRef.get();
    if (snap.exists) {
      console.warn('[VAL FLOW] ya validada', { codigo: codigoLimpio });
      return res.status(409).json({ error: 'Entrada ya validada.', errorCode: 'already_validated' });
    }

    // BYPASS de diagnóstico para aislar fallo de Sheets
    if (BYPASS) {
      console.warn('[VAL FLOW] BYPASS Sheets activado → marcando directamente');
    } else {
      console.log('[VAL FLOW] buscar en Sheets', { slug: slugEventoRaw, codigo: codigoLimpio });
      let resultado;
      try {
        resultado = await timeoutMs(marcarEntradaComoUsada(codigoLimpio, slugEventoRaw), SHEETS_TO, 'sheets');
      } catch (e) {
        console.error('[VAL FLOW] sheets error/timeout', e?.message || e);
        return res.status(502).json({ error: 'Upstream (Sheets) no responde.', errorCode: 'upstream_error' });
      }
      console.log('[VAL FLOW] resultado Sheets', resultado);

      if (!resultado || resultado.error) {
        return res.status(404).json({ error: resultado?.error || 'Código no encontrado.', errorCode: 'not_found' });
      }

      req._resultadoSheets = resultado; // lo guardo para logging
    }

    const { emailComprador=null, nombreAsistente=null } = req._resultadoSheets || {};
    const validadorEmail = String(req.body?.validadorEmail || '').trim() || null;
    const validadorWpId  = Number(req.body?.validadorWpId || 0) || null;

    try {
      await docRef.create({
        validado: true,
        fechaValidacion: admin.firestore.FieldValue.serverTimestamp(),
        fechaValidacionIso: new Date().toISOString(),
        validador: validadorEmail || 'Ignacio',
        validadorWpId,
        emailComprador,
        nombreAsistente,
        evento: (codigoLimpio.split('-')[0] || '').toUpperCase(),
        slugEvento: slugEventoRaw,
        authMode: auth.mode || 'HMAC'
      });
    } catch (e) {
      if (String(e?.message||'').includes('Already exists')) {
        console.warn('[VAL FLOW] create collision → ya validada', { codigo: codigoLimpio });
        return res.status(409).json({ error: 'Entrada ya validada.', errorCode: 'already_validated' });
      }
      console.error('[VAL FLOW] firestore create error', e?.message || e);
      return res.status(500).json({ error: 'Error registrando validación.', errorCode: 'firestore_error' });
    }

    console.log('✅ VALIDADA', { codigo: codigoLimpio, slug: slugEventoRaw, by: validadorEmail || 'Ignacio' });
    return res.json({ ok: true, mensaje: 'Entrada validada correctamente.' });

  } catch (err) {
    console.error('❌ Error en /validar-entrada:', err?.stack || err);
    return res.status(500).json({ error: 'Error interno al validar entrada.', errorCode: 'internal' });
  }
});

module.exports = router;
