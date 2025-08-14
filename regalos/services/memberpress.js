// 📂 Ruta: /regalos/services/memberpress.js
const axios = require('axios');

// 🔧 URL base (prioriza MP_SITE_URL, luego WP_BASE_URL y por último dominio fijo)
const SITE_URL =
  (process.env.MP_SITE_URL || process.env.WP_BASE_URL || 'https://www.laboroteca.es')
    .replace(/\/+$/, '');

// 🔐 Credenciales
const MP_KEY  = process.env.MEMBERPRESS_KEY || ''; // Developer Tools → REST API
const MP_USER = process.env.MP_ADMIN_USER || '';   // Fallback opcional
const MP_PASS = process.env.MP_ADMIN_PASS || '';   // Fallback opcional

// Cliente axios apuntando a la REST de MemberPress
const mp = axios.create({
  baseURL: `${SITE_URL}/wp-json/mp/v1`,
  timeout: 15000,
});

// 📌 Cabeceras comunes: API Key y (opcional) Basic Auth como respaldo
function buildHeaders() {
  const headers = { Accept: 'application/json' };

  if (MP_KEY) {
    headers['MEMBERPRESS-API-KEY'] = MP_KEY;
  }

  if (MP_USER && MP_PASS) {
    const basic = Buffer.from(`${MP_USER}:${MP_PASS}`).toString('base64');
    headers['Authorization'] = `Basic ${basic}`;
  }

  return headers;
}

// 📌 Utilidad para parsear respuestas de miembros
function pickFirstMember(respData) {
  if (Array.isArray(respData)) return respData[0] || null;
  if (respData && Array.isArray(respData.data)) return respData.data[0] || null;
  return null;
}

/**
 * 🔍 Obtiene el miembro por email en MemberPress
 */
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

/**
 * 🟢 Activa una membresía creando una Transaction manual (0 €, complete, manual)
 */
async function activarMembresiaEnMemberPress(email, membershipId) {
  if (!email) throw new Error('Falta email');
  if (!membershipId) throw new Error('Falta membershipId');

  if (!MP_KEY && !(MP_USER && MP_PASS)) {
    throw new Error('Faltan credenciales: define MEMBERPRESS_KEY o (MP_ADMIN_USER + MP_ADMIN_PASS)');
  }

  // 1️⃣ Buscar miembro
  const member = await getMemberByEmail(email);
  if (!member || !member.id) {
    throw new Error(`Usuario no encontrado en MemberPress por email: ${email}`);
  }

  // 2️⃣ Crear Transaction manual
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
