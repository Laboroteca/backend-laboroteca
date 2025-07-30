const fetch = require('node-fetch');

async function emailRegistradoEnWordPress(email) {
  try {
    const response = await fetch('https://www.laboroteca.es/wp-json/laboroteca/v1/existe-usuario', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });

    if (!response.ok) {
      console.warn('⚠️ Error HTTP verificando email en WP:', response.status);
      return false;
    }

    const data = await response.json();
    const existe = !!data.existe;

    console.log(`🔍 Email ${email} registrado en WordPress: ${existe}`);
    return existe;
  } catch (err) {
    console.error('❌ Error al verificar email en WordPress:', err.message);
    return false;
  }
}

module.exports = { emailRegistradoEnWordPress };
