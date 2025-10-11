// services/enviarInvitacionResena.js
'use strict';

const fetch = require('node-fetch');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const SMTP2GO_API_URL = (process.env.SMTP2GO_API_URL || 'https://api.smtp2go.com/v3/email/send').trim();
const SMTP2GO_API_KEY = (process.env.SMTP2GO_API_KEY || '').trim();

// Normaliza variables de entorno que a veces llegan como "undefined"/"null" string
function safeEnv(v) {
  const s = (v ?? '').toString().trim();
  return (s && s.toLowerCase() !== 'undefined' && s.toLowerCase() !== 'null') ? s : '';
}

// Preferimos REVIEWS_*; si no están, caemos a SMTP2GO_FROM_*; y si tampoco, fallback seguro
const FROM_EMAIL =
  safeEnv(process.env.REVIEWS_FROM_EMAIL) ||
  safeEnv(process.env.SMTP2GO_FROM_EMAIL) ||
  'laboroteca@laboroteca.es';
const FROM_NAME  =
  safeEnv(process.env.REVIEWS_FROM_NAME) ||
  safeEnv(process.env.SMTP2GO_FROM_NAME) ||
  'Laboroteca';

// ───────────────────────────────────────────────────────────
// Estilos unificados (mismo cuerpo que el resto de emails)
const BASE_WRAPPER_STYLE = 'font-family:Arial,sans-serif;font-size:16px;color:#333;line-height:1.5;max-width:640px;margin:0 auto;padding:0 12px;';
const LINK_STYLE         = 'color:#606296;text-decoration:underline;';
const FOOTER_STYLE       = 'font-size:14px;color:#777;line-height:1.5;';
const SEP_HTML           = '<hr style="margin:16px 0;border:0;border-top:1px solid #bbb;" />';

// Pie de protección de datos (HTML + TXT)
const PIE_HTML = `
  <div style="${FOOTER_STYLE}">
    En cumplimiento del Reglamento (UE) 2016/679 (RGPD) y la LOPDGDD, le informamos de que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera (DNI 20481042W), con domicilio en calle Enmedio nº 22, 3.º E, 12001 Castellón de la Plana (España).<br /><br />
    Finalidades: prestación de servicios jurídicos, venta de infoproductos, gestión de entradas a eventos, emisión y envío de facturas por email y, en su caso, envío de newsletter y comunicaciones comerciales si usted lo ha consentido. Base jurídica: ejecución de contrato y/o consentimiento. Puede retirar su consentimiento en cualquier momento.<br /><br />
    Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición escribiendo a
    <a href="mailto:laboroteca@gmail.com" style="${LINK_STYLE}">laboroteca@gmail.com</a>.
    También puede presentar una reclamación ante la autoridad de control competente.
    Más información en nuestra política de privacidad:
    <a href="https://www.laboroteca.es/politica-de-privacidad/" target="_blank" rel="noopener" style="${LINK_STYLE}">https://www.laboroteca.es/politica-de-privacidad/</a>.
  </div>
`.trim();

const PIE_TEXT = `
En cumplimiento del Reglamento (UE) 2016/679 (RGPD) y la LOPDGDD, su email forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera (DNI 20481042W), calle Enmedio nº 22, 3.º E, 12001 Castellón de la Plana (España).

Finalidades: prestación de servicios jurídicos, venta de infoproductos, gestión de entradas a eventos, emisión y envío de facturas por email y, en su caso, envío de newsletter y comunicaciones comerciales si usted lo ha consentido. Base jurídica: ejecución de contrato y/o consentimiento. Puede retirar su consentimiento en cualquier momento.

Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición escribiendo a: laboroteca@gmail.com.
También puede presentar una reclamación ante la autoridad de control competente.
Más información: https://www.laboroteca.es/politica-de-privacidad/
`.trim();
// ───────────────────────────────────────────────────────────


