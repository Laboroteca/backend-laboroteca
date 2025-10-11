// services/enviarInvitacionResena.js
'use strict';

const fetch = require('node-fetch');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const SMTP2GO_API_URL = (process.env.SMTP2GO_API_URL || 'https://api.smtp2go.com/v3/email/send').trim();
const SMTP2GO_API_KEY = (process.env.SMTP2GO_API_KEY || '').trim();
const FROM_EMAIL      = (process.env.REVIEWS_FROM_EMAIL || 'laboroteca@laboroteca.es').trim();
const FROM_NAME       = (process.env.REVIEWS_FROM_NAME  || 'Laboroteca').trim();

function buildHtml({ nombre, nombreProducto, enlaceResenas, variant }) {
  // variant: 'compra' | 'regalo'
  const intro = variant === 'regalo'
    ? `Recientemente has obtenido acceso a <strong>${nombreProducto}</strong>.`
    : `Recientemente has comprado <strong>${nombreProducto}</strong>.`;

  return [
    `<div style="font-family:Georgia,serif;line-height:1.6;color:#333">`,
    `<p>Estimado ${nombre},</p>`,
    `<p>${intro}<br/>`,
    `Espero que lo hayas disfrutado o lo estés haciendo.</p>`,
    `<p>Tu opinión es muy valiosa: te invito a <strong>escribir una reseña</strong> para orientar y ayudar a otras personas interesadas en este producto.</p>`,
    `<p>Puedes hacerlo desde este enlace:<br>`,
    `<a href="${enlaceResenas}" target="_blank" rel="noopener noreferrer">${enlaceResenas}</a></p>`,
    `<p>Puedes contar tanto lo que más te ha gustado como aquello que crees que podría mejorar.<br/>`,
    `Cualquier valoración constructiva será bienvenida.</p>`,
    `<p>Muchas gracias por tu apoyo y confianza.</p>`,
    `<p>Ignacio Solsona<br/>Abogado</p>`,
    `</div>`
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
    `Puedes contar tanto lo que más te ha gustado como aquello que crees que podría mejorar.`,
    `Cualquier valoración constructiva será bienvenida.`,
    ``,
    `Muchas gracias por tu apoyo y confianza.`,
    ``,
    `Ignacio Solsona`,
    `Abogado`
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
