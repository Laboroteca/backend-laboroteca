// 📁 services/eliminarUsuarioWordPress.js
const fetch = require('node-fetch');

/**
 * Elimina un usuario en WordPress desde su email y contraseña.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ok: boolean, mensaje?: string}>}
 */
async function eliminarUsuarioWordPress(email, password) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return { ok: false, mensaje: 'Email inválido' };
  }
  if (!password || typeof password !== 'string') {
    return { ok: false, mensaje: 'Contraseña no proporcionada' };
  }

  try {
    const res = await fetch('https://www.laboroteca.es/wp-json/laboroteca/v1/eliminar-usuario', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.LABOROTECA_API_KEY
      },
      body: JSON.stringify({ email, password })
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      const msg = data?.mensaje || data?.error || 'Error al eliminar usuario en WordPress';
      return { ok: false, mensaje: msg };
    }

    return { ok: true };
  } catch (err) {
    console.error('❌ Error al conectar con WordPress:', err);
    return { ok: false, mensaje: 'No se pudo conectar con WordPress' };
  }
}

module.exports = { eliminarUsuarioWordPress };
