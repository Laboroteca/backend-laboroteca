// services/syncMemberpressLibro.js
'use strict';

const fetch = require('node-fetch');
const crypto = require('crypto');
const { alertAdmin } = require('../utils/alertAdmin');

const API_URL = (process.env.MP_SYNC_API_URL_LIBRO || 'https://www.laboroteca.es/wp-json/laboroteca/v1/libro-membership').trim();
const API_KEY = (process.env.MP_SYNC_API_KEY || '').trim();
const HMAC_SECRET = (process.env.MP_SYNC_HMAC_SECRET || '').trim();
const MP_SYNC_DEBUG = String(process.env.MP_SYNC_DEBUG || '').trim() === '1';

/**
 * Sincroniza la membresía del LIBRO en MemberPress (activar o desactivar).
 * Seguridad:
 *  - x-api-key desde .env (no hardcode)
 *  - x-mp-ts (timestamp ms) + x-mp-sig (HMAC SHA256 de ts.POST.<path>.sha256(body))
 *
 * @param {Object} params
 * @param {string} params.email                Email del usuario
 * @param {'activar'|'desactivar'} params.accion
 * @param {number} [params.membership_id=7994] ID de la membresía en MemberPress
 * @param {number} [params.importe=29.90]      Importe en euros
 * @returns {Promise<Object>}                  Respuesta JSON del endpoint WP
 */
async function syncMemberpressLibro({ email, accion, membership_id = 7994, importe = 29.90 }) {
  // Validaciones de entrada
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('❌ Email inválido en syncMemberpressLibro');
  }
  if (!['activar', 'desactivar'].includes(accion)) {
    throw new Error("❌ Acción inválida: debe ser 'activar' o 'desactivar'");
  }
  if (!Number.isInteger(membership_id)) {
    throw new Error('❌ membership_id debe ser un número entero');
  }

  // Validación de configuración segura
  if (!API_URL || !API_KEY || !HMAC_SECRET) {
    throw new Error('❌ Configuración MP Sync incompleta: faltan MP_SYNC_API_URL_LIBRO / MP_SYNC_API_KEY / MP_SYNC_HMAC_SECRET');
  }

  // Normalización de importe
  const importeNum = (typeof importe === 'number' && isFinite(importe) && importe > 0)
    ? parseFloat(importe.toFixed(2))
    : 29.90;

  const payload = {
    email,
    accion,
    membership_id,
    importe: importeNum,
  };

  // Firma HMAC (prevención de tampering/replay)
  const ts = String(Date.now());
  const bodyStr = JSON.stringify(payload);
  const bodyHash = crypto.createHash('sha256').update(bodyStr, 'utf8').digest('hex');
  const { pathname } = new URL(API_URL);
  const baseToSign = `${ts}.POST.${pathname}.${bodyHash}`;
  const sig = crypto.createHmac('sha256', HMAC_SECRET).update(baseToSign).digest('hex');

  // 🔎 Debug controlado (activar con MP_SYNC_DEBUG=1)
  if (MP_SYNC_DEBUG) {
    const maskTail = (s) => (s ? `••••${String(s).slice(-4)}` : null);
    console.log('[MP DEBUG OUT]', {
      url: API_URL,
      path: pathname,
      ts,
      bodyHash10: bodyHash.slice(0, 10),
      sig10: sig.slice(0, 10),
      apiKeyMasked: maskTail(API_KEY),
    });
  }

  // Log mínimo operativo
  console.log(`📡 [syncMemberpressLibro] '${accion}' → ${email} (ID:${membership_id}, €${importeNum})`);

  let response;
  let text;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'x-mp-ts': ts,
        'x-mp-sig': sig,
      },
      body: bodyStr,
      timeout: 15000, // 15s
    });

    text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (jsonErr) {
      throw new Error(`❌ Respuesta no es JSON válido: ${text.substring(0, 200)}`);
    }

    if (!response.ok) {
      const errorMsg = (data && data.error) ? data.error : (response.statusText || 'HTTP error');
      throw new Error(`❌ Error HTTP ${response.status} en syncMemberpressLibro: ${errorMsg}`);
    }

    console.log(`✅ [MemberPressLibro] '${accion}' OK para ${email}`);
    return data;

  } catch (err) {
    console.error('❌ [syncMemberpressLibro] Error total:', err?.message || err, text ? ` | resp: ${text.substring(0, 200)}` : '');

    // Alerta admin (best-effort)
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
          status: response?.status || null,
          responseTextSnippet: typeof text === 'string' ? text.slice(0, 500) : null,
        },
      });
    } catch {
      // no romper por fallo en alertAdmin
    }

    throw err;
  }
}

module.exports = { syncMemberpressLibro };
