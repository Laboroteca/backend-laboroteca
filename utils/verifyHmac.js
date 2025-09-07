'use strict';
const crypto = require('crypto');

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const DEFAULT_SKEW_MS = 5 * 60 * 1000;   // ±5 min de tolerancia
const DEFAULT_REPLAY_TTL_MS = 10 * 60 * 1000; // 10 min anti-replay
const SEEN_MAX_KEYS = 10_000;            // límite de claves en memoria

// reqId -> expireAt(ms epoch)
const seen = new Map();

function gcSeen() {
  const now = Date.now();
  // Limpieza de expirados
  for (const [k, v] of seen) if (v < now) seen.delete(k);
  // Si sigue creciendo, recorte simple de los más antiguos
  if (seen.size > SEEN_MAX_KEYS) {
    let extra = seen.size - SEEN_MAX_KEYS;
    for (const k of seen.keys()) { seen.delete(k); if (--extra <= 0) break; }
  }
}

function sha256str(input) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

// Normaliza path: comienza por '/', sin query ni hash, colapsa barras
function normalizePath(p) {
  if (!p) return '/';
  try {
    p = String(p).split('#')[0].split('?')[0];
    if (p[0] !== '/') p = '/' + p;
    return p.replace(/\/{2,}/g, '/');
  } catch {
    return '/';
  }
}

/**
 * Verifica firmas HMAC.
 * Formatos aceptados:
 *  - v2: ts.METHOD.path.sha256(body)     ✅
 *  - v2(ms): ts_ms.METHOD.path.sha256    ✅
 *  - legacy: ts.sha256(body)             🛟 compat
 *  - legacy(ms): ts_ms.sha256            🛟 compat
 *
 * Cabeceras aceptadas (cualquiera):
 *  - TS:  x-lab-ts | x_lb_ts | x-entr-ts | x_entr_ts | x-e-ts | x_e_ts
 *  - SIG: x-lab-sig| x_lb_sig| x-entr-sig| x_entr_sig| x-e-sig| x_e_sig
 *  - REQ: x-request-id | x_request_id  (opcional: habilita anti-replay)
 */
function verifyHmac({
  method,
  path,
  bodyRaw,
  headers,
  secret,
  skewMs = DEFAULT_SKEW_MS,
  replayTtlMs = DEFAULT_REPLAY_TTL_MS
}) {
  headers = headers || {};

  // ── Leer cabeceras (Node las baja a minúsculas)
  const tsHeader = String(
    headers['x-lab-ts']  || headers['x_lb_ts']  ||
    headers['x-entr-ts'] || headers['x_entr_ts']||
    headers['x-e-ts']    || headers['x_e_ts']   || ''
  );
  const sigHeader = String(
    headers['x-lab-sig']  || headers['x_lb_sig']  ||
    headers['x-entr-sig'] || headers['x_entr_sig']||
    headers['x-e-sig']    || headers['x_e_sig']   || ''
  );
  const reqId = String(headers['x-request-id'] || headers['x_request_id'] || '');

  if (!tsHeader || !sigHeader) return { ok: false, error: 'missing_headers' };
  if (!/^[0-9a-f]{64}$/i.test(sigHeader)) return { ok: false, error: 'bad_sig_format' };

  // ── TS en s o ms
  const tsNum = Number(tsHeader);
  if (!Number.isFinite(tsNum)) return { ok: false, error: 'bad_ts' };
  const tsMs = tsNum > 1e11 ? tsNum : tsNum * 1000; // >= ~Sat 1973 en ms

  // ── Skew
  const now = Date.now();
  if (Math.abs(now - tsMs) > skewMs) return { ok: false, error: 'skew' };

  // ── Anti-replay (solo si hay request-id)
  gcSeen();
  if (reqId && seen.has(reqId)) return { ok: false, error: 'replay' };

  // ── Material a firmar
  const m = String(method || 'POST').toUpperCase();
  const p = normalizePath(path);
  const bodyHash = sha256str(bodyRaw || '');
  const tsSec = Math.floor(tsMs / 1000);
  const tsMsInt = Math.floor(tsMs);

  // v2 (sec y ms)
  const baseSec = `${tsSec}.${m}.${p}.${bodyHash}`;
  const baseMs  = `${tsMsInt}.${m}.${p}.${bodyHash}`;
  const expectSec = crypto.createHmac('sha256', String(secret || '')).update(baseSec).digest('hex');
  const expectMs  = crypto.createHmac('sha256', String(secret || '')).update(baseMs ).digest('hex');

  // legacy (sec y ms)
  const legacySec = crypto.createHmac('sha256', String(secret || '')).update(`${tsSec}.${bodyHash}`).digest('hex');
  const legacyMs  = crypto.createHmac('sha256', String(secret || '')).update(`${tsMsInt}.${bodyHash}`).digest('hex');

  // ── Comparación constant-time
  const sigBuf   = Buffer.from(sigHeader, 'hex');
  const expBufs  = [
    Buffer.from(expectSec, 'hex'),
    Buffer.from(expectMs,  'hex'),
    Buffer.from(legacySec, 'hex'),
    Buffer.from(legacyMs,  'hex')
  ];
  const anyLenOk = expBufs.some(b => b.length === sigBuf.length);
  if (!anyLenOk) return { ok: false, error: 'bad_sig' };
  const match = expBufs.some(b => b.length === sigBuf.length && crypto.timingSafeEqual(b, sigBuf));
  if (!match) return { ok: false, error: 'bad_sig' };

  // ── Marca anti-replay si procede
  if (reqId) {
    const ttl = Number.isFinite(replayTtlMs) ? replayTtlMs : DEFAULT_REPLAY_TTL_MS;
    seen.set(reqId, now + ttl);
  }

  return { ok: true };
}

module.exports = { verifyHmac };
