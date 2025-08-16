const admin = require('../firebase');
const db = admin.firestore();

async function ensureOnce(kind, id) {
  if (!id) return false;
  const cleanId = String(id).trim().toLowerCase();
  const ref = db.collection(kind).doc(cleanId);

  return db.runTransaction(async tx => {
    const s = await tx.get(ref);
    if (s.exists) return false;
    tx.set(ref, { createdAt: admin.firestore.FieldValue.serverTimestamp() });
    return true;
  });
}

module.exports = { ensureOnce };

