// 📁 services/eliminarUsuarioWordPress.js
const fetch = require('node-fetch');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

// PII helpers
const lower = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const maskEmail = (e='') => {
  const [u,d] = String(e).split('@');
  if (!u || !d) return '***';
  return `${u.slice(0,2)}***@***${d.slice(Math.max(0,d.length-3))}`;
};

/**
 * Elimina un usuario en WordPress desde su email.
 * @param {string} email
 * @returns {Promise<{ok: boolean, mensaje?: string}>}
 */
async function eliminarUsuarioWordPress(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { ok: false, mensaje: 'Email inválido' };
  }

  try {
    // --- Auth headers: este endpoint usa la misma pareja que MemberPress ---
    const apiKey = process.env.MP_SYNC_API_KEY || '';
    const secret = process.env.MP_SYNC_HMAC_SECRET || '';
    const path   = '/wp-json/laboroteca/v1/eliminar-usuario';

    const bodyObj  = { email: lower(email) };
    const bodyRaw  = JSON.stringify(bodyObj);
    const bodyHash = require('crypto').createHash('sha256').update(bodyRaw,'utf8').digest('hex');
    const ts       = String(Date.now());
    const sig      = secret
      ? require('crypto').createHmac('sha256', secret).update(`${ts}.POST.${path}.${bodyHash}`).digest('hex')
      : '';

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key'   : apiKey,
      'x-mp-ts'     : ts,
      'x-mp-sig'    : sig,
      'x-lab-ts'    : ts,
      'x-lab-sig'   : sig,
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    };

    const res = await fetch(`https://www.laboroteca.es${path}`, {
      method: 'POST',
      headers,
      body: bodyRaw
    });

    let data = {};
    try {
      data = await res.json();
    } catch (_) {
      // si WP devuelve HTML (403 Forbidden), evitamos crash
      data = {};
    }

    if (!res.ok || !data?.ok) {
      const msg = data?.mensaje || data?.error || (res.status === 401 || res.status === 403
                   ? 'No autorizado'
                   : `HTTP ${res.status} al eliminar usuario en WP`);
      console.warn(`⚠️ Fallo al eliminar usuario (${maskEmail(email)}):`, msg);
      try {
        await alertAdmin({
          area: 'wp_eliminar_usuario_fail',
          email: lower(email),
          err: { message: msg },
          meta: {
            status: res.status,
            body: data,
            sentHeaders: { hasApiKey: !!apiKey, path }
          }
        });
      } catch (_) {}
      return { ok: false, mensaje: msg };
    }

    console.log(`🗑️ Usuario eliminado en WordPress: ${maskEmail(email)}`);
    return { ok: true };

  } catch (err) {
    console.error('❌ Error al conectar con WordPress:', err.message);
    // Aviso opcional al admin con email completo
    try {
      await alertAdmin({
        area: 'wp_eliminar_usuario_error',
        email: lower(email),
        err: { message: err?.message },
        meta: {}
      });
    } catch (_) {}
    return { ok: false, mensaje: 'No se pudo conectar con WordPress' };
  }
}

module.exports = { eliminarUsuarioWordPress };
