// routes/registrar-consentimiento.js
const express = require('express');
const router = express.Router();
const { logConsent } = require('../utils/consentLogs');

// Parseo seguro del campo único consentData (JSON o string vacío)
function parseConsentData(v) {
  if (!v || typeof v !== 'string') return {};
  try { return JSON.parse(v); } catch { return {}; }
}

router.post('/registrar-consentimiento', async (req, res) => {
  try {
    // Acepta tanto campos sueltos como el blob consentData
    const cd = parseConsentData(req.body?.consentData);
    const body = { ...(req.body || {}) };

    const uid            = body.uid || null;
    const email          = (body.email || '').toLowerCase();
    const termsUrl       = body.termsUrl       || cd.termsUrl       || '';
    const privacyUrl     = body.privacyUrl     || cd.privacyUrl     || '';
    const termsVersion   = body.termsVersion   || cd.termsVersion   || '';
    const privacyVersion = body.privacyVersion || cd.privacyVersion || '';
    const checkboxes     = body.checkboxes || { terms: true, privacy: true };
    const source         = body.source || body.formularioId || '';
    const sessionId      = body.sessionId || '';
    const paymentIntentId= body.paymentIntentId || '';

    if (!email && !uid) {
      return res.status(400).json({ error: 'Falta email o uid.' });
    }
    if (!termsUrl || !privacyUrl) {
      return res.status(400).json({ error: 'Faltan URLs de Términos/Privacidad.' });
    }
    if (!termsVersion || !privacyVersion) {
      return res.status(400).json({ error: 'Faltan versiones de Términos/Privacidad.' });
    }

    const extras = {};
    // Copiamos algunos campos si venían en el form (opcionales)
    ['tipoProducto','nombreProducto','descripcionProducto','formularioId'].forEach(k => {
      if (body[k]) extras[k] = String(body[k]);
    });

    const result = await logConsent({
      uid, email, termsUrl, privacyUrl, termsVersion, privacyVersion,
      checkboxes, source, sessionId, paymentIntentId, req, extras
    });

    return res.json({ ok: true, consentId: result.id });
  } catch (err) {
    console.error('registrar-consentimiento error:', err);
    return res.status(500).json({ error: 'No se pudo registrar el consentimiento' });
  }
});

module.exports = router;
