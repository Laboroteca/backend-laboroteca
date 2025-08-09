// 📂 Ruta: /regalos/routes/crear-codigo-regalo.js
// 

const express = require('express');
const admin = require('../../firebase');
const firestore = admin.firestore();

const { google } = require('googleapis');
const { auth } = require('../../entradas/google/sheetsAuth'); // usa el mismo auth

const router = express.Router();

// 📄 Hoja de control de CÓDIGOS REGALO (previos al canje)
const SHEET_ID_CONTROL = '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgCHXRvBoiwfo';
const SHEET_NAME_CONTROL = 'Hoja 1';

/**
 * Crea un código REG- único y lo asocia a un email.
 * Body: { nombre, email, codigo }
 */
router.post('/crear-codigo-regalo', async (req, res) => {
  try {
    const nombreRaw = (req.body?.nombre || '').trim();
    const emailRaw  = (req.body?.email  || '').trim().toLowerCase();
    const codigoRaw = (req.body?.codigo || '').trim().toUpperCase();

    // Validaciones
    if (!nombreRaw || !emailRaw || !codigoRaw) {
      return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios: nombre, email y codigo.' });
    }
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(emailRaw)) {
      return res.status(400).json({ ok: false, error: 'Email inválido.' });
    }
    if (!/^REG-[A-Z0-9-]+$/.test(codigoRaw)) {
      return res.status(400).json({ ok: false, error: 'El código debe empezar por REG- y solo contener letras, números o guiones.' });
    }

    // Idempotencia: rechaza si ya existe
    const docRef = firestore.collection('codigosRegalo').doc(codigoRaw);
    const snap = await docRef.get();
    if (snap.exists) {
      return res.status(409).json({ ok: false, error: 'Este código ya ha sido registrado previamente.' });
    }

    // Guarda en Firestore
    await docRef.set({
      nombre: nombreRaw,
      email: emailRaw,
      codigo: codigoRaw,
      creado: new Date().toISOString(),
      usado: false,
    });

    // 👉 Registrar en Google Sheets (control de REG-)
    try {
      const authClient = await auth();
      const sheets = google.sheets({ version: 'v4', auth: authClient });

      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID_CONTROL,
        range: `${SHEET_NAME_CONTROL}!A2:D`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          // A: Nombre, B: Email, C: Código, D: Ignacio o Rebeca (vacío por ahora)
          values: [[ nombreRaw, emailRaw, codigoRaw, '' ]],
        },
      });
    } catch (e) {
      console.warn('⚠️ No se pudo registrar en Sheets (control REG-):', e.message || e);
      // no rompemos la creación por fallo de Sheets
    }

    console.log(`🎁 Código REGALO creado: ${codigoRaw} para ${emailRaw}`);
    return res.status(201).json({ ok: true, codigo: codigoRaw });

  } catch (err) {
    console.error('❌ Error al crear código regalo:', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Error interno del servidor.' });
  }
});

module.exports = router;
