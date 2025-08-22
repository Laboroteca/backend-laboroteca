// 📁 routes/solicitarEliminacionCuenta.js
const express = require('express');
const router = express.Router();
const admin = require('../firebase');
const firestore = admin.firestore();
const crypto = require('crypto');
const fetch = require('node-fetch');
const { enviarEmailValidacionEliminacionCuenta } = require('../services/email');
const { alertAdmin } = require('../utils/alertAdmin');

router.post('/solicitar-eliminacion', async (req, res) => {
  const email = (req.body?.email || '').toLowerCase().trim();
  const password = String(req.body?.password || '');

  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, mensaje: 'Email inválido.' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ ok: false, mensaje: 'Contraseña incorrecta.' });
  }

  try {
    // 1) Verificar credenciales en WordPress
    const resp = await fetch('https://www.laboroteca.es/wp-json/laboroteca/v1/verificar-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const textoPlano = await resp.text();
    console.log('🔍 WP respondió:', textoPlano);

    let datos;
    try {
      datos = JSON.parse(textoPlano);
    } catch (err) {
      console.error('❌ No se pudo parsear la respuesta JSON:', err.message);
      return res
        .status(502)
        .json({ ok: false, mensaje: 'Error verificando la contraseña (respuesta de WP inválida).' });
    }

    if (!resp.ok || !datos?.ok) {
      let mensaje = (datos && datos.mensaje) ? String(datos.mensaje) : 'Credenciales inválidas';
      if (mensaje.toLowerCase().includes('contraseña')) mensaje = 'Contraseña incorrecta';
      return res.status(401).json({ ok: false, mensaje });
    }

    // 2) Generar token y caducidad (2h)
    const token = crypto.randomBytes(32).toString('hex');
    const ahora = Date.now();
    const expira = ahora + 1000 * 60 * 60 * 2;

    // 3) (Opcional recomendado) invalidar tokens previos de este email
    try {
      const prev = await firestore.collection('eliminacionCuentas')
        .where('email', '==', email).get();
      if (!prev.empty) {
        const batch = firestore.batch();
        prev.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    } catch (e) {
      console.warn('⚠️ No se pudieron limpiar tokens previos:', e?.message || e);
    }

    // 4) Guardar token
    await firestore.collection('eliminacionCuentas').doc(token).set({
      email,
      expira,
      createdAt: ahora
    });

    // 5) Enviar email con enlace de validación
    try {
      await enviarEmailValidacionEliminacionCuenta(email, token);
    } catch (e) {
      console.error('❌ Error enviando email de validación:', e?.message || e);
      try {
        await alertAdmin({
          area: 'elim_cuenta_email_validacion',
          email,
          err: e,
          meta: {}
        });
      } catch {}
      return res.status(500).json({ ok: false, mensaje: 'No se pudo enviar el email de validación.' });
    }

    // 6) OK
    return res.json({ ok: true });

  } catch (err) {
    console.error('❌ Error al solicitar eliminación de cuenta:', err?.message || err);
    try {
      await alertAdmin({
        area: 'solicitar_eliminacion_error',
        email,
        err,
        meta: {}
      });
    } catch {}
    return res.status(500).json({ ok: false, mensaje: 'Error interno del servidor.' });
  }
});

module.exports = router;
