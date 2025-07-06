// services/syncMemberpressLibro.js

const fetch = require('node-fetch');

const API_KEY = 'laboroteca_club_sync_2024supersegura';
const API_URL = 'https://www.laboroteca.es/wp-json/laboroteca/v1/libro-membership/'; // <-- CAMBIA el endpoint aquí

/**
 * Sincroniza la membresía LIBRO en MemberPress (activar/desactivar).
 * @param {Object} params
 * @param {string} params.email - Email del usuario
 * @param {string} params.accion - 'activar' o 'desactivar'
 * @param {number} params.membership_id - ID de la membresía (Libro = 7994)
 * @param {number} [params.importe] - Importe (opcional)
 * @returns {Promise<Object>} - Respuesta del servidor
 */
async function syncMemberpressLibro({ email, accion, membership_id, importe }) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('❌ Email inválido en syncMemberpressLibro');
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

  console.log(`✅ [MemberPress LIBRO] ${accion} completado para ${email}`);
  return data;
}

module.exports = { syncMemberpressLibro };
