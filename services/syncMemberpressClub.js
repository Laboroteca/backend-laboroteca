// services/syncMemberpressClub.js

const fetch = require('node-fetch');

const API_KEY = 'laboroteca_club_sync_2024supersegura';
const API_URL = 'https://www.laboroteca.es/wp-json/laboroteca/v1/club-membership/';

/**
 * Sincroniza la membresía en MemberPress (activar o desactivar).
 * @param {Object} params
 * @param {string} params.email - Email del usuario
 * @param {string} params.accion - 'activar' o 'desactivar'
 * @param {number} params.membership_id - ID de la membresía en MemberPress
 * @returns {Promise<Object>} - Respuesta del servidor
 */
async function syncMemberpressClub({ email, accion, membership_id }) {
  // ✅ Validaciones robustas
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('Email inválido en syncMemberpressClub');
  }

  if (!['activar', 'desactivar'].includes(accion)) {
    throw new Error("La acción debe ser 'activar' o 'desactivar'");
  }

  if (!Number.isInteger(membership_id)) {
    throw new Error('membership_id debe ser un número entero');
  }

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify({ email, accion, membership_id })
    });

    let data;
    try {
      data = await response.json();
    } catch (jsonErr) {
      throw new Error(`No se pudo parsear respuesta JSON: ${jsonErr.message}`);
    }

    if (!response.ok) {
      throw new Error(`Error HTTP ${response.status}: ${JSON.stringify(data)}`);
    }

    console.log(`✅ [MemberPress] ${accion} completado para ${email}`);
    return data;
  } catch (error) {
    console.error(`❌ Error al sincronizar MemberPress (${accion}):`, error.message || error);
    throw error;
  }
}

module.exports = { syncMemberpressClub };
