const fetch = require('node-fetch');

const API_KEY = 'laboroteca_club_sync_2024supersegura';
const API_URL = 'https://www.laboroteca.es/wp-json/laboroteca/v1/club-membership/';

async function syncMemberpressClub({ email, accion }) {
  if (!email || !accion) throw new Error('Faltan parámetros para MemberPress');

  console.log(`🔄 Sync MemberPress: ${accion} | ${email}`);
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY
    },
    body: JSON.stringify({ email, accion })
  });

  const data = await res.json();

  if (!res.ok) {
    console.error('❌ Error MemberPress Sync:', data);
    throw new Error(`Error al sincronizar MemberPress: ${JSON.stringify(data)}`);
  }

  console.log(`✅ Sincronización MemberPress: ${accion} | ${email} =>`, data);
  return data;
}

module.exports = { syncMemberpressClub };
