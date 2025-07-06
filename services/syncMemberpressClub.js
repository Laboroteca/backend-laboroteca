// services/syncMemberpressClub.js

const fetch = require('node-fetch');

const API_KEY = 'laboroteca_club_sync_2024supersegura';
const API_URL = 'https://www.laboroteca.es/wp-json/laboroteca/v1/club-membership/';

/**
 * Sincroniza una membresía en MemberPress (activar o desactivar).
 * @param {Object} params
 * @param {string} params.email - Email del usuario
 * @param {string} params.accion - 'activar' o 'desactivar'
 * @param {number} params.membership_id - ID de la membresía en MemberPress
 * @param {number} [params.importe] - Importe (opcional)
 * @returns {Promise<Object>} - Respuesta del servidor
 */
async function syncMemberpressClub({ email, accion, membership_id, importe }) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('❌ Email inválido en syncMemberpressClub');
  }

  if (!['activar', 'desactivar'].includes(accion)) {
    throw new Error("❌ Acción inválida: debe ser 'activar' o 'desactivar'");
  }

  if (!Number.isInteger(membership_id)) {
    throw new Error('❌ membership_id debe ser un número entero');
  }

  const payload = { email, accion, membership_id };
  if (typeof importe === 'number' && !isNaN(importe)) {
    payload.importe = importe;
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY
    },
    body: JSON.stringify(payload)
  });

  let data;
  try {
    data = await response.json();
  } catch (err) {
    throw new Error(`❌ No se pudo parsear respuesta JSON: ${err.message}`);
  }

  if (!response.ok) {
    throw new Error(`❌ Error HTTP ${response.status}: ${JSON.stringify(data)}`);
  }

  console.log(`✅ [MemberPress] ${accion} completado para ${email}`);
  return data;
}

module.exports = { syncMemberpressClub };
