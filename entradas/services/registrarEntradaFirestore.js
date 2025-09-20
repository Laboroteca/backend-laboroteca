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
  fechaActuacion = '', // "DD/MM/YYYY - HH:mm"
  requestId = undefined  // opcional para trazabilidad en alertas
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

  // Escritura atómica con batch (idempotente por docId = codigoEntrada)
  const docEntradas = firestore.collection('entradas').doc(codigoEntrada);
  const docCompradas = firestore.collection('entradasCompradas').doc(codigoEntrada);

  const entradaData = {
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
  };

  const compradaData = {
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
  };

  try {
    const batch = firestore.batch();
    batch.set(docEntradas, entradaData, { merge: true });
    batch.set(docCompradas, compradaData, { merge: true });
    await batch.commit();
  } catch (e) {
    try {
      await alertAdmin({
        area: 'entradas.firestore.batch',
        email: emailNorm,
        err: e,
        meta: { codigoEntrada, slugEvento, descripcionProducto, requestId }
      });
    } catch (_) {}
    throw new Error(`registrarEntradaFirestore: fallo guardando documentos: ${e?.message || e}`);
  }
}
module.exports = { registrarEntradaFirestore };
