/**
 * Archivo: utils/riskDecider.js
 * Función: registrar eventos de login y decidir riesgo según umbrales.
 *  - Memoria 24h por usuario (Map en proceso) + LRU global
 *  - Umbrales por ENV (defaults 6/6/6)
 *  - Geovelocidad opcional (métrica informativa)
 *  - Endurecimientos: ignora IPs/UA “ruidosos” (RFC1918, loopback, test-net),
 *    cap de memoria, anti-ráfagas, logs seguros (LAB_DEBUG).
 */

'use strict';

/* ================== Config vía ENV (con defaults) ================== */
const MAX_IPS_24    = Math.max(1, Number(process.env.RISK_IPS_24H    || 6));
const MAX_UA_24     = Math.max(1, Number(process.env.RISK_UAS_24H    || 6));
const MAX_LOGINS_15 = Math.max(1, Number(process.env.RISK_LOGINS_15M || 6));

const ENABLE_CRITICAL = (process.env.RISK_CRITICAL === '0') ? false : true;

// Geovelocidad (visible en métricas; NO dispara razones)
const CHECK_GEO   = (process.env.RISK_CHECK_GEO === '1');
const MAX_GEO_KMH = 0; // reservado/compat; no se usa como razón

// Ignorar UAs ruidosas (regex opcional, p.ej. monitores internos)
const NOISE_UA_RE   = (process.env.RISK_NOISE_UA_RE || '').trim();
const noiseUaRegex  = NOISE_UA_RE ? new RegExp(NOISE_UA_RE, 'i') : null;

// ¿Contar “ruidosos” en logins15? Por defecto no.
const COUNT_NOISE_IN_15M = (process.env.RISK_COUNT_NOISE_IN_LOGINS === '1');

const LAB_DEBUG = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');

// Anti-ruido ráfagas (misma ip+ua muy seguidas)
const BURST_COOLDOWN_MS = Math.max(0, Number(process.env.RISK_BURST_COOLDOWN_MS || 500));

// Cap de memoria por usuario (eventos) y cap global de usuarios
const PER_USER_CAP     = Math.max(50, Number(process.env.RISK_PER_USER_CAP || 500));
const GLOBAL_USERS_CAP = Math.max(1000, Number(process.env.RISK_GLOBAL_USERS_CAP || 20000));

/* ================== Estado en memoria ================== */
// mem[userId] = [{ t, ip, ua, lat, lon, country }]
const mem = new Map();
// último acceso para LRU
const lastAccess = new Map();

/* ================== Utilidades ================== */
function logDebug(...args){ if (LAB_DEBUG) console.log(...args); }

function keep24h(arr, now) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  return arr.filter(e => e.t >= cutoff);
}

function isPrivateIPv4(ip){
  // Rangos privados RFC1918, link-local, loopback, 0.0.0.0/8, 100.64/10 (CGNAT), broadcast.
  // No es un parser exhaustivo, pero es suficiente para filtrar ruido habitual.
  if (!ip || ip.includes(':')) return false; // IPv6: gestionar aparte
  const parts = ip.split('.').map(n => parseInt(n, 10));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return false;

  const [a,b] = parts;

  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (link-local)
  if (a === 127) return true;                          // loopback
  if (a === 0) return true;                            // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 (CGNAT)
  if (a === 255) return true;                          // 255.255.255.255 (broadcast)
  return false;
}

function isSpecialIPv6(ipv6){
  // Trata como ruido: ::1, fe80::/10 (link-local), fc00::/7 (ULA)
  const x = String(ipv6 || '').toLowerCase();
  return x === '::1' || x.startsWith('fe8') || x.startsWith('fc') || x.startsWith('fd');
}

// No contar IPs “ruidosas” (loopback, test-net, privadas…)
function isNoiseIp(ip) {
  if (!ip) return true;
  const x = String(ip).trim();

  // Test-nets y loopback clásicos
  if (x === '127.0.0.1' || x === '::1') return true;
  if (x.startsWith('192.0.2.') || x.startsWith('198.51.100.') || x.startsWith('203.0.113.')) return true;

  // IPv4 privados/ruido
  if (x.indexOf(':') === -1 && isPrivateIPv4(x)) return true;

  // IPv6 especiales
  if (x.indexOf(':') !== -1 && isSpecialIPv6(x)) return true;

  return false;
}

