// services/syncMemberpressLibro.js
'use strict';

const fetch = require('node-fetch');
const crypto = require('crypto');
const { alertAdmin } = require('../utils/alertAdmin');

// ⚙️ Config por entorno (no hardcode)
const DEFAULT_API_URL = (process.env.MP_SYNC_API_URL_LIBRO || 'https://www.laboroteca.es/wp-json/laboroteca/v1/libro-membership').trim();
const API_KEY         = (process.env.MP_SYNC_API_KEY || '').trim();
const HMAC_SECRET     = (process.env.MP_SYNC_HMAC_SECRET || '').trim();
const MP_SYNC_DEBUG   = String(process.env.MP_SYNC_DEBUG || '').trim() === '1';

// ——— utilidades ———
const maskTail = (s) => (s ? `••••${String(s).slice(-4)}` : null);
const nowIso   = () => new Date().toISOString();
const shortId  = () => crypto.randomBytes(6).toString('hex');

// Firma: HMAC-SHA256(ts.POST.<pathname>.sha256(body))
function signRequest(apiUrl, bodyStr) {
  const ts        = String(Date.now());
  const pathname  = new URL(apiUrl).pathname;
  const bodyHash  = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex');
  const base      = `${ts}.POST.${pathname}.${bodyHash}`;
  const sig       = crypto.createHmac('sha256', HMAC_SECRET).update(base).digest('hex');
  return { ts, sig, pathname, bodyHash };
}

/**
 * Sincroniza la membresía del LIBRO en MemberPress (activar o desactivar).
 * Seguridad:
 *  - x-api-key (.env)
 *  - x-mp-ts (timestamp ms) + x-mp-sig (HMAC SHA256 de ts.POST.<path>.sha256(body))
 *
 * Reutilizable: puedes pasar apiUrl para otros endpoints si publicas más productos.
 *
 * @param {Object} params
 * @param {string} params.email                 Email del usuario
 * @param {'activar'|'desactivar'} params.accion
 * @param {number} [params.membership_id=7994]  ID MemberPress del producto
 * @param {number} [params.importe=29.90]       Importe en euros
 * @param {string} [params.apiUrl]              (Opcional) URL del endpoint WP a usar
 * @returns {Promise<Object>}                   Respuesta JSON del endpoint WP
 */
async function syncMemberpressLibro({
  email,
  accion,
  membership_id = 7994,
  importe = 29.90,
  apiUrl
}) {
  // —— Validaciones de entrada
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('❌ Email inválido en syncMemberpressLibro');
  }
  if (!['activar', 'desactivar'].includes(accion)) {
    throw new Error("❌ Acción inválida: debe ser 'activar' o 'desactivar'");
  }
  if (!Number.isInteger(membership_id)) {
    throw new Error('❌ membership_id debe ser un número entero');
  }

  // —— Config segura obligatoria
  const API_URL = (apiUrl || DEFAULT_API_URL).trim();
  if (!API_URL || !API_KEY || !HMAC_SECRET) {
    throw new Error('❌ Config MP Sync incompleta: MP_SYNC_API_URL_LIBRO / MP_SYNC_API_KEY / MP_SYNC_HMAC_SECRET');
  }

  // —— Normalización de importe
  const importeNum = (typeof importe === 'number' && isFinite(importe) && importe > 0)
    ? parseFloat(importe.toFixed(2))
    : 29.90;

  // —— Payload
  const payload = {
    email,
    accion,
    membership_id,
    importe: importeNum
  };
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
      apiKeyMasked: maskTail(API_KEY)
    });
  }

  // —— Log operativo mínimo
  const reqId = shortId();
  console.log(`📡 [syncMemberpressLibro#${reqId}] '${accion}' → ${email} (ID:${membership_id}, €${importeNum})`);

  // —— Petición
  let response;
  let text;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LaborotecaMP/1.0',
        'x-api-key': API_KEY,
        'x-mp-ts': ts,
        'x-mp-sig': sig,
        'x-request-id': reqId
      },
      body: bodyStr,
      timeout: 15000 // 15s
    });

    text = await response.text();

    // —— Parseo de JSON
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`❌ Respuesta no es JSON válido: ${text.substring(0, 200)}`);
    }

    // —— Errores HTTP
    if (!response.ok) {
      const errorMsg = (data && data.message) || (data && data.error) || response.statusText || 'HTTP error';
      throw new Error(`❌ Error HTTP ${response.status} en syncMemberpressLibro: ${errorMsg}`);
    }

    // —— Validación SEMÁNTICA (200 pero sin efecto real)
    if (!data || data.ok !== true) {
      throw new Error(`❌ Respuesta WP inesperada (ok=${String(data?.ok)})`);
    }
    if (accion === 'activar') {
      const tx = Number(data.transaction_id);
      if (!Number.isFinite(tx) || tx <= 0) {
        throw new Error('❌ WP respondió OK pero sin transaction_id válido');
      }
    }

    console.log(`✅ [MemberPressLibro#${reqId}] '${accion}' OK para ${email} ${accion === 'activar' ? `(tx=${data.transaction_id})` : ''}`);
    return data;

  } catch (err) {
    // —— Log de error y alerta
    console.error(`❌ [syncMemberpressLibro#${reqId}]`, err?.message || err, text ? `| resp: ${text.substring(0, 200)}` : '');

    try {
      await alertAdmin({
        area: 'memberpress_libro_sync',
        email,
        err,
        meta: {
          accion,
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

module.exports = { syncMemberpressLibro };
