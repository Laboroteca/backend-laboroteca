// services/registrarEntradaFirestore.js
const admin = require('../../firebase');
const firestore = admin.firestore();
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

/**
 * Registra una entrada en Firestore (colecciones: 'entradas' y 'entradasCompradas')
 */
async function registrarEntradaFirestore({
  codigoEntrada,
  emailComprador,
  nombreAsistente = '',
  slugEvento = '',
  nombreEvento = '',
  descripcionProducto = '',
  direccionEvento = '',
  fechaActuacion = '' // "DD/MM/YYYY - HH:mm"
}) {
  if (!codigoEntrada || !emailComprador) {
    throw new Error('registrarEntradaFirestore: faltan codigoEntrada o emailComprador');
  }

  const nowIso = new Date().toISOString();
  const emailNorm = String(emailComprador).trim().toLowerCase();
  const nombreStr = String(nombreAsistente || '').trim();
  const partes = nombreStr.split(/\s+/);
  const nombreSolo = partes.length > 1 ? partes.slice(0, -1).join(' ') : (partes[0] || '');
  const apellidosSolo = partes.length > 1 ? partes.slice(-1).join(' ') : '';

  // 1) Colección principal (compat)
  try {
    await firestore.collection('entradas').doc(codigoEntrada).set({
      codigo             : codigoEntrada,
      email              : emailNorm,
      emailComprador     : emailNorm,
      nombre             : nombreSolo,
      apellidos          : apellidosSolo,
      slugEvento         : slugEvento,
      nombreEvento       : nombreEvento || descripcionProducto || slugEvento || 'Evento',
      descripcionProducto: descripcionProducto || '',
      direccionEvento    : direccionEvento || '',
      fechaEvento        : fechaActuacion || '',
      fechaActuacion     : fechaActuacion || '',
      usada              : false,
      fechaCompra        : nowIso,
      timestamp          : Date.now()
    }, { merge: true });
  } catch (e) {
    try {
      await alertAdmin({
        area: 'entradas.firestore.entradas',
        email: emailNorm,
        err: e,
        meta: { codigoEntrada, slugEvento, descripcionProducto }
      });
    } catch (_) {}
    throw new Error(`registrarEntradaFirestore: fallo guardando en 'entradas': ${e?.message || e}`);
  }

  // 2) Colección usada por “Mi cuenta”
  try {
    await firestore.collection('entradasCompradas').doc(codigoEntrada).set({
      codigo              : codigoEntrada,
      emailComprador      : emailNorm,
      nombreEvento        : nombreEvento || descripcionProducto || slugEvento || 'Evento',
      descripcionProducto : descripcionProducto || '',
      slugEvento          : slugEvento || '',
      direccionEvento     : direccionEvento || '',
      fechaEvento         : fechaActuacion || '',
      fechaActuacion      : fechaActuacion || '',
      usado               : false,
      fechaCompra         : nowIso
    }, { merge: true });
  } catch (e) {
    try {
      await alertAdmin({
        area: 'entradas.firestore.compradas',
        email: emailNorm,
        err: e,
        meta: { codigoEntrada, slugEvento, descripcionProducto }
      });
    } catch (_) {}
    throw new Error(`registrarEntradaFirestore: fallo guardando en 'entradasCompradas': ${e?.message || e}`);
  }
}
module.exports = { registrarEntradaFirestore };
