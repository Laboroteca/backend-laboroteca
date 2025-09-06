/**
 * Archivo: utils/riskDecider.js
 * Función: registrar eventos de login y decidir riesgo según umbrales.
 *  - Mantiene memoria 24h por usuario (en Map)
 *  - Umbrales por ENV (con defaults):
 *      RISK_IPS_24H=8
 *      RISK_UAS_24H=6
 *      RISK_LOGINS_15M=10
 *      RISK_GEO_KMH_MAX=500
 */

'use strict';

const MAX_IPS_24     = Number(process.env.RISK_IPS_24H      || 8);
const MAX_UA_24      = Number(process.env.RISK_UAS_24H      || 6);
const MAX_LOGINS_15  = Number(process.env.RISK_LOGINS_15M   || 10);
const MAX_GEO_KMH    = Number(process.env.RISK_GEO_KMH_MAX  || 500);
const LAB_DEBUG      = (process.env.LAB_DEBUG === '1' || process.env.DEBUG === '1');

const mem = new Map(); // mem[userId] = [{ t, ip, ua, lat, lon, country }]

function keep24h(arr, now) {
  const cutoff = now - 24*60*60*1000;
  return arr.filter(e => e.t >= cutoff);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  function toRad(d){ return d * Math.PI / 180; }
  const R = 6371;
  const dLat = toRad(lat2-lat1);
  const dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Registra un login y devuelve evaluación de riesgo.
 * @param {string|number} userId
 * @param {{ip?:string, ua?:string, lat?:number, lon?:number, country?:string, ts?:number}} ctx
 */
function recordLogin(userId, ctx = {}) {
  const now = Date.now();
  const u = String(userId);
  const ip = (ctx.ip || '').trim();
  const ua = (ctx.ua || '').slice(0, 180);
  const lat = Number.isFinite(ctx.lat) ? Number(ctx.lat) : undefined;
  const lon = Number.isFinite(ctx.lon) ? Number(ctx.lon) : undefined;
  const country = (ctx.country || '').toUpperCase();

  const arr = mem.get(u) || [];
  arr.push({ t: now, ip, ua, lat, lon, country });
  // conservar 24h
  let trimmed = keep24h(arr, now);
  // cap anti-memoria (por si hay abuso): max 500 eventos por usuario
  if (trimmed.length > 500) trimmed = trimmed.slice(-500);
  mem.set(u, trimmed);

  // métricas
  const ipSet = new Set(trimmed.map(e => e.ip).filter(Boolean));
  const uaSet = new Set(trimmed.map(e => e.ua).filter(Boolean));
  const last15 = trimmed.filter(e => e.t >= (now - 15*60*1000)).length;

  // geovelocidad si hay coordenadas consecutivas
  let geoKmh = 0;
  if (lat !== undefined && lon !== undefined) {
    // busca el evento previo con geodatos
    for (let i = trimmed.length - 2; i >= 0; i--) {
      const prev = trimmed[i];
      if (Number.isFinite(prev.lat) && Number.isFinite(prev.lon)) {
        const km = haversineKm(prev.lat, prev.lon, lat, lon);
        const h = Math.max( (now - prev.t) / 3600000, 1/3600 ); // evita /0 (min 1s)
        geoKmh = km / h;
        break;
      }
    }
  }

  // razones
  const reasons = [];
  if (ipSet.size > MAX_IPS_24)    reasons.push(`ips24=${ipSet.size}>${MAX_IPS_24}`);
  if (uaSet.size > MAX_UA_24)     reasons.push(`uas24=${uaSet.size}>${MAX_UA_24}`);
  if (last15 > MAX_LOGINS_15)     reasons.push(`logins15=${last15}>${MAX_LOGINS_15}`);
  if (geoKmh > MAX_GEO_KMH)       reasons.push(`geo_kmh=${geoKmh.toFixed(0)}>${MAX_GEO_KMH}`);

  // muestrario para alertas
  const ipCounts = Object.entries(trimmed.reduce((acc, e)=>{ if(e.ip) acc[e.ip]=(acc[e.ip]||0)+1; return acc; }, {}))
    .sort((a,b)=>b[1]-a[1]).slice(0,5);
  const uaCounts = Object.entries(trimmed.reduce((acc, e)=>{ if(e.ua) acc[e.ua]=(acc[e.ua]||0)+1; return acc; }, {}))
    .sort((a,b)=>b[1]-a[1]).slice(0,4);

  const result = {
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

  if (LAB_DEBUG) console.log('[riskDecider]', u, result);
  return result;
}

module.exports = {
  recordLogin,
};
