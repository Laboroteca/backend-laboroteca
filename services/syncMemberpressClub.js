const fetch = require('node-fetch');
const API_KEY = 'laboroteca_club_sync_2024supersegura';
const API_URL = 'https://www.laboroteca.es/wp-json/laboroteca/v1/club-membership/';

async function syncMemberpressClub({ email, accion, membership_id }) {
  if (!email || !accion || !membership_id) throw new Error('Faltan parámetros');

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
  return data;
}

module.exports = { syncMemberpressClub };
