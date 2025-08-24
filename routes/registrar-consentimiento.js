// routes/registrar-consentimiento.js
'use strict';

const express = require('express');
const router = express.Router();

const { registrarConsentimiento } = require('../utils/consentLogs');
const { alertAdmin } = require('../utils/alertAdmin');

/* ───────────── Helpers ───────────── */
function parseConsentData(v) {
  if (!v || typeof v !== 'string') return {};
  try { return JSON.parse(v); } catch { return {}; }
}
const s = (v, def = '') => (v === undefined || v === null) ? def : String(v).trim();
function b(v, def = false) {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  const sv = String(v).toLowerCase().trim();
  return ['1','true','yes','on','si','sí'].includes(sv) ? true
       : ['0','false','no','off'].includes(sv) ? false
       : def;
}
function pick(body, cd, keys = [], def = '') {
  for (const k of keys) {
    const v1 = body?.[k]; if (v1 !== undefined && v1 !== null && String(v1).length) return s(v1);
    const v2 = cd?.[k];   if (v2 !== undefined && v2 !== null && String(v2).length) return s(v2);
  }
  return def;
}

/* ───────────── Ruta (best-effort; con logs de alta señal) ───────────── */
router.post('/registrar-consentimiento', async (req, res) => {
  const ts = new Date().toISOString();
  try {
    // LOG de entrada (no PII sensible)
    console.log(`🟢 [CONSENT IN] ${ts} ip=${req.headers['x-forwarded-for'] || req.ip || '-'} ua=${(req.headers['user-agent']||'').slice(0,80)}`);
    console.log(`🔹 keys: ${Object.keys(req.body || {}).join(', ') || '(sin body)'}`);

    if (!req.body?.consentData) {
      const srcHint = s(req.body?.source || req.body?.formularioId || '');
      const emailHint = s((req.body?.email || '').toLowerCase());
      console.log(`[CONSENT] sin consentData; source=${srcHint} email=${emailHint}`);
    }

    const cd   = parseConsentData(req.body?.consentData);
    const body = { ...(req.body || {}) };

    // Identidad
    const email = pick(body, cd, ['email','user_email','correo','correo_electronico'], '').toLowerCase();
    const nombre = pick(body, cd, ['nombre','first_name','name','given_name','nombreCompleto'], '');
    let apellidos = pick(body, cd, ['apellidos','last_name','surname'], '');
    if (!apellidos && nombre && nombre.includes(' ')) {
      const parts = nombre.split(/\s+/);
      if (parts.length > 1) {
        apellidos = parts.pop();
      }
    }
    const uid = pick(body, cd, ['uid','user_id','userId'], '') || null;

    // URLs/Versiones (con fallbacks)
    const termsUrlRaw    = pick(body, cd, ['termsUrl'], '');
    const privacyUrlRaw  = pick(body, cd, ['privacyUrl'], '');
    const termsVerRaw    = pick(body, cd, ['termsVersion'], '');
    const privVerRaw     = pick(body, cd, ['privacyVersion'], '');

    const termsVersion   = termsVerRaw   || s(process.env.TERMS_VERSION_FALLBACK   || '2025-08-15');
    const privacyVersion = privVerRaw    || s(process.env.PRIVACY_VERSION_FALLBACK || '2025-08-15');
    const termsUrl       = termsUrlRaw   || s(process.env.TERMS_URL_FALLBACK       || 'https://www.laboroteca.es/terminos-y-condiciones-de-los-servicios-laboroteca/');
    const privacyUrl     = privacyUrlRaw || s(process.env.PRIVACY_URL_FALLBACK     || 'https://www.laboroteca.es/politica-de-privacidad-de-datos/');

    // Checkboxes
    const checkboxesIn = body.checkboxes ?? cd.checkboxes ?? {};
    // 🔁 Fallback: si Fluent Forms envía `checkbox`, lo usamos como privacy
    if (body.checkbox !== undefined && checkboxesIn.privacy === undefined) {
      checkboxesIn.privacy = body.checkbox;
    }
    const checkboxes = {
      terms:   b(checkboxesIn.terms, true),
      privacy: b(checkboxesIn.privacy, true),
      ...Object.keys(checkboxesIn || {}).reduce((acc, k) => {
        if (k !== 'terms' && k !== 'privacy') acc[k] = b(checkboxesIn[k], checkboxesIn[k]);
        return acc;
      }, {})
    };

    const source    = pick(body, cd, ['source','formularioId'], '');
    const sessionId = pick(body, cd, ['sessionId'], '');
    const paymentIntentId = pick(body, cd, ['paymentIntentId'], '');

    const termsHtml   = body.termsHtml   || cd.termsHtml   || undefined;
    const privacyHtml = body.privacyHtml || cd.privacyHtml || undefined;

    const extras = {};
    ['tipoProducto','nombreProducto','descripcionProducto','formularioId','idx'].forEach(k => {
      const val = body[k] ?? cd[k];
      if (val !== undefined && val !== null) extras[k] = s(val);
    });

    if (!email) {
      console.warn(`[CONSENT] ⚠️ sin email. source=${source || '-'} form=${extras.formularioId || '-'} keys=${Object.keys(body||{}).join(',')}`);
      try { await alertAdmin(`⚠️ Consentimiento sin email (source=${source||'-'})`); } catch {}
      return res.json({ ok: true, warn: 'missing_email' });
    }

    console.log(`[CONSENT] email=${email} formId=${extras.formularioId||source||'-'} privacy=${checkboxes.privacy} terms=${checkboxes.terms}`);

    const payload = {
      email, nombre, apellidos, userId: uid,
      formularioId: extras.formularioId || source || '',
      tipoProducto: extras.tipoProducto || 'Registro',
      nombreProducto: extras.nombreProducto || 'Alta usuario Laboroteca',
      descripcionProducto: extras.descripcionProducto || `Registro form ${extras.formularioId || source || ''}`,
      source: source ? `fluentform_${source}` : '',
      userAgent: req.headers['user-agent'] || '',
      ip: (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || req.ip || '').toString(),
      checkboxes,
      privacyUrl, privacyVersion,
      termsUrl, termsVersion,
      sessionId, paymentIntentId,
      idx: extras.idx,
      privacyHtml, termsHtml,
    };

    registrarConsentimiento(payload)
      .then(r => {
        console.log(`✅ [CONSENT OK] docId=${r.docId} privacyPath=${r.privacyBlobPath||'-'}`);
      })
      .catch(async e => {
        console.warn('❗ [CONSENT WARN]', e?.message || e);
        try { await alertAdmin(`❌ Error guardando consentimiento de ${email}: ${e.message}`); } catch {}
      });

    return res.json({ ok: true, route: 'registrar-consentimiento' });
  } catch (err) {
    console.error('🔥 registrar-consentimiento error:', err);
    try { await alertAdmin(`❌ Error en /registrar-consentimiento: ${err.message}`); } catch {}
    return res.json({ ok: true, warn: 'consent_route_failed' });
  }
});

module.exports = router;
