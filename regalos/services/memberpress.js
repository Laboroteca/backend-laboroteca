// 📂 Ruta: /regalos/services/memberpress.js
const axios = require('axios');

// Usa primero MP_SITE_URL si existe, luego WP_BASE_URL y por último el dominio por defecto
const SITE_URL =
  process.env.MP_SITE_URL ||
  process.env.WP_BASE_URL ||
  'https://www.laboroteca.es';

const MP_USER = process.env.MP_ADMIN_USER;   // p.ej. "laborote"
const MP_PASS = process.env.MP_ADMIN_PASS;   // tu pass de WP (la que ya tienes en Railway)

/**
 * Activa una membresía de MemberPress para un email.
 * Autenticación: Basic (usuario + contraseña WP admin).
 */
async function activarMembresiaEnMemberPress(email, membershipId) {
  if (!MP_USER || !MP_PASS) {
    throw new Error('Faltan MP_ADMIN_USER o MP_ADMIN_PASS en variables de entorno');
  }
  if (!email || !membershipId) {
    throw new Error('Faltan email o membershipId');
  }

  // Cabecera Basic Auth
  const basic = Buffer.from(`${MP_USER}:${MP_PASS}`).toString('base64');
  const headers = {
    Authorization: `Basic ${basic}`,
    'Content-Type': 'application/json',
  };

  // Endpoint REST de MemberPress para añadir miembro a una membresía
  const url = `${SITE_URL}/wp-json/mp/v1/memberships/${membershipId}/add-member`;

  try {
    const { data } = await axios.post(
      url,
      { email },
      { headers, timeout: 15000 }
    );
    console.log(`✅ MemberPress: activada membresía ${membershipId} para ${email}`);
    return data;
  } catch (err) {
    const msg = err?.response?.data || err.message;
    console.error('❌ Error activando membresía:', msg);
    // Lanzamos para que el flujo de canje NO consuma el código si falla MP
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
}

// Export compatible con el resto del código
module.exports = {
  activarMembresiaEnMemberPress,
  activarMembresia: activarMembresiaEnMemberPress,
};
