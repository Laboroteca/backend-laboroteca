// 📁 services/eliminarUsuarioWordPress.js
const fetch = require('node-fetch');

/**
 * Elimina un usuario en WordPress desde su email y contraseña.
 * Requiere un endpoint personalizado con permisos administrativos.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<void>}
 */
async function eliminarUsuarioWordPress(email, password) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('❌ Email inválido al intentar eliminar usuario');
  }
  if (!password || typeof password !== 'string') {
    throw new Error('❌ Contraseña no proporcionada');
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
      console.error('❌ Error al eliminar usuario en WP:', data);
      const msg = data?.error || 'Error al eliminar usuario en WordPress';
      throw new Error(msg);
    }
  } catch (err) {
    console.error('❌ Error conexión WP:', err);
    throw err;
  }
}

module.exports = { eliminarUsuarioWordPress };
