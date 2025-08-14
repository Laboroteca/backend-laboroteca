// 📂 Ruta: /regalos/services/memberpress.js
const axios = require('axios');

// 🔧 URL base (prioriza MP_SITE_URL, luego WP_BASE_URL y por último dominio fijo)
const SITE_URL =
  (process.env.MP_SITE_URL || process.env.WP_BASE_URL || 'https://www.laboroteca.es')
    .replace(/\/+$/, '');

// 🔐 Credenciales
const MP_KEY  = process.env.MEMBERPRESS_KEY || ''; // DEVELOPER TOOLS → REST API
const MP_USER = process.env.MP_ADMIN_USER || '';   // fallback (no recomendado)
const MP_PASS = process.env.MP_ADMIN_PASS || '';   // fallback (no recomendado)

// Cliente axios apuntando a la REST de MemberPress
const mp = axios.create({
  baseURL: `${SITE_URL}/wp-json/mp/v1`,
  timeout: 15000,
});

// Cabeceras comunes: API Key y (opcional) Basic Auth como respaldo
function buildHeaders() {
  const headers = { Accept: 'application/json' };
  if (MP_KEY) headers['MEMBERPRESS-API-KEY'] = MP_KEY;

  if (MP_USER && MP_PASS) {
    const basic = Buffer.from(`${MP_USER}:${MP_PASS}`).toString('base64');
    headers['Authorization'] = `Basic ${basic}`;
  }
  return headers;
}

// 🧭 Util: intenta parsear respuesta que puede venir como array o envuelta
function pickFirstMember(respData) {
  // Algunos endpoints devuelven array; otros { success, data: [...] }
  if (Array.isArray(respData)) return respData[0] || null;
  if (respData && Array.isArray(respData.data)) return respData.data[0] || null;
  return null;
}

/**
 * 🔎 Obtiene el miembro por email (MemberPress → WP user) para extraer su ID
 * @returns {Promise<{id:number,email:string,username?:string}|null>}
 */
async function getMemberByEmail(email) {
  const headers = buildHeaders();
  const url = `/members`;
  const params = { search: email };

  const { data } = await mp.get(url, { headers, params });
  return pickFirstMember(data);
}

/**
 * 🟢 Activa una membresía creando una Transaction manual (0 €, complete, manual)
 * @param {string} email - Email del usuario en WordPress/MemberPress
 * @param {number|string} membershipId - ID de la membresía (p.ej. 12009)
 * @returns {Promise<Object>} - Objeto transaction devuelto por MemberPress
 */
async function activarMembresiaEnMemberPress(email, membershipId) {
  if (!email) throw new Error('Falta email');
  if (!membershipId) throw new Error('Falta membershipId');

  if (!MP_KEY && !(MP_USER && MP_PASS)) {
    throw new Error('Faltan credenciales: define MEMBERPRESS_KEY o (MP_ADMIN_USER + MP_ADMIN_PASS)');
  }

  // 1) Buscar el miembro por email
  const member = await getMemberByEmail(email);
  if (!member || !member.id) {
    throw new Error(`Usuario no encontrado en MemberPress por email: ${email}`);
  }

  // 2) Crear Transaction manual a 0 € para conceder acceso inmediato
  const headers = {
    ...buildHeaders(),
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  const body = new URLSearchParams({
    member: String(member.id),         // ← ID de usuario WP
    membership: String(membershipId),  // ← ID de la membresía
    amount: '0',
    total: '0',
    status: 'complete',
    gateway: 'manual',
  });

  try {
    const { data } = await mp.post('/transactions', body, { headers });
    // Éxito → acceso concedido
    console.log(`✅ MP: membresía ${membershipId} activada para ${email} (memberId=${member.id})`);
    return data;
  } catch (err) {
    const msg = err?.response?.data || err.message;
    console.error('❌ Error activando membresía (transactions):', msg);
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
}

// Alias para mantener compatibilidad con tu código previo
module.exports = {
  activarMembresiaEnMemberPress,
  activarMembresia: activarMembresiaEnMemberPress,
};
