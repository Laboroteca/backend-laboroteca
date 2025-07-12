// 📁 services/eliminarUsuarioWordPress.js
const fetch = require('node-fetch');

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
      body: JSON.stringify({ email })
    });

    const data = await res.json();

    if (!res.ok || !data?.ok) {
      const msg = data?.mensaje || data?.error || 'Error al eliminar usuario en WordPress';
      console.warn(`⚠️ Fallo al eliminar usuario (${email}):`, msg);
      return { ok: false, mensaje: msg };
    }

    console.log(`🗑️ Usuario eliminado en WordPress: ${email}`);
    return { ok: true };

  } catch (err) {
    console.error('❌ Error al conectar con WordPress:', err.message);
    return { ok: false, mensaje: 'No se pudo conectar con WordPress' };
  }
}

module.exports = { eliminarUsuarioWordPress };
