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
 */
async function syncMemberpressClub({ email, accion, membership_id }) {
  if (!email || !accion || !membership_id) {
    throw new Error('Faltan parámetros obligatorios para sincronizar MemberPress');
  }

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify({ email, accion, membership_id })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(`Error al sincronizar MemberPress: ${JSON.stringify(data)}`);
    }

    console.log(`✅ [MemberPress] Acción '${accion}' realizada correctamente para: ${email}`);
    return data;
  } catch (error) {
    console.error('❌ Error al sincronizar con MemberPress:', error);
    throw error;
  }
}

module.exports = { syncMemberpressClub };
