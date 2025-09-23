// 📂 regalos/services/activarMembresiaDirecta.js

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

/**
 * Activa directamente una membresía en MemberPress para un usuario dado.
 * No realiza cobro; útil para canjes de códigos regalo o entradas.
 *
 * @param {string} email - Email del usuario al que se le activa la membresía.
 * @param {number} membershipId - ID de la membresía en MemberPress.
 * @throws {Error} Si faltan datos o la activación falla.
 */
module.exports = async function activarMembresiaDirecta(email, membershipId) {
  const emailNormalizado = String(email || '').trim().toLowerCase();
  const memId = Number(membershipId);

  if (!emailNormalizado || !Number.isFinite(memId) || memId <= 0) {
    throw new Error('Faltan datos para activar la membresía.');
  }

  try {
    // 🚀 Activar en MemberPress
    await activarMembresia(emailNormalizado, memId);
    console.log(`🎯 Membresía ${memId} activada directamente para ${maskEmail(emailNormalizado)}`);
  } catch (err) {
    console.error(`❌ Error al activar la membresía ${memId} para ${maskEmail(emailNormalizado)}:`, err?.message || err);
    try {
      await alertAdmin({
        area: 'regalos.activarMembresiaDirecta.error',
        email: emailNormalizado,
        err,
        meta: { membershipId: memId }
      });
    } catch (_) {}

    // Mensaje genérico hacia arriba; detalles ya notificados al admin
    throw new Error('No se pudo activar la membresía.');
  }
};