function isNoiseUa(ua) {
  if (!ua) return true; // UA vacío = ruido
  if (!noiseUaRegex) return false;
  return noiseUaRegex.test(ua);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function updateLRU(u){
  lastAccess.set(u, Date.now());
  if (mem.size > GLOBAL_USERS_CAP) {
    // expulsa el menos reciente
    let oldestK = null, oldestT = Infinity;
    for (const [k,t] of lastAccess.entries()) {
      if (t < oldestT) { oldestT = t; oldestK = k; }
    }
    if (oldestK && oldestK !== u) {
      mem.delete(oldestK);
      lastAccess.delete(oldestK);
    }
  }
}

/* ================== Core ================== */
/**
 * Registra un login y devuelve evaluación de riesgo.
 * @param {string|number} userId
 * @param {{ip?:string, ua?:string, lat?:number, lon?:number, country?:string, ts?:number}} ctx
 */
function recordLogin(userId, ctx = {}) {
  const now = Date.now();
  const u = String(userId || '').trim();
  if (!u) {
    logDebug('[riskDecider] userId vacío; ignorado');
    return _emptyResult();
  }

  // Protección LRU de usuarios en memoria
  if (!mem.has(u) && mem.size >= GLOBAL_USERS_CAP) {
    updateLRU(u); // se añadirá y LRU hará la expulsión
  }

  const ip = (ctx.ip || '').trim();
  const ua = (ctx.ua || '').toString().slice(0, 180); // límite razonable

  const lat = Number.isFinite(ctx.lat) ? Number(ctx.lat) : undefined;
  const lon = Number.isFinite(ctx.lon) ? Number(ctx.lon) : undefined;
  const country = (ctx.country || '').toUpperCase();

  const arr = mem.get(u) || [];

  // Anti-ráfagas: si el último evento con la misma (ip+ua) es demasiado reciente, lo ignoramos
  if (arr.length) {
    const last = arr[arr.length - 1];
    if (last && last.ip === ip && last.ua === ua && (now - last.t) < BURST_COOLDOWN_MS) {
      logDebug('[riskDecider] burst-skip', u, `${now - last.t}ms < ${BURST_COOLDOWN_MS}ms`);
      const res = _evaluate(arr, now);
      logDebug('[riskDecider]', u, res);
      updateLRU(u);
      return res;
    }
  }

  // Registrar
  arr.push({ t: now, ip, ua, lat, lon, country });

  // Conservar 24h y cap por usuario
  let trimmed = keep24h(arr, now);
  if (trimmed.length > PER_USER_CAP) trimmed = trimmed.slice(-PER_USER_CAP);
  mem.set(u, trimmed);

  // Evaluar
  const result = _evaluate(trimmed, now);
  logDebug('[riskDecider]', u, result);
  updateLRU(u);
  return result;
}

function _emptyResult() {
  return {
    level: 'normal',
    reasons: [],
    metrics: { ip24: 0, ua24: 0, logins15: 0, geoKmh: 0.0 },
    samples: { ips: [], uas: [] }
  };
}

/* ================== Evaluación ================== */
function _evaluate(events, now) {
  // Métricas base (24h)
  const ipsFiltered = events.map(e => e.ip).filter(ip => ip && !isNoiseIp(ip));
  const ipSet = new Set(ipsFiltered);

  const uasAll = events.map(e => e.ua).filter(Boolean);
  const uaSet = new Set(uasAll);

  // Ventana 15 minutos
  const cutoff15 = now - 15 * 60 * 1000;
  const in15 = events.filter(e => e.t >= cutoff15);

  const in15Filtered = COUNT_NOISE_IN_15M
    ? in15
    : in15.filter(e => e.ip && !isNoiseIp(e.ip) && e.ua && !isNoiseUa(e.ua));

  const last15 = in15Filtered.length;

  // Geovelocidad (métrica informativa; no dispara razones)
  let geoKmh = 0;
  if (CHECK_GEO) {
    for (let i = events.length - 1; i >= 1; i--) {
      const prev = events[i-1];
      const curr = events[i];
      if (Number.isFinite(prev.lat) && Number.isFinite(prev.lon) &&
          Number.isFinite(curr.lat) && Number.isFinite(curr.lon)) {
        const km = haversineKm(prev.lat, prev.lon, curr.lat, curr.lon);
        const h  = Math.max((curr.t - prev.t) / 3600000, 1/3600); // mínimo 1s
        geoKmh = km / h;
        break;
      }
    }
  }

  // Razones de riesgo
  const reasons = [];
  if (ipSet.size  > MAX_IPS_24)    reasons.push(`ips24=${ipSet.size}>${MAX_IPS_24}`);
  if (uaSet.size  > MAX_UA_24)     reasons.push(`uas24=${uaSet.size}>${MAX_UA_24}`);
  if (last15      > MAX_LOGINS_15) reasons.push(`logins15=${last15}>${MAX_LOGINS_15}`);

  // Nivel
  let level = 'normal';
  if (reasons.length) {
    level = 'high';
    if (ENABLE_CRITICAL) {
      const veryHigh =
        (ipSet.size >= (MAX_IPS_24 + 2)) ||
        (uaSet.size >= (MAX_UA_24 + 2)) ||
        (last15    >= (MAX_LOGINS_15 * 2)) ||
        (reasons.length >= 2); // varios indicadores a la vez
      if (veryHigh) level = 'critical';
    }
  }

  // Muestrario (top IP/UA) para logging/alertas
  const ipCounts = Object.entries(
    events.reduce((acc, e) => {
      if (e.ip && !isNoiseIp(e.ip)) acc[e.ip] = (acc[e.ip] || 0) + 1;
      return acc;
    }, {})
  ).sort((a,b)=> b[1] - a[1]).slice(0, 5);

  const uaCounts = Object.entries(
    events.reduce((acc, e) => {
      if (e.ua) acc[e.ua] = (acc[e.ua] || 0) + 1;
      return acc;
    }, {})
  ).sort((a,b)=> b[1] - a[1]).slice(0, 4);

  return {
    level,
    reasons,
    metrics: {
      ip24: ipSet.size,
      ua24: uaSet.size,
      logins15: last15,
      geoKmh: Number(geoKmh.toFixed(1))
    },
    samples: {
      ips: ipCounts.map(([k, v]) => ({ ip: k, n: v })),
      uas: uaCounts.map(([k, v]) => ({ ua: k, n: v }))
    }
  };
}

module.exports = {
  recordLogin,
};
