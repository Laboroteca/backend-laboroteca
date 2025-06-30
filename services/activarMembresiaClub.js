// services/activarMembresiaClub.js
const admin = require('../firebase');
const firestore = admin.firestore();

async function activarMembresiaClub(email) {
  if (!email) throw new Error('Email vacío');

  const ref = firestore.collection('usuariosClub').doc(email);

  await ref.set({
    email,
    activo: true,
    fechaAlta: new Date().toISOString()
  }, { merge: true });

  console.log(`✅ Membresía del Club activada para ${email}`);
}

module.exports = { activarMembresiaClub };
