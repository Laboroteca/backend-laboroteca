// regalos/services/enviarEmailCanjeLibro.js
/**
 * Envía email de confirmación del canje (PRE-/REG-) usando SMTP2GO API.
 * Sin dependencias externas. Node 18+ (fetch nativo).
 *
 * Variables de entorno admitidas (por orden):
 *   API KEY:   SMTP2GO_API_KEY | SMTP2GO_KEY | SMTP_API_KEY | SMTP2GO_TOKEN
 *   SENDER:    SMTP2GO_SENDER  | SMTP_SENDER | EMAIL_SENDER | SMTP_FROM | FROM_EMAIL
 */

'use strict';

const SMTP2GO_ENDPOINT = 'https://api.smtp2go.com/v3/email/send';
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

// --- Pie RGPD unificado y actualizado ---
const PIE_HTML = `
  <hr style="margin-top: 40px; margin-bottom: 10px;" />
  <div style="font-size: 12px; color: #777; line-height: 1.5;">
    En cumplimiento del Reglamento (UE) 2016/679 (RGPD) y la LOPDGDD, le informamos de que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera (DNI 20481042W), con domicilio en calle Enmedio nº 22, 3.º E, 12001 Castellón de la Plana (España).<br /><br />
    Finalidades: prestación de servicios jurídicos, venta de infoproductos, gestión de entradas a eventos, emisión y envío de facturas por email y, en su caso, envío de newsletter y comunicaciones comerciales si usted lo ha consentido. Base jurídica: ejecución de contrato y/o consentimiento. Puede retirar su consentimiento en cualquier momento.<br /><br />
    Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición escribiendo a <a href="mailto:laboroteca@gmail.com">laboroteca@gmail.com</a>. También puede presentar una reclamación ante la autoridad de control competente. Más información en nuestra política de privacidad: <a href="https://www.laboroteca.es/politica-de-privacidad/" target="_blank" rel="noopener">https://www.laboroteca.es/politica-de-privacidad/</a>.
  </div>
`.trim();

const PIE_TEXT = `
------------------------------------------------------------
En cumplimiento del Reglamento (UE) 2016/679 (RGPD) y la LOPDGDD, su email forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera (DNI 20481042W), calle Enmedio nº 22, 3.º E, 12001 Castellón de la Plana (España).

Finalidades: prestación de servicios jurídicos, venta de infoproductos, gestión de entradas a eventos, emisión y envío de facturas por email y, en su caso, envío de newsletter y comunicaciones comerciales si usted lo ha consentido. Base jurídica: ejecución de contrato y/o consentimiento. Puede retirar su consentimiento en cualquier momento.

Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición escribiendo a: laboroteca@gmail.com.
También puede presentar una reclamación ante la autoridad de control competente.
Más información: https://www.laboroteca.es/politica-de-privacidad/
`.trim();

