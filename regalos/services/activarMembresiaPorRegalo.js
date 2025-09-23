// 📂 regalos/services/activarMembresiaPorRegalo.js
'use strict';

const { activarMembresia } = require('./memberpress');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

// RGPD: util para enmascarar email en logs
function maskEmail(e='') {
  const s = String(e||''); const i = s.indexOf('@');
  if (i<=0) return s ? '***' : '';
  const u=s.slice(0,i), d=s.slice(i+1);
  const um = u.length<=2 ? (u[0]||'*') : (u.slice(0,2)+'***'+u.slice(-1));
  const dm = d.length<=3 ? '***' : ('***'+d.slice(-3));
  return `${um}@${dm}`;
}
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e||''));

/**
 * Normaliza a "slug" simple: minúsculas, sin acentos, separadores a '-'.
 */
function toSlug(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Mapa de libros → MemberPress productId.
 * Usa slugs como clave para evitar ambigüedades con mayúsculas/acentos.
 * Ajusta aquí si cambian los IDs en tu WP.
 */
const MAP_LIBRO_A_MEMBERSHIP = {
  // Libros principales
  'de-cara-a-la-jubilacion'                          : 7994,
  'adelanta-tu-jubilacion'                           : 11006,

  // Alias razonables para el segundo libro:
  'jubilacion-anticipada'                            : 11006,
  'jubilacion-parcial'                               : 11006,

  // Tercero del selector del shortcode
  'libro-conoce-y-protege-tus-derechos-laborales'   : 7994, // ← Ajusta si corresponde a otro productId
};

/**
 * Activa la membresía adecuada según el libro canjeado.
 * @param {string} email - Email del usuario que ha canjeado el código
 * @param {string} libro - Valor del campo libro_elegido (slug o título)
 */
module.exports = async function activarMembresiaPorRegalo(email, libro) {
  // 🧹 Normalización de datos
  const emailNormalizado = String(email || '').trim().toLowerCase();
  const slugEntrada      = toSlug(libro);

  if (!emailNormalizado || !slugEntrada || !isEmail(emailNormalizado)) {
    throw new Error('Faltan datos para activar la membresía.');
  }

  // 🎯 Resolver membershipId a partir del slug
  const membershipId = MAP_LIBRO_A_MEMBERSHIP[slugEntrada] ?? null;

  if (!membershipId) {
    // Alerta operativa: libro no reconocido (y abortamos)
    try {
      await alertAdmin({
        area: 'regalos.activarMembresiaPorRegalo.libro_desconocido',
        email: emailNormalizado,
        err: new Error('No se reconoce el libro seleccionado.'),
        meta: { email: emailNormalizado, libroOriginal: String(libro || ''), slugCalculado: slugEntrada }
      });
    } catch (_) {}
    throw new Error('No se reconoce el libro seleccionado.');
  }

  // 🚀 Activar en MemberPress (defensivo: cast a Number y valida)
  const productId = Number(membershipId);
  if (!Number.isFinite(productId) || productId <= 0) {
    try {
      await alertAdmin({
        area: 'regalos.activarMembresiaPorRegalo.bad_membership_id',
        err: new Error('membershipId inválido'),
        meta: { email: emailNormalizado, libroOriginal: String(libro || ''), slugCalculado: slugEntrada, membershipId }
      });
    } catch (_) {}
    throw new Error('Configuración de membresía inválida.');
  }

  try {
    await activarMembresia(emailNormalizado, productId);
    console.log(`🎁 Membresía ${productId} activada por regalo para ${maskEmail(emailNormalizado)} (libro=${slugEntrada})`);
  } catch (err) {
    try {
      await alertAdmin({
        area: 'regalos.activarMembresiaPorRegalo.error_memberpress',
        email: emailNormalizado,
        err,
        meta: {
          email: emailNormalizado,
          libroOriginal: String(libro || ''),
          slugCalculado: slugEntrada,
          membershipId: productId,
          stack: err?.stack || undefined
        }
      });
    } catch (_) {}
    // Mensaje neutro hacia capas superiores
    throw new Error('No se pudo activar la membresía.');
  }
};
