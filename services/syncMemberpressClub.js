// services/syncMemberpressClub.js
'use strict';

const fetch = require('node-fetch');
const crypto = require('crypto');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

// ⚙️ Config por entorno (no hardcode)
const DEFAULT_API_URL = (process.env.MP_SYNC_API_URL_CLUB || 'https://www.laboroteca.es/wp-json/laboroteca/v1/club-membership').trim();
const API_KEY         = (process.env.MP_SYNC_API_KEY || '').trim();
const HMAC_SECRET     = (process.env.MP_SYNC_HMAC_SECRET || '').trim();
const MP_SYNC_DEBUG   = String(process.env.MP_SYNC_DEBUG || '').trim() === '1';

// ——— utilidades ———
const maskTail = (s) => (s ? `••••${String(s).slice(-4)}` : null);
const nowIso   = () => new Date().toISOString();
const shortId  = () => crypto.randomBytes(6).toString('hex');

/**
 * Firma HMAC:
 * base = ts + ".POST." + <pathname> + "." + sha256(body)
 * header: x-lab-ts / x-lab-sig
 */
function signRequest(apiUrl, bodyStr) {
  const ts        = String(Date.now());
  const pathname  = new URL(apiUrl).pathname;
  const bodyHash  = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex');
  const base      = `${ts}.POST.${pathname}.${bodyHash}`;
  const sig       = crypto.createHmac('sha256', HMAC_SECRET).update(base).digest('hex');
  return { ts, sig, pathname, bodyHash };
}

/**
 * Sincroniza una membresía del CLUB en MemberPress (activar / desactivar).
 * Seguridad:
 *  - x-api-key (.env)
 *  - x-lab-ts + x-lab-sig (HMAC SHA256 de ts.POST.<path>.sha256(body))
 *
 * @param {Object} params
 * @param {string} params.email                   Email del usuario
 * @param {'activar'|'desactivar'} params.accion  Acción solicitada
 * @param {number} [params.membership_id=10663]   ID MemberPress del producto
 * @param {number} [params.importe=9.99]          Importe en euros (solo para activar)
 * @param {string} [params.expires_at]            (Opcional) ISO o 'YYYY-MM-DD HH:mm:ss' UTC
 * @param {string} [params.apiUrl]                (Opcional) URL del endpoint WP
 * @returns {Promise<Object>}                     Respuesta JSON del endpoint WP
 */
async function syncMemberpressClub({
  email,
  accion,
  membership_id = 10663,
  importe = 9.99,
  expires_at,
  apiUrl
}) {
  // —— Validaciones de entrada
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('❌ Email inválido en syncMemberpressClub');
  }
  // Acepta sinónimos entrantes, pero normaliza a lo que entiende WP: activar | desactivar
  const ALLOWED_IN = ['activar','desactivar','desactivar_inmediata','desactivar_fin_ciclo'];
  if (!ALLOWED_IN.includes(accion)) {
    throw new Error("❌ Acción inválida: usa 'activar' o 'desactivar'");
  }
  if (!Number.isInteger(membership_id)) {
    throw new Error('❌ membership_id debe ser un número entero');
  }

  // —— Config segura obligatoria
  const API_URL = (apiUrl || DEFAULT_API_URL).trim();
  if (!API_URL || !API_KEY || !HMAC_SECRET) {
    throw new Error('❌ Config MP Sync incompleta: MP_SYNC_API_URL_CLUB / MP_SYNC_API_KEY / MP_SYNC_HMAC_SECRET');
  }

  // —— Normalización de importe
  const importeNum = (typeof importe === 'number' && isFinite(importe) && importe > 0)
    ? parseFloat(importe.toFixed(2))
    : 9.99;

  // —— Normalización de acción hacia WP (solo acepta 'activar' | 'desactivar')
  const accionOut = (accion === 'activar') ? 'activar' : 'desactivar';

  // —— Payload
  const payload = {
    email,
    accion: accionOut,
    membership_id,
    importe: importeNum
  };
  if (typeof expires_at === 'string' && expires_at.trim()) {
    payload.expires_at = expires_at.trim(); // el endpoint lo aceptará para fin de ciclo
  }

  const bodyStr = JSON.stringify(payload);

  // —— Firma HMAC + trazas de depuración (opt-in)
  const { ts, sig, pathname, bodyHash } = signRequest(API_URL, bodyStr);

  if (MP_SYNC_DEBUG) {
    console.log('[MP DEBUG OUT]', {
      url: API_URL,
      path: pathname,
      ts,
      bodyHash10: bodyHash.slice(0, 10),
      sig10: sig.slice(0, 10),
      apiKeyMasked: maskTail(API_KEY),
      accionOut,
      hasExpiresAt: Boolean(payload.expires_at)
    });
  }

  // —— Log operativo mínimo
  const reqId = shortId();
  console.log(`⏩ [syncMemberpressClub#${reqId}] '${accionOut}' → ${email} (ID:${membership_id}${accionOut==='activar' ? `, €${importeNum}` : ''}${payload.expires_at ? `, expires_at=${payload.expires_at}` : ''})`);

  // —— Petición (con 1 reintento simple ante 502/503/504)
  let response;
  let text;
  const attempt = async () => {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LaborotecaMP/1.0',
        'x-api-key': API_KEY,
        'x-lab-ts': ts,
        'x-lab-sig': sig,
        'x-request-id': reqId
      },
      body: bodyStr,
      timeout: 15000 // 15s
    });
    const t = await r.text();
    return { r, t };
  };

  try {
    ({ r: response, t: text } = await attempt());

    // Reintento simple si es 502/503/504
    if ([502, 503, 504].includes(response.status)) {
      if (MP_SYNC_DEBUG) console.warn(`[syncMemberpressClub#${reqId}] retry por ${response.status}`);
      await new Promise(res => setTimeout(res, 500));
      ({ r: response, t: text } = await attempt());
    }

    // —— Parseo de JSON
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`❌ Respuesta no es JSON válido: ${text.substring(0, 200)}`);
    }

    // —— Errores HTTP
    if (!response.ok) {
      const errorMsg = (data && (data.message || data.error)) || response.statusText || 'HTTP error';
      throw new Error(`❌ Error HTTP ${response.status} en syncMemberpressClub: ${errorMsg}`);
    }

    // —— Validación semántica: el endpoint devuelve { ok: true, ... }
    if (!data || data.ok !== true) {
      throw new Error(`❌ Respuesta WP inesperada (ok=${String(data?.ok)})`);
    }

    console.log(`✅ [MemberPressClub#${reqId}] '${accionOut}' OK para ${email}`);
    return data;

  } catch (err) {
    // —— Log de error y alerta
    console.error(`❌ [syncMemberpressClub#${reqId}]`, err?.message || err, text ? `| resp: ${text.substring(0, 200)}` : '');

    try {
      await alertAdmin({
        area: 'memberpress_sync',
        email,
        err,
        meta: {
          accion: accionOut,
          membership_id,
          importe: importeNum,
          apiUrl: API_URL,
          ts,
          reqId,
          status: response?.status || null,
          responseTextSnippet: typeof text === 'string' ? text.slice(0, 500) : null,
          at: nowIso()
        }
      });
    } catch {
      // no romper por fallo en alertAdmin
    }

    throw err;
  }
}

module.exports = { syncMemberpressClub };
