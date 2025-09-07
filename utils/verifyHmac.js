'use strict';
const crypto = require('crypto');

// Ventana de tolerancia por defecto (5 min)
const DEFAULT_SKEW_MS = 5 * 60 * 1000;
// TTL anti-replay por defecto (10 min)
const DEFAULT_REPLAY_TTL_MS = 10 * 60 * 1000;
// Límite de claves en memoria antes de GC agresivo
const SEEN_MAX_KEYS = 10000;

const seen = new Map(); // reqId -> expireAt(ms epoch)

function gcSeen() {
  const now = Date.now();
  // Evitar crecimiento sin control
  if (seen.size > SEEN_MAX_KEYS) {
    // Limpieza rápida: borra expirados y, si sigue grande, recorta LRU simple
    for (const [k, v] of seen) {
      if (v < now) seen.delete(k);
    }
    if (seen.size > SEEN_MAX_KEYS) {
      let toDelete = seen.size - SEEN_MAX_KEYS;
      for (const k of seen.keys()) { // orden de inserción: borra los más antiguos
        seen.delete(k);
        if (--toDelete <= 0) break;
      }
    }
    return;
  }
  // GC normal
  for (const [k, v] of seen) {
    if (v < now) seen.delete(k);
  }
}

function sha256str(input) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

// Normaliza path: asegura '/' inicial, quita query/hash y colapsa barras
function normalizePath(p) {
  if (!p) return '/';
  try {
    // El path puede venir con query: /ruta?a=1#x
    p = String(p).split('#')[0].split('?')[0];
    if (p[0] !== '/') p = '/' + p;
    // Colapsa barras duplicadas
    p = p.replace(/\/{2,}/g, '/');
    return p;
  } catch {
    return '/';
  }
}

// Devuelve { ok, error }
function verifyHmac({ method, path, bodyRaw, headers, secret, skewMs = DEFAULT_SKEW_MS, replayTtlMs = DEFAULT_REPLAY_TTL_MS }) {
  // Node baja los nombres de cabeceras a minúsculas
  headers = headers || {};
  const tsHeader = String(headers['x-lab-ts'] || headers['x_lb_ts'] || '');
  const sigHeader = String(headers['x-lab-sig'] || headers['x_lb_sig'] || '');
  const reqId = String(headers['x-request-id'] || headers['x_request_id'] || '');

  if (!tsHeader || !sigHeader || !reqId) return { ok: false, error: 'missing_headers' };

  // Validaciones básicas
  // ts puede venir en ms (>= 1e11) o en s
  const tsNum = Number(tsHeader);
  if (!Number.isFinite(tsNum)) return { ok: false, error: 'bad_ts' };
  const tsMs = tsNum > 1e11 ? tsNum : tsNum * 1000;

  const now = Date.now();
  if (Math.abs(now - tsMs) > skewMs) return { ok: false, error: 'skew' };

  // Anti-replay con TTL
  gcSeen();
  if (seen.has(reqId)) return { ok: false, error: 'replay' };

  // Validar que la firma es hex de 64 chars (sha256)
  if (!/^[0-9a-f]{64}$/i.test(sigHeader)) return { ok: false, error: 'bad_sig_format' };

  // Normalizaciones
  const m = String(method || 'POST').toUpperCase();
  const p = normalizePath(path);
  const bodyHash = sha256str(bodyRaw || '');
  const tsSec = Math.floor(tsMs / 1000);

  // Formato de firma v2: ts.POST.<path>.sha256(body)
  const baseSec = `${tsSec}.${m}.${p}.${bodyHash}`;
  const baseMs  = `${Math.floor(tsMs)}.${m}.${p}.${bodyHash}`;
  const expectSec = crypto.createHmac('sha256', String(secret || '')).update(baseSec).digest('hex');
  const expectMs  = crypto.createHmac('sha256', String(secret || '')).update(baseMs).digest('hex');

  // Comparación constant-time segura (mismo tamaño)
  const sigBuf = Buffer.from(sigHeader, 'hex');
  const expBufS = Buffer.from(expectSec, 'hex');
  const expBufM = Buffer.from(expectMs,  'hex');
  const lenOk = (sigBuf.length === expBufS.length) || (sigBuf.length === expBufM.length);
  if (!lenOk) return { ok: false, error: 'bad_sig' };
  const match = (sigBuf.length === expBufS.length && crypto.timingSafeEqual(expBufS, sigBuf))
            || (sigBuf.length === expBufM.length && crypto.timingSafeEqual(expBufM, sigBuf));
  if (!match) return { ok: false, error: 'bad_sig' };

  // Marca anti-replay
  seen.set(reqId, now + (Number.isFinite(replayTtlMs) ? replayTtlMs : DEFAULT_REPLAY_TTL_MS));

  return { ok: true };
}

module.exports = { verifyHmac };