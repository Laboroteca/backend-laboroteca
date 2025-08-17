// routes/registrar-consentimiento.js
const express = require('express');
const router = express.Router();
const { logConsent } = require('../utils/consentLogs');

/* ───────────── Helpers ───────────── */

// Parseo seguro del campo único consentData (JSON o string vacío)
function parseConsentData(v) {
  if (!v || typeof v !== 'string') return {};
  try { return JSON.parse(v); } catch { return {}; }
}
// Normaliza string
const s = (v, def = '') =>
  (v === undefined || v === null) ? def : String(v).trim();
// Normaliza booleano
function b(v, def = false) {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  const sv = String(v).toLowerCase().trim();
  return ['1','true','yes','on','si','sí'].includes(sv) ? true
       : ['0','false','no','off'].includes(sv) ? false
       : def;
}

/* ───────────── Ruta (best-effort, nunca bloquea) ───────────── */

router.post('/registrar-consentimiento', async (req, res) => {
  try {
    // Telemetría ligera: detectar formularios sin consentData
    if (!req.body?.consentData) {
      const srcHint = s(req.body?.source || req.body?.formularioId || '');
      const emailHint = s((req.body?.email || '').toLowerCase());
      console.log(`[CONSENT] sin consentData; source=${srcHint} email=${emailHint}`);
    }

    // Acepta tanto campos sueltos como el blob consentData
    const cd   = parseConsentData(req.body?.consentData);
    const body = { ...(req.body || {}) };

    const uid            = s(body.uid || cd.uid || null) || null;
    const email          = s((body.email || cd.email || '').toLowerCase());
    const termsUrlRaw    = s(body.termsUrl       || cd.termsUrl       || '');
    const privacyUrlRaw  = s(body.privacyUrl     || cd.privacyUrl     || '');
    const termsVerRaw    = s(body.termsVersion   || cd.termsVersion   || '');
    const privVerRaw     = s(body.privacyVersion || cd.privacyVersion || '');

    // Fallbacks robustos de versión (por si el snippet no los envía)
    const termsVersion   = termsVerRaw || s(process.env.TERMS_VERSION_FALLBACK || '2025-08-15');
    const privacyVersion = privVerRaw  || s(process.env.PRIVACY_VERSION_FALLBACK || '2025-08-15');
    const termsUrl       = termsUrlRaw   || s(process.env.TERMS_URL_FALLBACK   || '');
    const privacyUrl     = privacyUrlRaw || s(process.env.PRIVACY_URL_FALLBACK || '');

    const checkboxesIn   = body.checkboxes ?? cd.checkboxes ?? {};
    const checkboxes     = {
      terms:   b(checkboxesIn.terms, true),
      privacy: b(checkboxesIn.privacy, true),
      ...Object.keys(checkboxesIn || {}).reduce((acc, k) => {
        if (k !== 'terms' && k !== 'privacy') acc[k] = b(checkboxesIn[k], checkboxesIn[k]);
        return acc;
      }, {})
    };

    const source         = s(body.source || body.formularioId || cd.source || cd.formularioId || '');
    const sessionId      = s(body.sessionId || cd.sessionId || '');
    const paymentIntentId= s(body.paymentIntentId || cd.paymentIntentId || '');

    // HTML opcional ya renderizado (si lo pasas, el util evitará el fetch)
    const termsHtml      = body.termsHtml   || cd.termsHtml   || undefined;
    const privacyHtml    = body.privacyHtml || cd.privacyHtml || undefined;

    // Extras opcionales (trazabilidad de negocio)
    const extras = {};
    ['tipoProducto','nombreProducto','descripcionProducto','formularioId','idx'].forEach(k => {
      const val = body[k] ?? cd[k];
      if (val !== undefined && val !== null) extras[k] = s(val);
    });

    // 🔒 Best-effort: NO bloquea la respuesta aunque falle el guardado
    logConsent({
      uid, email,
      termsUrl, privacyUrl,
      termsVersion, privacyVersion,
      checkboxes, source, sessionId, paymentIntentId,
      req, extras,
      termsHtml, privacyHtml
    })
      .then(r => console.log('CONSENT OK:', r.id))
      .catch(e => console.warn('CONSENT WARN (no bloquea):', e?.message || e));

    // ✅ Respuesta inmediata para no afectar al flujo de compra/membresía/registro
    return res.json({ ok: true });
  } catch (err) {
    console.error('registrar-consentimiento error (handler):', err);
    // Incluso ante errores inesperados, no bloqueamos el front/checkout
    return res.json({ ok: true, warn: 'consent_route_failed' });
  }
});

module.exports = router;
