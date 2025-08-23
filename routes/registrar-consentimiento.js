// routes/registrar-consentimiento.js
'use strict';

const express = require('express');
const router = express.Router();

const { registrarConsentimiento } = require('../utils/consentLogs'); // ← NUEVO
const { alertAdmin } = require('../utils/alertAdmin');

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

// Obtiene primera coincidencia de varios nombres de campo
function pick(body, cd, keys = [], def = '') {
  for (const k of keys) {
    const val = body?.[k];
    if (val !== undefined && val !== null && String(val).length) return s(val);
    const val2 = cd?.[k];
    if (val2 !== undefined && val2 !== null && String(val2).length) return s(val2);
  }
  return def;
}

/* ───────────── Ruta (best-effort; no bloquea el front) ───────────── */

router.post('/registrar-consentimiento', async (req, res) => {
  try {
    // Nota/telemetría ligera si no viene el hidden JSON
    if (!req.body?.consentData) {
      const srcHint = s(req.body?.source || req.body?.formularioId || '');
      const emailHint = s((req.body?.email || '').toLowerCase());
      console.log(`[CONSENT] sin consentData; source=${srcHint} email=${emailHint}`);
      // no es error: algunos formularios podrían no enviarlo
    }

    // Acepta tanto campos sueltos como el blob consentData
    const cd   = parseConsentData(req.body?.consentData);
    const body = { ...(req.body || {}) };

    // Identidad
    const email = pick(body, cd, ['email','user_email','correo','correo_electronico'], '').toLowerCase();
    const nombre = pick(body, cd, ['nombre','first_name','name','given_name','nombreCompleto'], '');
    let apellidos = pick(body, cd, ['apellidos','last_name','surname'], '');

    // Si vino nombreCompleto pero no apellidos, separamos por último espacio
    if (!apellidos && nombre && nombre.includes(' ')) {
      const parts = nombre.split(/\s+/);
      if (parts.length > 1) {
        apellidos = parts.pop();
        // nombre = resto (sin el último)
        body.__nombreOriginal = nombre;
        body.__apellidosDerivados = apellidos;
      }
    }

    const uid = pick(body, cd, ['uid','user_id','userId'], '') || null;

    // URLs y versiones (con fallbacks)
    const termsUrlRaw    = pick(body, cd, ['termsUrl'], '');
    const privacyUrlRaw  = pick(body, cd, ['privacyUrl'], '');
    const termsVerRaw    = pick(body, cd, ['termsVersion'], '');
    const privVerRaw     = pick(body, cd, ['privacyVersion'], '');

    const termsVersion   = termsVerRaw   || s(process.env.TERMS_VERSION_FALLBACK   || '2025-08-15');
    const privacyVersion = privVerRaw    || s(process.env.PRIVACY_VERSION_FALLBACK || '2025-08-15');
    const termsUrl       = termsUrlRaw   || s(process.env.TERMS_URL_FALLBACK       || 'https://www.laboroteca.es/terminos-y-condiciones-de-los-servicios-laboroteca/');
    const privacyUrl     = privacyUrlRaw || s(process.env.PRIVACY_URL_FALLBACK     || 'https://www.laboroteca.es/politica-de-privacidad-de-datos/');

    // Checkboxes (si no vienen, asumimos true porque son obligatorios en el formulario)
    const checkboxesIn = body.checkboxes ?? cd.checkboxes ?? {};
    const checkboxes = {
      terms:   b(checkboxesIn.terms, true),
      privacy: b(checkboxesIn.privacy, true),
      ...Object.keys(checkboxesIn || {}).reduce((acc, k) => {
        if (k !== 'terms' && k !== 'privacy') acc[k] = b(checkboxesIn[k], checkboxesIn[k]);
        return acc;
      }, {})
    };

    // Fuente y trazabilidad
    const source    = pick(body, cd, ['source','formularioId'], '');
    const sessionId = pick(body, cd, ['sessionId'], '');
    const paymentIntentId = pick(body, cd, ['paymentIntentId'], '');

    // HTML opcional ya renderizado (si lo pasas, el util evitará el fetch)
    const termsHtml   = body.termsHtml   || cd.termsHtml   || undefined;
    const privacyHtml = body.privacyHtml || cd.privacyHtml || undefined;

    // Extras de negocio
    const extras = {};
    ['tipoProducto','nombreProducto','descripcionProducto','formularioId','idx'].forEach(k => {
      const val = body[k] ?? cd[k];
      if (val !== undefined && val !== null) extras[k] = s(val);
    });

    // Avisos preventivos (no bloquean)
    if (!email) {
      try { await alertAdmin(`⚠️ Consentimiento sin email. source=${source || '-'} form=${extras.formularioId || '-'} ip=${req.ip || '-'}`); } catch {}
      return res.json({ ok: true, warn: 'missing_email' });
    }
    if (!checkboxes.privacy) {
      try { await alertAdmin(`⚠️ Privacy checkbox NO marcado para ${email} (source=${source || '-'})`); } catch {}
      // seguimos sin bloquear; el backend registrará igualmente
    }

    // Payload para el registrador robusto (GCS per-accept + Firestore con nombre/apellidos)
    const payload = {
      email,
      nombre,
      apellidos,
      userId: uid,

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

      sessionId,
      paymentIntentId,
      idx: extras.idx,

      // si viniera HTML pre-renderizado
      privacyHtml,
      termsHtml,
    };

    // 🔒 Best-effort: NO bloqueamos la respuesta; registramos en background
    registrarConsentimiento(payload)
      .then(r => {
        console.log('CONSENT OK:', r.docId);
      })
      .catch(async e => {
        console.warn('CONSENT WARN (no bloquea):', e?.message || e);
        try {
          await alertAdmin(`❌ Error guardando consentimiento de ${email}: ${e.message}`);
        } catch (_) {}
      });

    // ✅ Respuesta inmediata para no afectar checkout/registro
    return res.json({ ok: true });
  } catch (err) {
    console.error('registrar-consentimiento error (handler):', err);
    try {
      await alertAdmin(`❌ Error en /registrar-consentimiento: ${err.message}`);
    } catch (_) {}
    // No rompemos el flujo del front
    return res.json({ ok: true, warn: 'consent_route_failed' });
  }
});

module.exports = router;
