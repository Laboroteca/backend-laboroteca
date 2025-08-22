// 📁 jobs/verificarBajasProgramadas.js
const admin = require('../firebase');
const firestore = admin.firestore();
const { syncMemberpressClub } = require('../services/syncMemberpressClub');
const { alertAdmin } = require('../utils/alertAdmin');
const { guardarEnGoogleSheets } = require('../services/googleSheets');
const MEMBERSHIP_ID = parseInt(process.env.MEMBERSHIP_ID || '10663', 10);

module.exports = async function verificarBajasProgramadas() {
  const ahora = new Date();
  const snap = await firestore.collection('bajasClub')
    .where('estadoBaja', 'in', ['pendiente', 'programada'])
    .get();

  for (const doc of snap.docs) {
    const d = doc.data();
    const email = doc.id;
    const fechaEfectos = d?.fechaEfectos && typeof d.fechaEfectos.toDate === 'function'
      ? d.fechaEfectos.toDate()
      : new Date(d.fechaEfectos);
    if (isNaN(fechaEfectos.getTime())) continue;
    if (fechaEfectos > ahora) continue; // aún no toca

    try {
      const mp = await syncMemberpressClub({ email, accion: 'desactivar', membership_id: MEMBERSHIP_ID });
      if (!mp?.ok) throw new Error(`MemberPress devolvió ok=false: ${mp?.error || 'sin detalle'}`);
      await firestore.collection('usuariosClub').doc(email).set({ activo: false, fechaBaja: new Date().toISOString() }, { merge: true });
      await firestore.collection('bajasClub').doc(email).set({ estadoBaja: 'ejecutada', comprobacionFinal: 'correcto', fechaEjecucion: new Date().toISOString() }, { merge: true });
      try {
        await guardarEnGoogleSheets({ email, accion: 'baja_programada_ejecutada', verificacionBaja: 'CORRECTO', producto: 'el club laboroteca' });
      } catch (e) {
        await alertAdmin({ area: 'sheets_baja_programada_ejecutada', email, err: e, meta: { job: 'verificarBajasProgramadas' } });
      }
    } catch (err) {
      await firestore.collection('bajasClub').doc(email).set({ estadoBaja: 'fallida', comprobacionFinal: 'fallida', error: String(err?.message || err), fechaIntento: new Date().toISOString() }, { merge: true });
      await alertAdmin({ area: 'baja_programada_fallida', email, err, meta: { job: 'verificarBajasProgramadas' } });
      try {
        await guardarEnGoogleSheets({ email, accion: 'baja_programada_fallida', verificacionBaja: 'FALLIDA', producto: 'el club laboroteca' });
      } catch (e) {
        await alertAdmin({ area: 'sheets_baja_programada_fallida', email, err: e, meta: { job: 'verificarBajasProgramadas' } });
      }
    }
  }
  return { ok: true };
}
