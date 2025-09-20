async function emailRegistradoEnWordPress(email) {
  const emailNorm = String(email || '').trim().toLowerCase();
  if (!emailNorm) {
    console.warn('⚠️ emailRegistradoEnWordPress llamado sin email válido');
    return false;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8s timeout

    const response = await fetch(
      'https://www.laboroteca.es/wp-json/laboroteca/v1/existe-usuario',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailNorm }),
        signal: controller.signal
      }
    );
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn('⚠️ Error HTTP verificando email en WP:', {
        status: response.status,
        email: emailNorm
      });
      return false;
    }

    const data = await response.json().catch(() => ({}));
    const existe = Boolean(data.existe);

    console.log(`🔍 Email ${emailNorm} registrado en WordPress: ${existe}`);
    return existe;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('⏱️ Timeout verificando email en WP');
    } else {
      console.error('❌ Error al verificar email en WordPress:', err.message);
    }
    return false;
  }
}

module.exports = { emailRegistradoEnWordPress };