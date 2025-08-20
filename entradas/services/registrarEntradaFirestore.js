// services/registrarEntradaFirestore.js
const admin = require('../../firebase');
const firestore = admin.firestore();

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

  // 1) Colección principal (compat)
  await firestore.collection('entradas').doc(codigoEntrada).set({
    codigo           : codigoEntrada,
    email            : emailComprador,
    emailComprador   : emailComprador,
    nombre           : nombreAsistente.split(' ').slice(0, -1).join(' ') || '',
    apellidos        : nombreAsistente.split(' ').slice(-1).join(' ') || '',
    slugEvento       : slugEvento,
    nombreEvento     : nombreEvento || descripcionProducto || slugEvento || 'Evento',
    descripcionProducto: descripcionProducto || '',
    direccionEvento  : direccionEvento || '',
    fechaEvento      : fechaActuacion || '',
    fechaActuacion   : fechaActuacion || '',
    usada            : false,
    fechaCompra      : nowIso,
    timestamp        : Date.now()
  }, { merge: true });

  // 2) Colección usada por “Mi cuenta”
  await firestore.collection('entradasCompradas').doc(codigoEntrada).set({
    codigo              : codigoEntrada,
    emailComprador      : emailComprador,
    nombreEvento        : nombreEvento || descripcionProducto || slugEvento || 'Evento',
    descripcionProducto : descripcionProducto || '',
    slugEvento          : slugEvento || '',
    direccionEvento     : direccionEvento || '',
    fechaEvento         : fechaActuacion || '',
    fechaActuacion      : fechaActuacion || '',
    usado               : false,
    fechaCompra         : nowIso
  }, { merge: true });
}

module.exports = { registrarEntradaFirestore };
