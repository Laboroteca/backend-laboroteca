const fetch = require('node-fetch');

const API_KEY = 'laboroteca_club_sync_2024supersegura';
const API_URL = 'https://www.laboroteca.es/wp-json/laboroteca/v1/club-membership';

/**
 * Sincroniza una membresía en MemberPress (activar o desactivar).
 * @param {Object} params
 * @param {string} params.email - Email del usuario
 * @param {string} params.accion - 'activar' o 'desactivar'
 * @param {number} params.membership_id - ID de la membresía en MemberPress
 * @param {number} [params.importe] - Importe en euros (opcional, por defecto 9.99)
 * @returns {Promise<Object>} - Respuesta del servidor
 */
async function syncMemberpressClub({ email, accion, membership_id, importe = 9.99 }) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('❌ Email inválido en syncMemberpressClub');
  }
  if (!['activar', 'desactivar'].includes(accion)) {
    throw new Error("❌ Acción inválida: debe ser 'activar' o 'desactivar'");
  }
  if (!Number.isInteger(membership_id)) {
    throw new Error('❌ membership_id debe ser un número entero');
  }

  const payload = {
    email,
    accion,
    membership_id,
    importe: typeof importe === 'number' && importe > 0 ? parseFloat(importe.toFixed(2)) : 9.99
  };

  console.log('⏩ [syncMemberpressClub] Payload enviado:', JSON.stringify(payload));

  let response, text, data;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: JSON.stringify(payload),
      timeout: 15000
    });

    text = await response.text();
    try {
      data = JSON.parse(text);
    } catch (jsonErr) {
      throw new Error(`❌ Respuesta no es JSON válido: ${text.substring(0, 200)}`);
    }

    if (!response.ok) {
      const errorMsg = (data && data.error) ? data.error : response.statusText;
      throw new Error(`❌ Error HTTP ${response.status} en syncMemberpressClub: ${errorMsg}`);
    }

    console.log(`✅ [MemberPress] Acción '${accion}' completada para ${email}:`, data);
    return data;

  } catch (err) {
    console.error(`❌ [syncMemberpressClub] Error total:`, err.message || err, text || '');
    throw err;
  }
}

module.exports = { syncMemberpressClub };
