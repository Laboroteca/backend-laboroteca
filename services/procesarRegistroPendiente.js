const crypto = require('crypto');
const admin = require('../firebase');
const firestore = admin.firestore();

async function procesarRegistroPendiente(datos) {
  const email = datos.email?.toLowerCase().trim();
  const nombre = datos.nombre?.trim();
  const tipoFormulario = datos.tipoFormulario;

  if (tipoFormulario !== 'registro' || !email) return;

  const token = crypto.randomBytes(32).toString('hex');

  await firestore.collection('usuariosPendientes').doc(email).set({
    email,
    nombre,
    token,
    activado: 'no',
    creado: new Date().toISOString()
  });

  console.log(`✅ Usuario pendiente registrado: ${email}`);
  return { email, token, nombre };
}

module.exports = { procesarRegistroPendiente };
