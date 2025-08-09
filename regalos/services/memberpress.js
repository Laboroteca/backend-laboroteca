// 📂 Ruta: /regalos/services/memberpress.js

const axios = require('axios');

const SITE_URL = process.env.WP_BASE_URL || 'https://www.laboroteca.es';
const MEMBERPRESS_KEY = process.env.MEMBERPRESS_KEY;

/**
 * Activa una membresía de MemberPress para el email indicado.
 * 
 * @param {string} email - Email del usuario
 * @param {number|string} membershipId - ID numérico de la membresía en MemberPress
 */
async function activarMembresiaEnMemberPress(email, membershipId) {
  if (!MEMBERPRESS_KEY) {
    throw new Error('❌ Falta MEMBERPRESS_KEY en variables de entorno.');
  }
  if (!email || !membershipId) {
    throw new Error('❌ Faltan parámetros obligatorios: email y membershipId.');
  }

  const emailNormalizado = String(email).trim().toLowerCase();
  const idNum = Number(membershipId);

  if (!idNum) {
    throw new Error(`❌ membershipId inválido: ${membershipId}`);
  }

  try {
    const url = `${SITE_URL}/wp-json/mp/v1/memberships/${idNum}/add-member`;
    const { data } = await axios.post(
      url,
      { email: emailNormalizado },
      {
        headers: {
          Authorization: `Bearer ${MEMBERPRESS_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    console.log(`✅ MemberPress: membresía ${idNum} activada para ${emailNormalizado}`);
    return data;
  } catch (err) {
    const msg = err?.response?.data || err.message;
    console.error(`❌ Error activando membresía ${membershipId} para ${emailNormalizado}:`, msg);
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
}

module.exports = {
  activarMembresiaEnMemberPress,
  activarMembresia: activarMembresiaEnMemberPress, // Alias por compatibilidad
};
