/**
 * Archivo: utils/riskDecider.js
 * Función: registrar eventos de login y decidir riesgo según umbrales.
 *  - Memoria 24h por usuario (en Map)
 *  - Umbrales por ENV (con defaults):
 *      RISK_IPS_24H=5
 *      RISK_UAS_24H=4
 *      RISK_LOGINS_15M=6
 *  - Geovelocidad DESACTIVADA por defecto (solo métrica para debug).
 *  - Pequeños endurecimientos: ignora IPs/UA “ruidosos”, cap de memoria y
 *    anti-ruido por ráfagas (cooldown corto por IP/UA).
 */

'use strict';

/* ================== Config vía ENV (con defaults) ================== */
const MAX_IPS_24     = Number(process.env.RISK_IPS_24H     || 5);
const MAX_UA_24      = Number(process.env.RISK_UAS_24H     || 4);
const MAX_LOGINS_15  = Number(process.env.RISK_LOGINS_15M  || 6);

// Geovelocidad (métrica visible pero NO dispara razones)
const CHECK_GEO   = false;
const MAX_GEO_KMH = 0; // sin uso, mantenido por compat

// Ignorar UAs ruidosas (regex opcional, por ejemplo monitores/robots internos)
const NOISE_UA_RE = (process.env.RISK_NOISE_UA_RE || '').trim();
const noiseUaRegex = NOISE_UA_RE ? new RegExp(NOISE_UA_RE, 'i') : null;

// ¿Contar eventos “ruidosos” en la métrica de 15 minutos?
// Por defecto NO (igual que con IPs ruidosas).
const COUNT_NOISE_IN_15M = (process.env.RISK_COUNT_NOISE_IN_LOGINS === '1');

const LAB_DEBUG = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');

// Anti-ruido: si la misma combinación (ip+ua) llega en ráfaga,
// ignora eventos con menos de este umbral en ms (por defecto 500 ms)
const BURST_COOLDOWN_MS = Number(process.env.RISK_BURST_COOLDOWN_MS || 500);

// Cap de memoria por usuario (eventos) y cap global de usuarios
const PER_USER_CAP = Number(process.env.RISK_PER_USER_CAP || 500);
const GLOBAL_USERS_CAP = Number(process.env.RISK_GLOBAL_USERS_CAP || 20000);

/* ================== Estado en memoria ================== */
// mem[userId] = [{ t, ip, ua, lat, lon, country }]
const mem = new Map();

/* ================== Utilidades ================== */
function keep24h(arr, now) {
  const cutoff = now - 24*60*60*1000;
  return arr.filter(e => e.t >= cutoff);
}

// No contar IPs “ruidosas” (localhost y redes de TEST)
function isNoiseIp(ip) {
  if (!ip) return true;
  const x = String(ip).trim();
  return (
    x === '127.0.0.1' || x === '::1' ||
    x.startsWith('192.0.2.')   || // TEST-NET-1
    x.startsWith('198.51.100.')|| // TEST-NET-2
    x.startsWith('203.0.113.')    // TEST-NET-3
  );
}

