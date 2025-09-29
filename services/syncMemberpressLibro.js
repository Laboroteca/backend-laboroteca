// services/syncMemberpressLibro.js
'use strict';

const fetch = require('node-fetch'); // ⚠️ Este módulo usa 'timeout' de node-fetch v2. Si pasas a v3, usa AbortController.
const crypto = require('crypto');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

// ⚙️ Config por entorno (no hardcode)
// Preferimos una URL genérica si existe, y mantenemos la legacy como fallback.
const DEFAULT_API_URL = (
  process.env.MP_SYNC_API_URL_PRODUCTO ||
  process.env.MP_SYNC_API_URL_LIBRO ||
  'https://www.laboroteca.es/wp-json/laboroteca/v1/libro-membership'
).trim();
const API_KEY         = (process.env.MP_SYNC_API_KEY || '').trim();
const HMAC_SECRET     = (process.env.MP_SYNC_HMAC_SECRET || '').trim();
const MP_SYNC_DEBUG   = process.env.NODE_ENV !== 'production'
   ? String(process.env.MP_SYNC_DEBUG || '').trim() === '1'
   : String(process.env.MP_SYNC_DEBUG || '').trim() === '1' && String(process.env.ALLOW_DEBUG_IN_PROD || '') === '1';

// ——— utilidades ———
const maskTail = (s) => (s ? `••••${String(s).slice(-4)}` : null);
const maskEmail = (e='') => {
  const [u='', d=''] = String(e).toLowerCase().split('@');
  const tld = d.split('.').pop() || '';
  return `${u.slice(0,2)}***@***.${tld}`;
};
const nowIso   = () => new Date().toISOString();
const shortId  = () => crypto.randomBytes(6).toString('hex');
// Sanitiza PII en snippets de logs (emails)
const sanitizeSnippet = (s='') =>
  String(s).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig,'***@***');

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
 * Sincroniza la membresía en MemberPress (activar o desactivar) para
 * productos de PAGO ÚNICO (no recurrentes).
 * Seguridad:
 *  - x-api-key (.env)
 *  - x-mp-ts (timestamp ms) + x-mp-sig (HMAC SHA256 de ts.POST.<path>.sha256(body))
 *
 * Reutilizable: puedes pasar apiUrl para otros endpoints (producto genérico).
 *
 * @param {Object} params
 * @param {string} params.email                 Email del usuario
 * @param {'activar'|'desactivar'} params.accion
 * @param {number} [params.membership_id=7994]  ID MemberPress del producto (obligatorio en catálogo)
 * @param {number} [params.importe=29.90]       Importe en euros
 * @param {string} [params.apiUrl]              (Opcional) URL del endpoint WP a usar
 * @param {string} [params.producto]            (Opcional) slug/clave normalizada del producto (solo auditoría)
 * @param {string} [params.nombre_producto]     (Opcional) nombre legible del producto (solo auditoría)
 * @returns {Promise<Object>}                   Respuesta JSON del endpoint WP
 */
async function syncMemberpressLibro({
  email,
  accion,
  membership_id = 7994,
  importe = 29.90,
  apiUrl,
  producto,
  nombre_producto
}) {
  // —— Validaciones de entrada
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('❌ Email inválido en syncMemberpressLibro');
  }
  if (!['activar', 'desactivar'].includes(accion)) {
    throw new Error("❌ Acción inválida: debe ser 'activar' o 'desactivar'");
  }
  const membershipIdNum = Number(membership_id);
  if (!Number.isInteger(membershipIdNum) || membershipIdNum <= 0) {
    throw new Error('❌ membership_id debe ser un número entero');
  }

  // —— Config segura obligatoria
  const API_URL = (apiUrl || DEFAULT_API_URL).trim().replace(/\/+$/, ''); // normaliza trailing slash
  if (!API_URL || !API_KEY || !HMAC_SECRET) {
    const missing = [
      !API_URL && 'MP_SYNC_API_URL_PRODUCTO/MP_SYNC_API_URL_LIBRO',
      !API_KEY && 'MP_SYNC_API_KEY',
      !HMAC_SECRET && 'MP_SYNC_HMAC_SECRET'
    ].filter(Boolean).join(', ');
    throw new Error(`❌ Config MP Sync incompleta (${missing})`);
  }

  // —— Normalización de importe
  const importeNum = (typeof importe === 'number' && isFinite(importe) && importe > 0)
    ? parseFloat(importe.toFixed(2))
    : 29.90;

  // —— Payload
  const payload = {
    email,
    accion,
    membership_id: membershipIdNum,
    importe: importeNum,
    // Campos informativos (WP puede ignorarlos; útiles para trazabilidad)
    ...(producto ? { producto } : {}),
    ...(nombre_producto ? { nombre_producto } : {})
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
  console.log(`📡 [syncMemberpressLibro#${reqId}] '${accion}' → ${maskEmail(email)} (ID:${membership_id}, €${importeNum})`);

  // —— Petición
  let response;
  let text;
  try {
    const u = new URL(API_URL);
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'LaborotecaMP/1.0',
        'x-api-key': API_KEY,
        'x-mp-ts': ts,
        'x-mp-sig': sig,
        'x-request-id': reqId
      },
      body: bodyStr,
      timeout: 15000,
      // No sigas redirecciones a ciegas; comprobamos Location a mano.
      redirect: 'manual'
    });

    // —— Gestión explícita de redirecciones
    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get('location') || '';
      const to = new URL(loc, API_URL);
      if (to.protocol !== 'https:' || to.host !== u.host) {
        throw new Error(`❌ Redirección insegura bloqueada: ${loc}`);
      }
      // Relanzamos una sola vez de forma controlada
      response = await fetch(to.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'LaborotecaMP/1.0',
          'x-api-key': API_KEY,
          'x-mp-ts': ts,
          'x-mp-sig': sig,
          'x-request-id': reqId
        },
        body: bodyStr,
        timeout: 15000,
        redirect: 'manual'
      });
    }
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

    console.log(`✅ [MemberPressLibro#${reqId}] '${accion}' OK para ${maskEmail(email)} ${accion === 'activar' ? `(tx=${data.transaction_id})` : ''}`);
    return data;

  } catch (err) {
    // —— Log de error y alerta
   const safeMsg = sanitizeSnippet(String(err?.message || err));
   console.error(
     `❌ [syncMemberpressLibro#${reqId}]`,
     safeMsg,
     text ? `| resp: ${sanitizeSnippet(text).substring(0, 200)}` : ''
   );

    try {
      await alertAdmin({
        area: 'memberpress_libro_sync',
        email, // ← email REAL para soporte
        err: { message: err?.message, code: err?.code, type: err?.type },
        meta: {
          accion,
          membership_id: membershipIdNum,
          importe: importeNum,
          apiUrl: API_URL,
          ts,
          reqId,
          producto: producto || null,
          nombre_producto: nombre_producto || null,
          status: response?.status || null,
          // En alerta mandamos el snippet COMPLETO (sin sanitizar) para diagnóstico
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

// Alias genérico para claridad en el resto del backend (mismo comportamiento)
async function syncMemberpressProducto(params) {
  return syncMemberpressLibro(params);
}

module.exports = { syncMemberpressLibro, syncMemberpressProducto };
