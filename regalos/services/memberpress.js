// 📂 /regalos/services/memberpress.js
const axios = require('axios');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

// ============================
// 🔍 CONFIGURACIÓN BASE
// ============================
const SITE_URL = (process.env.MP_SITE_URL || process.env.WP_BASE_URL || 'https://www.laboroteca.es')
  .replace(/\/+$/, '');
const MP_KEY = process.env.MEMBERPRESS_KEY || '';

console.log('🛠 MemberPress config:');
console.log('   📍 SITE_URL =', SITE_URL);
// 🔒 No exponemos la API key completa en logs
function maskSecret(s) {
  if (!s) return '(VACÍO)';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 2)}…${s.slice(-2)}`;
}
console.log('   🔑 MEMBERPRESS_KEY =', maskSecret(MP_KEY));

// 🔒 Redactar emails en trazas (RGPD): logs ≠ PII. En alertas mantenemos el email completo.
function redactEmail(e) {
  const s = String(e || '').toLowerCase();
  if (!s.includes('@')) return s ? '***' : '';
  const [u, d] = s.split('@');
  return `${u.slice(0, 2)}***@***${d.slice(-3)}`;
}

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
  console.log(`🔎 Buscando miembro por email en MemberPress: ${redactEmail(email)}`);
  let headers;
  try {
    headers = buildHeaders();
  } catch (e) {
    try {
      // En alertas sí enviamos el email completo (canal controlado)
      await alertAdmin({
        area: 'memberpress.build_headers_missing_key',
        err: e,
        meta: { email }
      });
    } catch (_) {}
    throw e;
  }
  const params = { search: email };

  try {
    const { data } = await mp.get('/members', { headers, params });
    const member = pickFirstMember(data);
    if (member) {
      console.log(`✅ Usuario encontrado: ID=${member.id}, Email=${redactEmail(member.email || '')}`);
    } else {
      console.warn(`⚠️ Usuario no encontrado para email: ${redactEmail(email)}`);
    }
    return member;
  } catch (err) {
    console.error(`❌ Error buscando miembro (${redactEmail(email)}):`, err.message);
    if (err.response) {
      // 🔒 No volcar cuerpos de respuesta (pueden contener PII)
      console.error('🔍 Status:', err.response.status);
      console.error('🔍 Body: [REDACTED]');
    }
    try {
      await alertAdmin({
        area: 'memberpress.get_member_error',
        err,
        meta: {
          email,
          status: err?.response?.status ?? null
        }
      });
    } catch (_) {}
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
    try {
      await alertAdmin({
        area: 'memberpress.member_not_found',
        err: new Error('Usuario no encontrado en MemberPress'),
        meta: { email, membershipId }
      });
    } catch (_) {}
    // 🔒 Mensaje genérico hacia fuera (no PII)
    throw new Error('Usuario no encontrado en MemberPress por email indicado');
  }

  let headers;
  try {
    headers = {
      ...buildHeaders(),
      'Content-Type': 'application/x-www-form-urlencoded',
    };
  } catch (e) {
    try {
      await alertAdmin({
        area: 'memberpress.build_headers_missing_key',
        err: e,
        meta: { email, membershipId }
      });
    } catch (_) {}
    throw e;
  }

  const body = new URLSearchParams({
    member: String(member.id),
    membership: String(membershipId),
    amount: '0',
    total: '0',
    status: 'complete',
    gateway: 'manual',
  });

  console.log(`📡 Creando transacción manual: memberId=${member.id}, membershipId=${membershipId} para ${redactEmail(email)}`);

  try {
    const { data } = await mp.post('/transactions', body, { headers });
    console.log(`✅ MP: membresía ${membershipId} activada para ${redactEmail(email)} (memberId=${member.id})`);
    return data;
  } catch (err) {
    console.error('❌ Error activando membresía (transactions):', err.message);
    if (err.response) {
      // 🔒 No loguear headers/body completos (podrían incluir datos personales)
      console.error('🔍 Status:', err.response.status);
      console.error('🔍 Body: [REDACTED]');
    }
    try {
      await alertAdmin({
        area: 'memberpress.transaction_error',
        err,
        meta: {
          email,
          membershipId,
          memberId: member?.id ?? null,
          status: err?.response?.status ?? null
        }
      });
    } catch (_) {}
    // 🔒 Mensaje genérico hacia fuera (evita propagar PII del backend)
    throw new Error(`Fallo al activar la membresía (status ${err?.response?.status || 'ERR'})`);
  }
}

module.exports = {
  activarMembresiaEnMemberPress,
  activarMembresia: activarMembresiaEnMemberPress,
};

