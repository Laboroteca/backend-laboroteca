// regalos/services/enviarEmailCanjeLibro.js
/**
 * Envía email de confirmación del canje (PRE-/REG-) usando SMTP2GO API.
 * No añade dependencias. Node 18+ (fetch nativo).
 *
 * Variables de entorno admitidas (prueba en este orden):
 *   API KEY:   SMTP2GO_API_KEY | SMTP2GO_KEY | SMTP_API_KEY | SMTP2GO_TOKEN
 *   SENDER:    SMTP2GO_SENDER  | SMTP_SENDER | EMAIL_SENDER | SMTP_FROM | FROM_EMAIL
 */

const SMTP2GO_ENDPOINT = 'https://api.smtp2go.com/v3/email/send';

// --- Pie RGPD unificado (mismo separador y estilos) ---
const PIE_HTML = `
  <hr style="margin-top: 40px; margin-bottom: 10px;" />
  <div style="font-size: 12px; color: #777; line-height: 1.5;">
    En cumplimiento del Reglamento (UE) 2016/679, le informamos que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera, DNI 20481042W, con domicilio en calle Enmedio nº 22, piso 3, puerta E, Castellón de la Plana, CP 12001.<br /><br />
    Su dirección se utiliza con la finalidad de prestarle servicios jurídicos. Usted tiene derecho a retirar su consentimiento en cualquier momento.<br /><br />
    Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición contactando con: <a href="mailto:laboroteca@gmail.com">laboroteca@gmail.com</a>. También puede presentar una reclamación ante la autoridad de control competente.
  </div>
`.trim();

const PIE_TEXT = `
------------------------------------------------------------
En cumplimiento del Reglamento (UE) 2016/679 (RGPD), su email forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera, DNI 20481042W, con domicilio en calle Enmedio nº 22, piso 3, puerta E, Castellón de la Plana, CP 12001.

Puede ejercer sus derechos en: laboroteca@gmail.com
También puede reclamar ante la autoridad de control si lo considera necesario.
`.trim();

function construirHTML({ nombreMostrar, libroElegido }) {
  const miCuentaURL = 'https://www.laboroteca.es/mi-cuenta/';
  const clubURL = 'https://www.laboroteca.es/club-laboroteca/';
  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#111;">
      <h2 style="margin:0 0 12px;">¡Enhorabuena${nombreMostrar ? ', ' + nombreMostrar : ''}!</h2>
      <p style="margin:0 0 12px;">
        Tu código ha sido canjeado por el libro <strong>${libroElegido}</strong>.
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
      <p style="margin:4px 0 0;"><strong>Ignacio Solsona</strong>. Abogado</p>
    </div>
  `;
}

function construirTextoPlano({ nombreMostrar, libroElegido }) {
  const miCuentaURL = 'https://www.laboroteca.es/mi-cuenta/';
  const clubURL = 'https://www.laboroteca.es/club-laboroteca/';
  return [
    `¡Enhorabuena${nombreMostrar ? ', ' + nombreMostrar : ''}!`,
    ``,
    `Tu código ha sido canjeado por el libro: ${libroElegido}.`,
    `Acceso siempre actualizado: ${miCuentaURL}`,
    ``,
    `Recuerda: puedes suscribirte al Club Laboroteca (vídeos, podcast, artículos, novedades, sentencias y modelos).`,
    `Más información: ${clubURL}`,
    ``,
    `Atte. Ignacio Solsona. Abogado`,
  ].join('\n');
}

async function enviarEmailCanjeLibro({ toEmail, nombre = '', apellidos = '', libroElegido, sessionId = '' }) {
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
    return { ok: false, error: 'SMTP2GO_API_KEY missing' };
  }
  if (!toEmail || !libroElegido) {
    return { ok: false, error: 'Parámetros insuficientes (toEmail/libroElegido)' };
  }

  const nombreMostrar = [nombre, apellidos].filter(Boolean).join(' ').trim();
  const subject = `✅ Código canjeado: ${libroElegido}`;

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
      return { ok: false, error: `SMTP2GO status ${res.status}` };
    }

    const messageId = data?.data?.messages?.[0]?.message_id || '';
    console.log(`📧 Email canje libro enviado a ${toEmail} (${messageId || 'sin id'})`);
    return { ok: true, id: messageId };
  } catch (err) {
    console.error('❌ Excepción SMTP2GO:', err?.message || err);
    return { ok: false, error: String(err?.message || err) };
  }
}

module.exports = { enviarEmailCanjeLibro };
