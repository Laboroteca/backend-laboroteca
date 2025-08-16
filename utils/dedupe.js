const admin = require('../firebase');
const db = admin.firestore();

async function ensureOnce(kind, id){
  if(!id) return false;
  const ref = db.collection(kind).doc(id);
  return db.runTransaction(async tx=>{
    const s = await tx.get(ref);
    if (s.exists) return false;
    tx.set(ref, { createdAt: new Date().toISOString() });
    return true;
  });
}
module.exports = { ensureOnce };