function construirHTML({ nombreMostrar, libroElegido }) {
  const miCuentaURL = 'https://www.laboroteca.es/mi-cuenta/';
  const clubURL = 'https://www.laboroteca.es/club-laboroteca/';
  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#111;">
      <p style="margin:0 0 12px;font-size:16px;font-weight:600;">
        ¡Enhorabuena${nombreMostrar ? ', ' + nombreMostrar : ''}!
      </p>
      <p style="margin:0 0 12px;">
        Tu código ha sido canjeado <strong>${libroElegido ? `(${libroElegido})` : ''}</strong>.
      </p>
      <p style="margin:0 0 16px;">
        Siempre tendrás acceso a la versión más actualizada desde
        <a href="${miCuentaURL}" target="_blank" rel="noopener" style="color:#0b5fff;text-decoration:none;">https://www.laboroteca.es/mi-cuenta/</a>.
      </p>

      <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:18px 0;background:#f9fafb;">
        <p style="margin:0 0 10px;"><strong>Recuerda</strong></p>
        <p style="margin:0 0 12px;">
          Puedes suscribirte al <strong>Club Laboroteca</strong> para acceder a vídeos, podcast, artículos, novedades,
          sentencias y modelos para reclamaciones.
        </p>
        <p style="margin:0;">
          Más info: <a href="${clubURL}" target="_blank" rel="noopener" style="color:#0b5fff;text-decoration:none;">https://www.laboroteca.es/club-laboroteca/</a>.
        </p>
      </div>

      <p style="margin:16px 0 0;">Atte.,</p>
      <p style="margin:4px 0 0;"><strong>Ignacio Solsona</strong><br/>Abogado</p>
    </div>
  `;
}

function construirTextoPlano({ nombreMostrar, libroElegido }) {
  const miCuentaURL = 'https://www.laboroteca.es/mi-cuenta/';
  const clubURL = 'https://www.laboroteca.es/club-laboroteca/';
  return [
    `¡Enhorabuena${nombreMostrar ? ', ' + nombreMostrar : ''}!`,
    ``,
    `Tu código ha sido canjeado${libroElegido ? ` (${libroElegido})` : ''}.`,
    `Acceso siempre actualizado: ${miCuentaURL}`,
    ``,
    `Recuerda: puedes suscribirte al Club Laboroteca (vídeos, podcast, artículos, novedades, sentencias y modelos).`,
    `Más información: ${clubURL}`,
    ``,
    `Atte.`,
    `Ignacio Solsona`,
    `Abogado`
  ].join('\n');
}

/**
 * Envía el email de canje.
 *
 * @param {Object} params
 * @param {string} params.toEmail           - Email del destinatario (obligatorio)
 * @param {string} [params.nombre]          - Nombre (factura, fallback)
 * @param {string} [params.apellidos]       - Apellidos (factura, fallback)
 * @param {string} [params.libroElegido]    - Nombre del libro (opcional: para mostrar entre paréntesis)
 * @param {string} [params.sessionId]       - ID de sesión/log
 * @param {string} [params.wpUsername]      - user_login de WP (preferente para saludo)
 * @param {string} [params.userAlias]       - alias de usuario (preferente para saludo)
 * @param {string} [params.displayName]     - display_name de WP (preferente para saludo)
 * @returns {Promise<{ok:boolean,id?:string,error?:string}>}
 */
async function enviarEmailCanjeLibro({
  toEmail,
  nombre = '',
  apellidos = '',
  libroElegido,
  sessionId = '',
  wpUsername = '',
  userAlias = '',
  displayName = ''
}) {
  const apiKey = process.env.SMTP2GO_API_KEY
              || process.env.SMTP2GO_KEY
              || process.env.SMTP_API_KEY
              || process.env.SMTP2GO_TOKEN;

  const sender = process.env.SMTP2GO_SENDER
              || process.env.SMTP_SENDER
              || process.env.EMAIL_SENDER
              || process.env.SMTP_FROM
              || process.env.FROM_EMAIL
              || 'Laboroteca <laboroteca@laboroteca.es>';

  if (!apiKey) {
    console.error('❌ Falta API KEY de SMTP2GO (prueba SMTP2GO_API_KEY | SMTP2GO_KEY | SMTP_API_KEY | SMTP2GO_TOKEN)');
    try {
      await alertAdmin({
        area: 'regalos.email.smtp_config_missing',
        err: new Error('SMTP2GO_API_KEY missing'),
        meta: { toEmail: toEmail || null, libro: libroElegido || null }
      });
    } catch (_) {}
    return { ok: false, error: 'SMTP2GO_API_KEY missing' };
  }
  if (!toEmail) {
    return { ok: false, error: 'Parámetros insuficientes (toEmail)' };
  }

  // Nombre a mostrar en el saludo (prioriza WP)
  const pick = v => (String(v || '').trim());
  const nombreMostrar =
    pick(userAlias) ||
    pick(wpUsername) ||
    pick(displayName) ||
    pick([nombre, apellidos].filter(Boolean).join(' ')) ||
    (toEmail ? String(toEmail).split('@')[0] : '');

  const subject = `✅ Código canjeado${libroElegido ? `: ${libroElegido}` : ''}`;

  // Cuerpos + pie RGPD (HTML y texto)
  const html_body = construirHTML({ nombreMostrar, libroElegido }) + '\n' + PIE_HTML;
  const text_body = construirTextoPlano({ nombreMostrar, libroElegido }) + '\n\n' + PIE_TEXT;

  const payload = {
    api_key: apiKey,
    to: [toEmail],
    sender,
    subject,
    text_body,
    html_body,
    custom_headers: [
      { header: 'X-Laboroteca-Evento', value: 'canje-codigo-regalo' },
      ...(sessionId ? [{ header: 'X-Laboroteca-Session-Id', value: String(sessionId) }] : []),
    ],
  };

  try {
    const res = await fetch(SMTP2GO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));

    // éxito típico: data.data.succeeded === 1
    if (!res.ok || (data && data.data && data.data.succeeded !== 1)) {
      console.error('❌ Error SMTP2GO:', res.status, data);
      try {
        await alertAdmin({
          area: 'regalos.email.smtp_send_error',
          err: new Error(`SMTP2GO status ${res.status}`),
          meta: {
            toEmail,
            libro: libroElegido || null,
            subject,
            status: res.status,
            succeeded: data?.data?.succeeded ?? null
          }
        });
      } catch (_) {}
      return { ok: false, error: `SMTP2GO status ${res.status}` };
    }

    const messageId = data?.data?.messages?.[0]?.message_id || '';
    console.log(`📧 Email canje libro enviado a ${toEmail} (${messageId || 'sin id'})`);
    return { ok: true, id: messageId };
  } catch (err) {
    console.error('❌ Excepción SMTP2GO:', err?.message || err);
    try {
      await alertAdmin({
        area: 'regalos.email.smtp_exception',
        err,
        meta: { toEmail, libro: libroElegido || null, subject }
      });
    } catch (_) {}
    return { ok: false, error: String(err?.message || err) };
  }
}

module.exports = { enviarEmailCanjeLibro };
