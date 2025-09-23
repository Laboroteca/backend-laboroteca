'use strict';
const crypto = require('crypto');

// Ventanas por defecto
const DEFAULT_SKEW_MS = 5 * 60 * 1000;        // ±5 min
const DEFAULT_REPLAY_TTL_MS = 10 * 60 * 1000; // 10 min
const SEEN_MAX_KEYS = 10000;                  // límite GC

// reqId -> expireAt
const seen = new Map();

function gcSeen() {
  const now = Date.now();
  for (const [k, v] of seen) if (v < now) seen.delete(k);
  if (seen.size > SEEN_MAX_KEYS) {
    let toDrop = seen.size - SEEN_MAX_KEYS;
    for (const k of seen.keys()) { seen.delete(k); if (--toDrop <= 0) break; }
  }
}

function sha256hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Path normalizado: sin query/hash, con '/' inicial, sin barras dobles, opcionalmente sin barra final
function normalizePath(p, dropTrailingSlash = true) {
  try {
    p = (p || '/').toString().split('#')[0].split('?')[0];
    if (p[0] !== '/') p = '/' + p;
    p = p.replace(/\/{2,}/g, '/');
    if (dropTrailingSlash && p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    return p;
  } catch { return '/'; }
}

function b64urlToBuf(s) {
  const ss = String(s).replace(/-/g,'+').replace(/_/g,'/');
  const pad = ss.length % 4 ? '='.repeat(4 - (ss.length % 4)) : '';
  return Buffer.from(ss + pad, 'base64');
}

// ────────────────────────────────────────────────────────────
// Verifica firma HMAC soportando:
//  v0:  ts . rawBody                      (binario)
//  v1:  ts . sha256(rawBody)              (hex)
//  v1u: ts . sha256(rawBody_unescaped)    (hex, tolera \/ ↔ /)
//  v2:  ts . METHOD . path . sha256(body) (hex), con/sin barra final
//  * Firma recibida en HEX o base64url
//  * ts en segundos o milisegundos
//  * Acepta cabeceras x-lb-*, x_lab_*, x-lab-* (ambas variantes)
// ────────────────────────────────────────────────────────────
function verifyHmac({
  method = 'POST',
  path = '/',
  bodyRaw = Buffer.alloc(0),       // Buffer del rawBody
  headers = {},
  secret,
  skewMs = DEFAULT_SKEW_MS,
  replayTtlMs = DEFAULT_REPLAY_TTL_MS,
  allowedVariants = null           // opcional: ['v2_/ruta_s', 'v2_/ruta_ms', ...]
}) {
  headers = headers || {};
  if (!Buffer.isBuffer(bodyRaw)) bodyRaw = Buffer.from(String(bodyRaw || ''), 'utf8');
  if (!secret) return { ok:false, error:'missing_secret' };

  // Aliases de cabeceras
  const pick = (h) =>
    headers[h] ||
    headers[h.replace(/-/g,'_')] ||
    headers[h.replace(/_/g,'-')] || '';

  // ✅ ahora sí aceptamos lb y lab
  const tsHeader  = String(pick('x-lb-ts')  || pick('x-lab-ts')  || '');
  const sigHeader = String(pick('x-lb-sig') || pick('x-lab-sig') || '');
  const reqId     = String(pick('x-request-id') || '');

  if (!tsHeader || !sigHeader) return { ok:false, error:'missing_headers' };

  // ts en s o ms
  const tsNum = Number(tsHeader);
  if (!Number.isFinite(tsNum)) return { ok:false, error:'bad_ts' };
  const tsMs   = tsNum > 1e11 ? tsNum : tsNum * 1000;
  const tsSec  = Math.floor(tsMs / 1000);
  const tsMsStr  = String(Math.floor(tsMs));
  const tsSecStr = String(tsSec);

  // ventana temporal
  if (Math.abs(Date.now() - tsMs) > skewMs) return { ok:false, error:'skew' };

  // anti-replay (opcional)
  if (reqId) {
    gcSeen();
    if (seen.has(reqId)) return { ok:false, error:'replay' };
  }

  const m  = String(method || 'POST').toUpperCase();
  const p1 = normalizePath(path, true);
  const p2 = normalizePath(path, false); // con barra final si aplica

  // Hashes de body
  const bodyHashRaw  = sha256hex(bodyRaw);
  const bodyUnescStr = bodyRaw.toString('utf8').replace(/\\\//g, '/');
  const bodyHashUnes = sha256hex(Buffer.from(bodyUnescStr, 'utf8'));

  // Candidatos (HEX) y binarios (para v0)
  const mkHex = (base) => crypto.createHmac('sha256', String(secret)).update(base).digest('hex');
  const mkBin = (tsStr, buf) => crypto.createHmac('sha256', String(secret)).update(tsStr).update('.').update(buf).digest();

  const candidates = [];

  // v0: ts . rawBody  (binario) — segundos y milisegundos
  candidates.push({ bin: mkBin(tsSecStr, bodyRaw), label:'v0_s'  });
  candidates.push({ bin: mkBin(tsMsStr,  bodyRaw), label:'v0_ms' });

  // v1: ts . sha256(body)
  candidates.push({ hex: mkHex(`${tsSecStr}.${bodyHashRaw}`),  label:'v1_s'  });
  candidates.push({ hex: mkHex(`${tsMsStr}.${bodyHashRaw}`),   label:'v1_ms' });

  // v1u: ts . sha256(body_unescaped)
  candidates.push({ hex: mkHex(`${tsSecStr}.${bodyHashUnes}`), label:'v1u_s' });
  candidates.push({ hex: mkHex(`${tsMsStr}.${bodyHashUnes}`),  label:'v1u_ms' });

  // v2: ts . METHOD . path . sha256(body) — con/sin barra final
  for (const pp of [p1, p2]) {
    candidates.push({ hex: mkHex(`${tsSecStr}.${m}.${pp}.${bodyHashRaw}`),  label:`v2_${pp}_s`  });
    candidates.push({ hex: mkHex(`${tsMsStr}.${m}.${pp}.${bodyHashRaw}`),   label:`v2_${pp}_ms` });
    // también con unescaped
    candidates.push({ hex: mkHex(`${tsSecStr}.${m}.${pp}.${bodyHashUnes}`), label:`v2u_${pp}_s` });
    candidates.push({ hex: mkHex(`${tsMsStr}.${m}.${pp}.${bodyHashUnes}`),  label:`v2u_${pp}_ms` });
  }

  // Firma recibida: HEX o base64url
  let sigBuf = null;
  if (/^[0-9a-f]{64}$/i.test(sigHeader)) {
    sigBuf = Buffer.from(sigHeader, 'hex');
  } else {
    try { sigBuf = b64urlToBuf(sigHeader); } catch { return { ok:false, error:'bad_sig_format' }; }
  }

  // Comparación en tiempo constante
  const allowSet = Array.isArray(allowedVariants) && allowedVariants.length
    ? new Set(allowedVariants)
    : null;
  for (const c of candidates) {
    if (allowSet && !allowSet.has(c.label)) continue;
    const expBuf = c.bin ? c.bin : Buffer.from(c.hex, 'hex');
    if (expBuf.length === sigBuf.length && crypto.timingSafeEqual(expBuf, sigBuf)) {
      if (reqId) seen.set(reqId, Date.now() + (Number.isFinite(replayTtlMs) ? replayTtlMs : DEFAULT_REPLAY_TTL_MS));
      return { ok:true, variant:c.label, bodyHash:bodyHashRaw };
    }
  }

  return { ok:false, error:'no_variant_match', bodyHash:bodyHashRaw };
}

module.exports = { verifyHmac };

