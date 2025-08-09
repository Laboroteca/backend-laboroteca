const axios = require('axios');

const SITE_URL = process.env.WP_BASE_URL || 'https://www.laboroteca.es';
const MEMBERPRESS_KEY = process.env.MEMBERPRESS_KEY;

async function activarMembresiaEnMemberPress(email, membershipId) {
  if (!MEMBERPRESS_KEY) {
    throw new Error('Falta MEMBERPRESS_KEY en variables de entorno');
  }
  if (!email || !membershipId) {
    throw new Error('Faltan email o membershipId');
  }

  try {
    const url = `${SITE_URL}/wp-json/mp/v1/memberships/${membershipId}/add-member`;
    const { data } = await axios.post(
      url,
      { email },
      {
        headers: {
          'Authorization': `Bearer ${MEMBERPRESS_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
    console.log(`✅ MemberPress: activada membresía ${membershipId} para ${email}`);
    return data;
  } catch (err) {
    const msg = err?.response?.data || err.message;
    console.error('❌ Error activando membresía:', msg);
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
}

// Export compatible con ambos nombres usados en tu código
module.exports = {
  activarMembresiaEnMemberPress,
  activarMembresia: activarMembresiaEnMemberPress,
};
