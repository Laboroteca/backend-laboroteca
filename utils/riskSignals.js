// utils/closeAllSessionsWP.js (o dentro de tu módulo actual)

const crypto = require('crypto');

function hmac(secret, msg) {
  return crypto.createHmac('sha256', String(secret)).update(String(msg)).digest('hex');
}

/**
 * Cierra todas las sesiones en WP (firmado con HMAC).
 * Éxito = respuesta 2xx. Reintenta en 0.4s, 0.8s y 1.6s si falla (max 3 reintentos).
 *
 * @param {number|string} userId
 * @param {string} [email]  // opcional, para logs del lado WP
 * @returns {Promise<{ok:boolean,status:number,data:any,tries:number,reqId:string}>}
 */
async function closeAllSessionsWP(userId, email = '') {
  const endpoint = String(process.env.WP_RISK_ENDPOINT || '').trim();
  const secret   = String(process.env.WP_RISK_SECRET   || '').trim();

  if (!endpoint || !secret) {
    return { ok:false, status:500, data:{ error:'wp_hmac_not_configured' }, tries:0, reqId:'-' };
  }

  // Cierre en frío si llega string numérico
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) {
    return { ok:false, status:400, data:{ error:'bad_userId' }, tries:0, reqId:'-' };
  }

  const { default: fetch } = await import('node-fetch');
  const { default: AbortController } = await import('abort-controller');

  const maxRetries  = 3;
  const baseDelayMs = 400;
  const reqId = `risk_${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;

  async function once() {
    const ts  = Math.floor(Date.now()/1000);
    const sig = hmac(secret, `${uid}.${ts}`);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);

    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': reqId
        },
        body: JSON.stringify({ userId: uid, ts, sig, email: String(email || '') }),
        signal: ctl.signal
      });

      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }

      return { ok: r.ok, status: r.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  let last = { ok:false, status:0, data:null };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    last = await once();
    if (last.ok) {
      return { ok:true, status:last.status, data:last.data, tries:attempt+1, reqId };
    }
    // Reintentos solo para códigos transitorios/comunes: 423 (bloqueado), 429, 5xx
    if (![423, 429].includes(last.status) && (last.status < 500 || last.status > 599)) {
      break; // fallo no transitorio: no reintentar
    }
    const delay = Math.floor(Math.pow(2, attempt) * baseDelayMs);
    await new Promise(r => setTimeout(r, delay));
  }

  return { ok:false, status:last.status || 0, data:last.data, tries:maxRetries+1, reqId };
}

module.exports = { closeAllSessionsWP };
