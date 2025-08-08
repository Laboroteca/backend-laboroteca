const admin = require('../../firebase');
const firestore = admin.firestore();

/**
 * Guarda la entrada en Firestore al generarse tras compra
 * @param {Object} entrada
 * @param {string} entrada.codigoEntrada - Código único (ej. PRE-XW658)
 * @param {string} entrada.emailComprador
 * @param {string} entrada.nombreAsistente
 * @param {string} entrada.slugEvento - ej. 'evento-1'
 * @param {string} entrada.nombreEvento - ej. 'Evento 1 Madrid Octubre 2025'
 */
async function registrarEntradaFirestore({
  codigoEntrada,
  emailComprador,
  nombreAsistente,
  slugEvento,
  nombreEvento
}) {
  if (!codigoEntrada) throw new Error('Código de entrada no válido.');

  const docRef = firestore.collection('entradasCompradas').doc(codigoEntrada);
  await docRef.set({
    emailComprador,
    nombreAsistente,
    slugEvento,
    nombreEvento,
    usado: false,
    fechaCompra: new Date().toISOString()
  });

  console.log(`📥 Entrada registrada en Firestore: ${codigoEntrada}`);
}

module.exports = { registrarEntradaFirestore };
