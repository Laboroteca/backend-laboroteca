const fetch = require('node-fetch');

const API_KEY = 'laboroteca_club_sync_2024supersegura';
const API_URL = 'https://www.laboroteca.es/wp-json/laboroteca/v1/libro-membership/';

/**
 * Sincroniza la membresía del libro en MemberPress (activar o desactivar).
 * @param {Object} params
 * @param {string} params.email - Email del usuario
 * @param {string} params.accion - 'activar' o 'desactivar'
 * @param {number} [params.importe] - Importe en euros (opcional, por defecto 29.90)
 * @returns {Promise<Object>} - Respuesta del servidor
 */
async function syncMemberpressLibro({ email, accion, importe = 29.90 }) {
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error('❌ Email inválido en syncMemberpressLibro');
  }

  if (!['activar', 'desactivar'].includes(accion)) {
    throw new Error("❌ Acción inválida: debe ser 'activar' o 'desactivar'");
  }

  const payload = {
    email,
    accion,
    importe: typeof importe === 'number' && importe > 0 ? parseFloat(importe.toFixed(2)) : 29.90
  };

  console.log(`📡 [syncMemberpressLibro] Enviando '${accion}' para ${email} (Importe: ${payload.importe} €)`);

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
    console.error(`❌ Error HTTP ${response.status} en syncMemberpressLibro:`, data);
    throw new Error(`❌ Error en MemberPress Libro: ${JSON.stringify(data)}`);
  }

  console.log(`✅ [MemberPressLibro] Acción '${accion}' completada correctamente para ${email}`);
  return data;
}

module.exports = { syncMemberpressLibro };
