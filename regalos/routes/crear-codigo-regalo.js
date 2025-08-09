// 📂 regalos/routes/crear-codigo-regalo.js
const express = require('express');
const admin = require('../../firebase');
const firestore = admin.firestore();

const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth'); // ✅ Auth centralizado

const router = express.Router();

// 📄 Hoja de control de CÓDIGOS REGALO (previos al canje)
const SHEET_ID_CONTROL = '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgCHXRvBoiwfo';
const SHEET_NAME_CONTROL = 'Hoja 1';

/**
 * 📌 POST /crear-codigo-regalo
 * Body esperado: { nombre, email, codigo }
 */
router.post('/crear-codigo-regalo', async (req, res) => {
  try {
    // 🧹 Normalización
    const nombre = String(req.body?.nombre || '').trim();
    const email  = String(req.body?.email || '').trim().toLowerCase();
    const codigo = String(req.body?.codigo || '').trim().toUpperCase();

    // 📋 Validaciones
    if (!nombre || !email || !codigo) {
      return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios: nombre, email y código.' });
    }
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Email inválido.' });
    }
    if (!/^REG-[A-Z0-9-]+$/.test(codigo)) {
      return res.status(400).json({
        ok: false,
        error: 'El código debe empezar por REG- y solo contener letras, números o guiones.'
      });
    }

    // 🔒 Idempotencia: evitar sobrescribir un código ya registrado
    const docRef = firestore.collection('codigosRegalo').doc(codigo);
    const snap = await docRef.get();
    if (snap.exists) {
      return res.status(409).json({ ok: false, error: 'Este código ya ha sido registrado previamente.' });
    }

    // 💾 Guardar en Firestore
    await docRef.set({
      nombre,
      email,
      codigo,
      creado: new Date().toISOString(),
      usado: false
    });

    // 📝 Registrar en Google Sheets
    try {
      const authClient = await auth();
      const sheets = google.sheets({ version: 'v4', auth: authClient });

      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID_CONTROL,
        range: `${SHEET_NAME_CONTROL}!A2:D`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          // A: Nombre | B: Email | C: Código | D: Ignacio/Rebeca (vacío de momento)
          values: [[ nombre, email, codigo, '' ]]
        }
      });
    } catch (sheetErr) {
      console.warn('⚠️ No se pudo registrar en Sheets (control REG-):', sheetErr.message || sheetErr);
    }

    console.log(`🎁 Código REGALO creado → ${codigo} para ${email}`);
    return res.status(201).json({ ok: true, codigo });
  } catch (err) {
    console.error('❌ Error en /crear-codigo-regalo:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
  }
});

module.exports = router;
