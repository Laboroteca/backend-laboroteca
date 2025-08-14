// 📂 /regalos/services/memberpress.js
const axios = require('axios');

// ============================
// 🔍 CONFIGURACIÓN BASE
// ============================
const SITE_URL = (process.env.MP_SITE_URL || process.env.WP_BASE_URL || 'https://www.laboroteca.es')
  .replace(/\/+$/, '');
const MP_KEY = process.env.MEMBERPRESS_KEY || '';

console.log("🛠 MemberPress config:");
console.log("   📍 SITE_URL =", SITE_URL);
console.log("   🔑 MEMBERPRESS_KEY =", MP_KEY ? `${MP_KEY} (OK)` : "(VACÍO)");

// ============================
// 🔗 CLIENTE AXIOS
// ============================
const mp = axios.create({
  baseURL: `${SITE_URL}/wp-json/mp/v1`,
  timeout: 15000,
});

// ============================
// 📝 CABECERAS SOLO CON API KEY
// ============================
function buildHeaders() {
  if (!MP_KEY) throw new Error('Falta MEMBERPRESS_KEY en variables de entorno');
  return {
    Accept: 'application/json',
    'MEMBERPRESS-API-KEY': MP_KEY
  };
}

// ============================
// 🔍 OBTENER PRIMER MIEMBRO
// ============================
function pickFirstMember(respData) {
  if (Array.isArray(respData)) return respData[0] || null;
  if (respData && Array.isArray(respData.data)) return respData.data[0] || null;
  return null;
}

// ============================
// 🔍 BUSCAR MIEMBRO POR EMAIL
// ============================
async function getMemberByEmail(email) {
  console.log(`🔎 Buscando miembro por email en MemberPress: ${email}`);
  const headers = buildHeaders();
  const params = { search: email };

  try {
    const { data } = await mp.get('/members', { headers, params });
    const member = pickFirstMember(data);
    if (member) {
      console.log(`✅ Usuario encontrado: ID=${member.id}, Email=${member.email || 'N/A'}`);
    } else {
      console.warn(`⚠️ Usuario no encontrado para email: ${email}`);
    }
    return member;
  } catch (err) {
    console.error(`❌ Error buscando miembro (${email}):`, err.message);
    if (err.response) {
      console.error('🔍 Status:', err.response.status);
      console.error('🔍 Body:', err.response.data);
    }
    throw err;
  }
}

// ============================
// 🟢 ACTIVAR MEMBRESÍA
// ============================
async function activarMembresiaEnMemberPress(email, membershipId) {
  if (!email) throw new Error('Falta email');
  if (!membershipId) throw new Error('Falta membershipId');

  const member = await getMemberByEmail(email);
  if (!member || !member.id) {
    throw new Error(`Usuario no encontrado en MemberPress por email: ${email}`);
  }

  const headers = {
    ...buildHeaders(),
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  const body = new URLSearchParams({
    member: String(member.id),
    membership: String(membershipId),
    amount: '0',
    total: '0',
    status: 'complete',
    gateway: 'manual',
  });

  console.log(`📡 Creando transacción manual: memberId=${member.id}, membershipId=${membershipId}`);

  try {
    const { data } = await mp.post('/transactions', body, { headers });
    console.log(`✅ MP: membresía ${membershipId} activada para ${email} (memberId=${member.id})`);
    return data;
  } catch (err) {
    console.error('❌ Error activando membresía (transactions):', err.message);
    if (err.response) {
      console.error('🔍 Status:', err.response.status);
      console.error('🔍 Headers:', err.response.headers);
      console.error('🔍 Body:', err.response.data);
    }
    throw new Error(typeof err.response?.data === 'string'
      ? err.response.data
      : JSON.stringify(err.response?.data || err.message));
  }
}

module.exports = {
  activarMembresiaEnMemberPress,
  activarMembresia: activarMembresiaEnMemberPress,
};

