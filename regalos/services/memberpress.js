const axios = require('axios');
const MEMBERPRESS_KEY = process.env.MEMBERPRESS_KEY;
const SITE_URL = 'https://www.laboroteca.es';

async function activarMembresiaEnMemberPress(email, membershipId) {
  try {
    const res = await axios.post(`${SITE_URL}/wp-json/mp/v1/memberships/${membershipId}/add-member`, {
      email,
    }, {
      headers: {
        'Authorization': `Bearer ${MEMBERPRESS_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`✅ Miembro activado en MemberPress (${membershipId})`);
    return res.data;
  } catch (err) {
    console.error('❌ Error activando membresía:', err?.response?.data || err.message);
    throw err;
  }
}

module.exports = { activarMembresiaEnMemberPress };