function buildHtml({ nombre, nombreProducto, enlaceResenas, variant }) {
  // variant: 'compra' | 'regalo'
  const intro = variant === 'regalo'
    ? `Recientemente has obtenido acceso a <strong>${nombreProducto}</strong>.`
    : `Recientemente has comprado <strong>${nombreProducto}</strong>.`;

  return [
    `<div style="${BASE_WRAPPER_STYLE}">`,
      `<p>Estimado ${nombre},</p>`,
      `<p>${intro}<br/>`,
      `Espero que lo hayas disfrutado o lo estés haciendo.</p>`,
      `<p>Tu opinión es muy valiosa: te invito a <strong>escribir una reseña</strong> para orientar y ayudar a otras personas interesadas en este producto.</p>`,
      `<p>Puedes hacerlo desde este enlace:<br/>`,
      `<a href="${enlaceResenas}" target="_blank" rel="noopener noreferrer" style="${LINK_STYLE}">${enlaceResenas}</a></p>`,
      `<p>Cualquier valoración constructiva será bienvenida.</p>`,
      `<p>Muchas gracias por tu apoyo y confianza.</p>`,
      `<p>Ignacio Solsona<br/>Abogado</p>`,
    `</div>`,
    SEP_HTML,
    PIE_HTML
  ].join('');
}

function buildText({ nombre, nombreProducto, enlaceResenas, variant }) {
  const intro = variant === 'regalo'
    ? `Recientemente has obtenido acceso a ${nombreProducto}.`
    : `Recientemente has comprado ${nombreProducto}.`;

  return [
    `Estimado ${nombre},`,
    ``,
    `${intro}`,
    `Espero que lo hayas disfrutado o lo estés haciendo.`,
    ``,
    `Tu opinión es muy valiosa: te invito a ESCRIBIR UNA RESEÑA para orientar y ayudar a otras personas interesadas en este producto.`,
    ``,
    `Puedes hacerlo desde este enlace:`,
    `${enlaceResenas}`,
    ``,
    `Cualquier valoración constructiva será bienvenida.`,
    ``,
    `Muchas gracias por tu apoyo y confianza.`,
    ``,
    `Ignacio Solsona`,
    `Abogado`,
    ``,
    `------------------------------------------------------------`,
    PIE_TEXT
  ].join('\n');
}

/**
 * Envía la invitación usando la API de SMTP2GO
 * @param {Object} p
 * @param {string} p.toEmail
 * @param {string} p.subject
 * @param {string} p.nombre
 * @param {string} p.nombreProducto
 * @param {string} p.enlaceResenas
 * @param {'compra'|'regalo'} p.variant
 */
async function enviarInvitacionResena(p) {
  if (!SMTP2GO_API_KEY) throw new Error('Falta SMTP2GO_API_KEY');
  if (!FROM_EMAIL.includes('@')) {
    const msg = `Remitente inválido: FROM_EMAIL="${FROM_EMAIL}"`;
    try { await alertAdmin({ area: 'reviews.smtp2go.sender.invalid', err: msg, meta: { FROM_EMAIL, FROM_NAME } }); } catch (_) {}
    throw new Error(msg);
  }
  const toEmail = String(p.toEmail || '').trim();
  if (!toEmail) throw new Error('toEmail vacío');
  if (!p.nombreProducto) throw new Error('nombreProducto vacío');
  if (!p.enlaceResenas) throw new Error('enlaceResenas vacío');
  if (!p.variant || !['compra','regalo'].includes(p.variant)) {
    throw new Error('variant inválida (esperado: compra|regalo)');
  }

  const subject = String(p.subject || '').trim();
  if (!subject) throw new Error('subject vacío');
  const html = buildHtml(p);
  const text = buildText(p);

  const body = {
    api_key: SMTP2GO_API_KEY,
    to: [toEmail],
    sender: `${FROM_NAME} <${FROM_EMAIL}>`,
    subject,
    text_body: text,
    html_body: html,
  };

  const res = await fetch(SMTP2GO_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const msg = `SMTP2GO error ${res.status}: ${errText}`;
    try { await alertAdmin({ area: 'reviews.smtp2go.error', meta: { toEmail, subject }, err: msg }); } catch (_) {}
    throw new Error(msg);
  }
  return true;
}

module.exports = { enviarInvitacionResena };
