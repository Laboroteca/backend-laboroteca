// 📁 services/eliminarUsuarioWordPress.js
'use strict';

const fetch = require('node-fetch');
const crypto = require('crypto');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

// ───────────────── Config (ajustables por ENV) ─────────────────
const WP_BASE = process.env.WP_BASE_URL || 'https://www.laboroteca.es';
const DELETE_PATH = process.env.WP_DELETE_USER_PATH || '/wp-json/laboroteca/v1/eliminar-usuario';
const VERIFY_PATH = process.env.WP_USER_EXISTS_PATH || '/wp-json/laboroteca/v1/usuario-existe';
const API_KEY = process.env.LABOROTECA_API_KEY || '';
const HMAC_SECRET = process.env.LAB_BAJA_HMAC_SECRET || process.env.LAB_ELIM_HMAC_SECRET || '';
const VERIFY_DELETE = String(process.env.WP_VERIFY_DELETE || 'true').toLowerCase() === 'true';
const TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS || 12000);

// PII helpers
const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const maskEmail = (e='') => {
  const [u,d] = String(e).split('@');
  if (!u || !d) return '***';
  return `${u.slice(0,2)}***@***${d.slice(Math.max(0,d.length-3))}`;
};

// HMAC v2: ts.POST.<path>.<sha256(body)>
function signBody(path, bodyRaw) {
  if (!HMAC_SECRET) return { ts: String(Date.now()), sig: '' };
  const tsSec = Math.floor(Date.now() / 1000);
  const bodyHash = crypto.createHash('sha256').update(String(bodyRaw || ''), 'utf8').digest('hex');
  const sig = crypto.createHmac('sha256', HMAC_SECRET)
    .update(`${tsSec}.POST.${path}.${bodyHash}`).digest('hex');
  return { ts: String(tsSec), sig };
}

// Robust fetch con timeout
async function fetchJSON(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    let data = null;
    try { data = await res.json(); } catch { /* puede venir HTML/ vacío */ }
    return { res, data };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Elimina un usuario en WordPress (por email) con verificación estricta.
 * Requiere que el endpoint de WP realmente ejecute wp_delete_user() y devuelva { ok:true, deleted:true, user_id,... }.
 * Además, si WP_VERIFY_DELETE=true, se consulta VERIFY_PATH para garantizar que ya no existe.
 *
 * @param {string} email
 * @returns {Promise<{ok: boolean, mensaje?: string}>}
 */
async function eliminarUsuarioWordPress(email) {
  const emailNorm = lower(email);
  if (!emailNorm || !emailNorm.includes('@')) {
    return { ok: false, mensaje: 'Email inválido' };
  }

  try {
    // 1) Llamada de borrado
    const bodyObj = { email: emailNorm, strict: true };
    const bodyRaw = JSON.stringify(bodyObj);
    const { ts, sig } = signBody(DELETE_PATH, bodyRaw);

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key'   : API_KEY,
      'x-lab-ts'    : ts,
      'x-lab-sig'   : sig,
      // compat (algunos endpoints tuyos leen ambas familias):
      'x-mp-ts'     : ts,
      'x-mp-sig'    : sig,
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {})
    };

    const { res, data } = await fetchJSON(`${WP_BASE}${DELETE_PATH}`, {
      method: 'POST',
      headers,
      body: bodyRaw
    });

    // 2) Validación dura de la respuesta del endpoint WP
    const okHttp = res.ok;
    const okFlag = !!(data && (data.ok === true || data.success === true));
    const deletedFlag = !!(data && (data.deleted === true || data.wp_deleted === true || data.user_deleted === true || data.status === 'deleted' || data.result === 'deleted'));
    const userIdNum = (data && Number.isFinite(+data.user_id)) ? +data.user_id : null;

    if (!okHttp || !okFlag || !deletedFlag) {
      const msg = (data && (data.mensaje || data.error)) || `HTTP ${res.status} sin confirmación de borrado`;
      console.warn(`⚠️ Fallo al eliminar usuario (${maskEmail(emailNorm)}):`, msg);
      try {
        await alertAdmin({
          area: 'wp_eliminar_usuario_fail',
          email: emailNorm,
          err: { message: msg },
          meta: {
            status: res.status,
            body: data,
            sentHeaders: { hasApiKey: !!API_KEY, hasHmac: !!HMAC_SECRET, path: DELETE_PATH }
          }
        });
      } catch {}
      return { ok: false, mensaje: msg };
    }

    // 3) Verificación secundaria (opcional pero recomendada)
    if (VERIFY_DELETE) {
      const verifyBody = JSON.stringify({ email: emailNorm });
      const s2 = signBody(VERIFY_PATH, verifyBody);
      const verifyHeaders = {
        'Content-Type': 'application/json',
        'x-api-key'   : API_KEY,
        'x-lab-ts'    : s2.ts,
        'x-lab-sig'   : s2.sig,
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {})
      };
      const { res: vRes, data: vData } = await fetchJSON(`${WP_BASE}${VERIFY_PATH}`, {
        method: 'POST',
        headers: verifyHeaders,
        body: verifyBody
      });

      // Aceptamos 404 del endpoint de verificación como “no disponible”; solo si existe y afirma "exists:true" lo tratamos como fallo.
      if (vRes && vRes.ok && vData && typeof vData.exists === 'boolean') {
        if (vData.exists === true) {
          const vMsg = `Verificación fallida: el usuario todavía existe en WP (id=${vData.user_id ?? '¿?'})`;
          console.warn(`⚠️ ${vMsg} — ${maskEmail(emailNorm)}`);
          try {
            await alertAdmin({
              area: 'wp_eliminar_usuario_verify_fail',
              email: emailNorm,
              err: { message: vMsg },
              meta: { verifyBody: vData, deletedUserId: userIdNum }
            });
          } catch {}
          return { ok: false, mensaje: vMsg };
        }
      }
    }

    console.log(`🗑️ Usuario eliminado en WordPress: ${maskEmail(emailNorm)}${userIdNum ? ` (id:${userIdNum})` : ''}`);
    return { ok: true };

  } catch (err) {
    console.error('❌ Error al conectar con WordPress:', err?.message || String(err));
    try {
      await alertAdmin({
        area: 'wp_eliminar_usuario_error',
        email: lower(email),
        err: { message: err?.message || String(err) },
        meta: {}
      });
    } catch {}
    return { ok: false, mensaje: 'No se pudo conectar con WordPress' };
  }
}

module.exports = { eliminarUsuarioWordPress };
