// services/desactivarMembresiaClub.js
const admin = require('../firebase');
const firestore = admin.firestore();

async function desactivarMembresiaClub(email) {
  if (!email) throw new Error('Email vacío');

  const ref = firestore.collection('usuariosClub').doc(email);

  await ref.set({
    email,
    activo: false,
    fechaBaja: new Date().toISOString()
  }, { merge: true });

  console.log(`🚫 Membresía del Club desactivada para ${email}`);
}

module.exports = { desactivarMembresiaClub };
