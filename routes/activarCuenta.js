const admin = require('../firebase');
const firestore = admin.firestore();

module.exports = async function (req, res) {
  const token = req.query.token;

  if (!token || typeof token !== 'string') {
    return res.status(400).send('Token inválido o ausente.');
  }

  try {
    // Buscar usuario pendiente con ese token
    const snapshot = await firestore.collection('usuariosPendientes')
      .where('token', '==', token)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).send('Token no válido o ya usado.');
    }

    const doc = snapshot.docs[0];
    const email = doc.id;

    // Marcar como activado
    await doc.ref.update({ activado: 'sí', activadoEn: new Date().toISOString() });

    // Opcional: también puedes mover al usuario a otra colección, si lo prefieres
    console.log(`✅ Cuenta activada para ${email}`);

    // Mostrar confirmación visual
    return res.send(`
      <html>
        <head><title>Cuenta activada</title></head>
        <body style="font-family:sans-serif;text-align:center;margin-top:60px;">
          <h1>✅ Cuenta activada correctamente</h1>
          <p>Ya puedes iniciar sesión en Laboroteca.</p>
          <a href="https://www.laboroteca.es/login" style="display:inline-block;margin-top:20px;background:#205f19;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;">Iniciar sesión</a>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('❌ Error al activar cuenta:', err.message);
    return res.status(500).send('Error al activar la cuenta.');
  }
};