function isNoiseUa(ua) {
  if (!ua) return true;
  if (!noiseUaRegex) return false;
  return noiseUaRegex.test(ua);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  function toRad(d){ return d * Math.PI / 180; }
  const R = 6371;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ================== Core ================== */
/**
 * Registra un login y devuelve evaluación de riesgo.
 * @param {string|number} userId
 * @param {{ip?:string, ua?:string, lat?:number, lon?:number, country?:string, ts?:number}} ctx
 */
function recordLogin(userId, ctx = {}) {
  const now = Date.now();

  // Pequeña protección si alguien intenta inflar usuarios en memoria
  if (!mem.has(String(userId)) && mem.size > GLOBAL_USERS_CAP) {
    // Política simple: eliminar usuario más antiguo para dejar espacio
    const it = mem.keys().next();
    if (!it.done) mem.delete(it.value);
  }

  const u = String(userId);
  const ip = (ctx.ip || '').trim();
  // Limitar UA, normalizar y permitir detectar ruido
  const ua = (ctx.ua || '').toString().slice(0, 180);

  const lat = Number.isFinite(ctx.lat) ? Number(ctx.lat) : undefined;
  const lon = Number.isFinite(ctx.lon) ? Number(ctx.lon) : undefined;
  const country = (ctx.country || '').toUpperCase();

  const arr = mem.get(u) || [];

  // Anti-ráfagas: si el último evento del mismo (ip+ua) es “demasiado reciente”, lo ignoramos
  if (arr.length) {
    const last = arr[arr.length - 1];
    if (last && last.ip === ip && last.ua === ua && (now - last.t) < BURST_COOLDOWN_MS) {
      if (LAB_DEBUG) console.log('[riskDecider] burst-skip', u, `${now - last.t}ms < ${BURST_COOLDOWN_MS}ms`);
      // devolvemos estado actual sin registrar el burst
      return _evaluate(arr, now, ip, ua, lat, lon);
    }
  }

  // Registrar
  arr.push({ t: now, ip, ua, lat, lon, country });

  // Conservar 24h y cap por usuario
  let trimmed = keep24h(arr, now);
  if (trimmed.length > PER_USER_CAP) trimmed = trimmed.slice(-PER_USER_CAP);
  mem.set(u, trimmed);

  // Evaluar
  const result = _evaluate(trimmed, now, ip, ua, lat, lon);

  if (LAB_DEBUG) console.log('[riskDecider]', u, result);
  return result;
}

/* ================== Evaluación ================== */
function _evaluate(events, now, currentIp, currentUa, lat, lon) {
  // Métricas base
  const ipsFiltered = events.map(e => e.ip).filter(ip => ip && !isNoiseIp(ip));
  const ipSet = new Set(ipsFiltered);

  const uasAll = events.map(e => e.ua).filter(Boolean);
  const uaSet = new Set(uasAll);

  // Ventana 15 minutos
  const cutoff15 = now - 15*60*1000;
  const in15 = events.filter(e => e.t >= cutoff15);

  const in15Filtered = COUNT_NOISE_IN_15M
    ? in15
    : in15.filter(e => e.ip && !isNoiseIp(e.ip) && e.ua && !isNoiseUa(e.ua));

  const last15 = in15Filtered.length;

  // Geovelocidad (métrica para debug; no dispara razones)
  let geoKmh = 0;
  if (CHECK_GEO && Number.isFinite(lat) && Number.isFinite(lon)) {
    for (let i = events.length - 2; i >= 0; i--) {
      const prev = events[i];
      if (Number.isFinite(prev.lat) && Number.isFinite(prev.lon)) {
        const km = haversineKm(prev.lat, prev.lon, lat, lon);
        const h = Math.max( (now - prev.t) / 3600000, 1/3600 ); // mínimo 1s para evitar /0
        geoKmh = km / h;
        break;
      }
    }
  }

  // Razones
  const reasons = [];
  if (ipSet.size > MAX_IPS_24)   reasons.push(`ips24=${ipSet.size}>${MAX_IPS_24}`);
  if (uaSet.size > MAX_UA_24)    reasons.push(`uas24=${uaSet.size}>${MAX_UA_24}`);
  if (last15 > MAX_LOGINS_15)    reasons.push(`logins15=${last15}>${MAX_LOGINS_15}`);
  // geoKmh no se usa como razón (solo métrica)

  // Muestrario (top IP/UA) para logging/alertas
  const ipCounts = Object.entries(
    events.reduce((acc, e)=>{
      if (e.ip && !isNoiseIp(e.ip)) acc[e.ip]=(acc[e.ip]||0)+1;
      return acc;
    }, {})
  ).sort((a,b)=>b[1]-a[1]).slice(0,5);

  const uaCounts = Object.entries(
    events.reduce((acc, e)=>{
      if (e.ua) acc[e.ua]=(acc[e.ua]||0)+1;
      return acc;
    }, {})
  ).sort((a,b)=>b[1]-a[1]).slice(0,4);

  return {
    level: reasons.length ? 'high' : 'normal',
    reasons,
    metrics: {
      ip24: ipSet.size,
      ua24: uaSet.size,
      logins15: last15,
      geoKmh: Number(geoKmh.toFixed(1))
    },
    samples: {
      ips: ipCounts.map(([k,v])=>({ ip:k, n:v })),
      uas: uaCounts.map(([k,v])=>({ ua:k, n:v }))
    }
  };
}

module.exports = {
  recordLogin,
};
