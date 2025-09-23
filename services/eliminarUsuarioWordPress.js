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
    const res = await fetch('https://www.laboroteca.es/wp-json/laboroteca/v1/eliminar-usuario', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.LABOROTECA_API_KEY
      },
      body: JSON.stringify({ email: lower(email) })
    });

    const data = await res.json();

    if (!res.ok || !data?.ok) {
      const msg = data?.mensaje || data?.error || 'Error al eliminar usuario en WordPress';
      console.warn(`⚠️ Fallo al eliminar usuario (${maskEmail(email)}):`, msg);
      // Aviso opcional al admin con email completo
      try {
        await alertAdmin({
          area: 'wp_eliminar_usuario_fail',
          email: lower(email),                 // admin recibe email completo
          err: { message: msg },
          meta: { status: res.status }
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
