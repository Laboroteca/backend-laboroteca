'use strict';
const crypto = require('crypto');

// Ventanas por defecto
const DEFAULT_SKEW_MS = 5 * 60 * 1000;      // ±5 min
const DEFAULT_REPLAY_TTL_MS = 10 * 60 * 1000; // 10 min
const SEEN_MAX_KEYS = 10000;                // límite GC

// reqId -> expireAt
const seen = new Map();

function gcSeen() {
  const now = Date.now();
  // limpia expirados
  for (const [k, v] of seen) if (v < now) seen.delete(k);
  // si sigue muy grande, recorta LRU simple
  if (seen.size > SEEN_MAX_KEYS) {
    let toDrop = seen.size - SEEN_MAX_KEYS;
    for (const k of seen.keys()) { seen.delete(k); if (--toDrop <= 0) break; }
  }
}

function sha256str(bufOrStr) {
  return crypto.createHash('sha256').update(
    typeof bufOrStr === 'string' ? Buffer.from(bufOrStr, 'utf8') : (bufOrStr || Buffer.alloc(0))
  ).digest('hex');
}

// Path normalizado: sin query/hash, con '/' inicial, sin barras dobles
function normalizePath(p) {
  try {
    p = (p || '/').toString();
    p = p.split('#')[0].split('?')[0];
    if (p[0] !== '/') p = '/' + p;
    return p.replace(/\/{2,}/g, '/');
  } catch { return '/'; }
}

/**
 * Verifica HMAC de cabeceras
 * - Acepta headers: x-lab-*, x_*, x-entr-*, x-e-*
 * - Formatos aceptados:
 *     v2:  ts.POST.<path>.sha256(body)
 *     v1:  ts.sha256(body)            (legacy)
 * - ts admitido en segundos o milisegundos
 * - Anti-replay solo si viene x-request-id
 */
function verifyHmac({
  method = 'POST',
  path = '/',
  bodyRaw = '',
  headers = {},
  secret,
  skewMs = DEFAULT_SKEW_MS,
  replayTtlMs = DEFAULT_REPLAY_TTL_MS
}) {
  headers = headers || {};

  // aliases de cabeceras
  const pick = (h) =>
    headers[h] || headers[h.replace(/-/g, '_')] || headers[h.replace(/_/g, '-')];

  const tsHeader  = String(
      pick('x-lab-ts') || pick('x-entr-ts') || pick('x-e-ts') || ''
  );
  const sigHeader = String(
      pick('x-lab-sig') || pick('x-entr-sig') || pick('x-e-sig') || ''
  );
  const reqId     = String(pick('x-request-id') || '');

  if (!tsHeader || !sigHeader) return { ok: false, error: 'missing_headers' };
  if (!secret) return { ok: false, error: 'missing_secret' };

  // ts en s o ms
  const tsNum = Number(tsHeader);
  if (!Number.isFinite(tsNum)) return { ok: false, error: 'bad_ts' };
  const tsMs  = tsNum > 1e11 ? tsNum : tsNum * 1000;
  const tsSec = Math.floor(tsMs / 1000);

  // ventana de tiempo
  if (Math.abs(Date.now() - tsMs) > skewMs) return { ok: false, error: 'skew' };

  // anti-replay si hay reqId
  if (reqId) {
    gcSeen();
    if (seen.has(reqId)) return { ok: false, error: 'replay' };
  }

  // firma hex 64
  if (!/^[0-9a-f]{64}$/i.test(sigHeader)) return { ok: false, error: 'bad_sig_format' };

  const m = String(method || 'POST').toUpperCase();
  const p = normalizePath(path);
  const bodyHash = sha256str(bodyRaw);

  // generamos todas las variantes aceptadas
  const bases = [
    // v2 (segundos)
    `${tsSec}.${m}.${p}.${bodyHash}`,
    // v2 (milisegundos)
    `${Math.floor(tsMs)}.${m}.${p}.${bodyHash}`,
    // legacy v1 (segundos)
    `${tsSec}.${bodyHash}`,
    // legacy v1 (milisegundos)
    `${Math.floor(tsMs)}.${bodyHash}`,
  ];

  const expected = bases.map(b => crypto.createHmac('sha256', String(secret)).update(b).digest('hex'));
  const sigBuf = Buffer.from(sigHeader, 'hex');

  let match = false;
  for (const exp of expected) {
    const expBuf = Buffer.from(exp, 'hex');
    if (expBuf.length === sigBuf.length && crypto.timingSafeEqual(expBuf, sigBuf)) {
      match = true; break;
    }
  }
  if (!match) return { ok: false, error: 'bad_sig' };

  // marca anti-replay si hay reqId
  if (reqId) seen.set(reqId, Date.now() + (Number.isFinite(replayTtlMs) ? replayTtlMs : DEFAULT_REPLAY_TTL_MS));

  return { ok: true };
}

module.exports = { verifyHmac };
