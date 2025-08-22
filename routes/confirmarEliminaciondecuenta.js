// 📁 routes/confirmarEliminaciondecuenta.js
const express = require('express');
const router = express.Router();
const admin = require('../firebase');
const firestore = admin.firestore();

const desactivarMembresiaClub = require('../services/desactivarMembresiaClub'); // ✅ servicio correcto
const { eliminarUsuarioWordPress } = require('../services/eliminarUsuarioWordPress');
const { borrarDatosUsuarioFirestore } = require('../services/borrarDatosUsuarioFirestore');
const { enviarEmailPersonalizado } = require('../services/email');
const { registrarBajaClub } = require('../services/registrarBajaClub');
const { alertAdmin } = require('../utils/alertAdmin');

router.post('/confirmar-eliminacion', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ ok: false, mensaje: 'Falta el token de verificación.' });

  try {
    const ref = firestore.collection('eliminacionCuentas').doc(token);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ ok: false, mensaje: 'El enlace no es válido o ya ha sido utilizado.' });

    const { email, expira } = snap.data();
    const ahora = Date.now();
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ ok: false, mensaje: 'Email no válido.' });
    }
    if (!expira || ahora > expira) {
      await ref.delete();
      return res.status(410).json({ ok: false, mensaje: 'El enlace ha caducado.' });
    }

    // —————————————————— 1) Desactivar membresía y verificar resultado
    let verificacion = 'PENDIENTE';
    let motivoFallo = '';
    let resultadoDesact = null;
    try {
      resultadoDesact = await desactivarMembresiaClub(email); // debe devolver algo tipo { ok, cancelada|desactivada, mensaje }
      const ok = !!resultadoDesact?.ok;
      const off = resultadoDesact?.cancelada === true || resultadoDesact?.desactivada === true || resultadoDesact?.status === 'cancelada';
      verificacion = ok && off ? 'CORRECTO' : 'FALLIDA';
      if (verificacion === 'FALLIDA') motivoFallo = resultadoDesact?.mensaje || 'No se confirmó la desactivación';
    } catch (e) {
      verificacion = 'FALLIDA';
      motivoFallo = e?.message || String(e);
    }

    // —————————————————— 2) Eliminar usuario en WordPress (sigue adelante aunque la baja falle)
    const resultadoWP = await eliminarUsuarioWordPress(email);
    if (!resultadoWP.ok) {
      // No frenamos la eliminación completa, pero lo marcamos y avisamos
      if (verificacion === 'CORRECTO') verificacion = 'FALLIDA';
      motivoFallo = motivoFallo || ('No se pudo eliminar en WordPress: ' + (resultadoWP.mensaje || 'desconocido'));
    }

    // —————————————————— 3) Borrar datos en Firestore (independiente)
    try { await borrarDatosUsuarioFirestore(email); } catch (_) {}

    // —————————————————— 4) Nombre (si existe) para Sheets
    let nombre = '';
    try {
      const f = await firestore.collection('datosFiscalesPorEmail').doc(email).get();
      if (f.exists) nombre = f.data()?.nombre || '';
    } catch (_) {}

    // —————————————————— 5) Registrar en la hoja unificada con verificación real
    const ahoraISO = new Date().toISOString();
    try {
      await registrarBajaClub({
        email,
        nombre,
        motivo: 'eliminacion_cuenta',
        fechaSolicitud: ahoraISO,
        fechaEfectos: ahoraISO,
        verificacion // ✅ CORRECTO o FALLIDA según verificación real
      });
    } catch (e) {
      // Si también falla el registro, avisa
      await alertAdmin({ area: 'baja_sheet_unificada', email, err: e, meta: { motivo: 'eliminacion_cuenta' } });
    }

    // —————————————————— 6) Aviso al admin si FALLIDA
    if (verificacion === 'FALLIDA') {
      const meta = {
        resultadoDesact: resultadoDesact || null,
        resultadoWP: resultadoWP || null,
        motivoFallo
      };
      await alertAdmin({ area: 'eliminacion_cuenta_desactivacion_fallida', email, err: new Error(motivoFallo), meta });
      // (opcional) email visible
      try {
        await enviarEmailPersonalizado({
          to: 'laboroteca@gmail.com',
          subject: '⚠️ FALLÓ la desactivación al eliminar cuenta',
          text: `Email: ${email}\nMotivo: ${motivoFallo}\nDetalle: ${JSON.stringify(meta, null, 2)}`,
          html: `<p><strong>Email:</strong> ${email}</p><p><strong>Motivo:</strong> ${motivoFallo}</p><pre>${JSON.stringify(meta, null, 2)}</pre>`
        });
      } catch (_) {}
    }

    // —————————————————— 7) Token fuera y confirmación al usuario
    await ref.delete();

    await enviarEmailPersonalizado({
      to: email,
      subject: 'Cuenta eliminada con éxito',
      html: `
        <p><strong>✅ Tu cuenta en Laboroteca ha sido eliminada.</strong></p>
        <p>${verificacion === 'CORRECTO'
          ? 'También hemos desactivado tu membresía del Club.'
          : 'Hemos tenido un problema al desactivar tu membresía; el equipo ya ha sido avisado y lo resolverá en breve.'}
        </p>`,
      text: verificacion === 'CORRECTO'
        ? 'Tu cuenta se ha eliminado y tu membresía ha sido desactivada.'
        : 'Tu cuenta se ha eliminado. Hubo un problema desactivando la membresía; el equipo ya ha sido avisado.',
      enviarACopy: true
    });

    return res.json({ ok: true, verificacion, motivoFallo: motivoFallo || undefined });
  } catch (err) {
    console.error('❌ Error al confirmar eliminación:', err);
    return res.status(500).json({ ok: false, mensaje: 'Error interno del servidor.' });
  }
});

module.exports = router;
