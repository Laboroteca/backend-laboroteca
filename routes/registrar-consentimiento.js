// routes/registrar-consentimiento.js
'use strict';

const express = require('express');
const router = express.Router();

const { registrarConsentimiento } = require('../utils/consentLogs');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

/* ───────────── Helpers ───────────── */
function parseConsentData(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return {}; }
  }
  return {};
}
const s = (v, def = '') => (v === undefined || v === null) ? def : String(v).trim();

function b(v, def = false) {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.length > 0;
  const sv = String(v).toLowerCase().trim();
  if (['1','true','yes','on','si','sí','checked'].includes(sv)) return true;
  if (['0','false','no','off',''].includes(sv)) return false;
  return def;
}

function pick(body, cd, keys = [], def = '') {
  for (const k of keys) {
    const v1 = body?.[k]; if (v1 !== undefined && v1 !== null && String(v1).length) return s(v1);
    const v2 = cd?.[k];   if (v2 !== undefined && v2 !== null && String(v2).length) return s(v2);
  }
  return def;
}

function isRegistrationFlow({ tipoProducto, formularioId, source }) {
  const tp = (tipoProducto || '').toLowerCase();
  const fid = String(formularioId || '');
  const src = (source || '').toLowerCase();
  if (tp.includes('registro')) return true;
  if (['5','14'].includes(fid)) return true;
  if (/form[_-]?0*(5|14)\b/.test(src)) return true;
  return false;
}

/* ───────────── Ruta ───────────── */
router.post('/registrar-consentimiento', async (req, res) => {
  const ts = new Date().toISOString();
  try {
    // Log de entrada sin PII sensible
    const ipHint = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    const uaHint = (req.headers['user-agent'] || '').slice(0, 120);
    console.log(`🟢 [CONSENT IN] ${ts} ip=${ipHint} ua=${uaHint}`);
    console.log(`🔹 keys: ${Object.keys(req.body || {}).join(', ') || '(sin body)'}`);

    const cd   = parseConsentData(req.body?.consentData);
    const body = { ...(req.body || {}) };

    // Identidad
    const email = pick(body, cd, ['email','user_email','buyer_email','correo','correo_electronico'], '').toLowerCase();
    const nombre = pick(body, cd, ['nombre','first_name','name','given_name','nombreCompleto'], '');
    let apellidos = pick(body, cd, ['apellidos','last_name','surname'], '');
    if (!apellidos && nombre && nombre.includes(' ')) {
      const parts = nombre.trim().split(/\s+/);
      if (parts.length > 1) apellidos = parts.slice(1).join(' ');
    }
    const uid = pick(body, cd, ['uid','user_id','userId'], '') || null;

    // Contexto / negocio / tracking
    const formularioId = pick(body, cd, ['formularioId','form_id','formId'], '');
    const tipoProducto = pick(body, cd, ['tipoProducto'], '') || (['5','14'].includes(formularioId) ? 'Registro' : '');
    const nombreProducto = pick(body, cd, ['nombreProducto'], '') || (['5','14'].includes(formularioId) ? 'Alta usuario Laboroteca' : '');
    const descripcionProducto = pick(body, cd, ['descripcionProducto'], '') || (tipoProducto ? `${tipoProducto} form ${formularioId}` : '');
    const source = pick(body, cd, ['source'], formularioId ? `form_${formularioId}` : '');

    const sessionId       = pick(body, cd, ['sessionId'], '');
    const paymentIntentId = pick(body, cd, ['paymentIntentId'], '');
    const idx             = pick(body, cd, ['idx'], '');
    const acceptedAt      = pick(body, cd, ['acceptedAt'], ''); // ISO/ts si lo mandas; si no lo calcula el módulo

    // URLs y versiones (con fallbacks)
    const termsUrl   = pick(body, cd, ['termsUrl'],   process.env.TERMS_URL_FALLBACK   || 'https://www.laboroteca.es/terminos-y-condiciones-de-los-servicios-laboroteca/');
    const privacyUrl = pick(body, cd, ['privacyUrl'], process.env.PRIVACY_URL_FALLBACK || 'https://www.laboroteca.es/politica-de-privacidad-de-datos/');

    const termsVersion   = pick(body, cd, ['termsVersion'],   process.env.TERMS_VERSION_FALLBACK   || '2025-08-27');
    const privacyVersion = pick(body, cd, ['privacyVersion'], process.env.PRIVACY_VERSION_FALLBACK || '2025-08-27');

    // Checkboxes (admite "checkbox" simple como privacy)
    const checkboxesIn = (body.checkboxes ?? cd.checkboxes ?? {});
    if (body.checkbox !== undefined && checkboxesIn.privacy === undefined) {
      checkboxesIn.privacy = body.checkbox;
    }
    const checkboxes = {
      privacy: b(checkboxesIn.privacy, true),
      terms:   b(checkboxesIn.terms,   true)
    };

    if (!email) {
      console.warn(`[CONSENT] ⚠️ sin email. source=${source || '-'} form=${formularioId || '-'} keys=${Object.keys(body||{}).join(',')}`);
      try { await alertAdmin(`⚠️ Consentimiento sin email (source=${source||'-'})`); } catch {}
      return res.json({ ok: true, warn: 'missing_email' });
    }

    const payloadBase = {
      email, nombre, apellidos, userId: uid,
      formularioId, tipoProducto, nombreProducto, descripcionProducto,
      source: source ? `fluentform_${source}` : '',
      userAgent: req.headers['user-agent'] || '',
      ip: ipHint,
      checkboxes,
      sessionId, paymentIntentId,
      idx
    };
    if (acceptedAt) payloadBase.acceptedAt = acceptedAt;

    // Decide si es registro: si lo es, no enviar T&C (el módulo también lo ignora, pero así dejamos trazas limpias)
    const esRegistro = isRegistrationFlow({ tipoProducto, formularioId, source });
    const payload = esRegistro
      ? {
          ...payloadBase,
          privacyUrl, privacyVersion,
          termsUrl: '', termsVersion: ''
        }
      : {
          ...payloadBase,
          privacyUrl, privacyVersion,
          termsUrl, termsVersion
        };

    console.log(`[CONSENT] email=${email} formId=${formularioId||source||'-'} registro=${esRegistro} privacy=${payload.privacyUrl?'yes':'no'} terms=${payload.termsUrl?'yes':'no'}`);

    // Procesamos en background y respondemos rápido
    registrarConsentimiento(payload)
      .then(r => {
        console.log(`✅ [CONSENT OK] docId=${r.docId} privInd=${r.privacyBlobPath||'-'} termsInd=${r.termsBlobPath||'-'}`);
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

