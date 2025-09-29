// 📂 regalos/services/enviarEmailCanjeLibro.js
/**
 * Envía email de confirmación del canje (PRE-/REG-) usando SMTP2GO API.
 * Node 18+ (fetch nativo). Sin dependencias externas.
 *
 * Variables de entorno (por orden):
 *   API KEY:   SMTP2GO_API_KEY | SMTP2GO_KEY | SMTP_API_KEY | SMTP2GO_TOKEN
 *   SENDER:    SMTP2GO_SENDER  | SMTP_SENDER | EMAIL_SENDER | SMTP_FROM | FROM_EMAIL
 */

'use strict';

const SMTP2GO_ENDPOINT = 'https://api.smtp2go.com/v3/email/send';
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

// ── helpers RGPD/seguridad
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e||''));
const maskEmail = (e='') => {
  const s = String(e||''); const i = s.indexOf('@'); if (i<1) return s ? '***' : '';
  const u=s.slice(0,i), d=s.slice(i+1);
  return `${(u.slice(0,2)||'*')}***@***${d.slice(-3)}`;
};
const esc = (t='') => String(t)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');


/* ─────────────────────────────────────────
 * Pie RGPD (14px, #777777) – actualizado
 * ───────────────────────────────────────── */
const PIE_HTML = `
  <hr style="margin:16px 0;border:0;border-top:1px solid #bbb;" />
  <div style="font-family:Arial,sans-serif;font-size:14px;color:#777;line-height:1.4;">
    En cumplimiento del Reglamento (UE) 2016/679 (RGPD) y la LOPDGDD, le informamos de que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera (DNI 20481042W), con domicilio en calle Enmedio nº 22, 3.º E, 12001 Castellón de la Plana (España).<br /><br />
    Finalidades: prestación de servicios jurídicos, venta de infoproductos, gestión de entradas a eventos, emisión y envío de facturas por email y, en su caso, envío de newsletter y comunicaciones comerciales si usted lo ha consentido. Base jurídica: ejecución de contrato y/o consentimiento. Puede retirar su consentimiento en cualquier momento.<br /><br />
    Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición escribiendo a <a href="mailto:laboroteca@gmail.com">laboroteca@gmail.com</a>. También puede presentar una reclamación ante la autoridad de control competente. Más información en nuestra política de privacidad: <a href="https://www.laboroteca.es/politica-de-privacidad/">https://www.laboroteca.es/politica-de-privacidad/</a>.
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

/* ─────────────────────────────────────────
 * Construcción del cuerpo (SIN “Recuerda”)
 * ───────────────────────────────────────── */
function construirHTMLBase({ nombreMostrar, libroElegido }) {
  const miCuentaURL = 'https://www.laboroteca.es/mi-cuenta/';
  // Cuerpo completo unificado
  return `
  <div style="font-family:Arial,sans-serif;font-size:16px;color:#333;line-height:1.4;">
    <p style="margin:0 0 12px;">¡Enhorabuena${nombreMostrar ? ', ' + nombreMostrar : ''}!</p>
    <p style="margin:0 0 12px;"><strong>Tu código ha sido canjeado${libroElegido ? ` (${libroElegido})` : ''}.</strong></p>

    <p style="margin:0 0 16px;">
      Siempre tendrás acceso a la versión más actualizada desde
      <a href="${miCuentaURL}">https://www.laboroteca.es/mi-cuenta/</a>.
    </p>

    <p style="margin:16px 0 0;">Atte.,</p>
    <p style="margin:4px 0 0;">Ignacio Solsona<br/>Abogado</p>
  </div>
`;

}

function construirTextoPlanoBase({ nombreMostrar, libroElegido }) {
  const miCuentaURL = 'https://www.laboroteca.es/mi-cuenta/';
  return [
    `¡Enhorabuena${nombreMostrar ? ', ' + nombreMostrar : ''}!`,
    ``,
    `Tu código ha sido canjeado${libroElegido ? ` (${libroElegido})` : ''}.`,
    `Siempre tendrás acceso a la versión más actualizada desde ${miCuentaURL}.`,
    ``,
    `Atte.,`,
    `Ignacio Solsona`,
    `Abogado`
  ].join('\n');
}

/* ─────────────────────────────────────────
 * ADVERTENCIA + separadores (opcional)
 * ───────────────────────────────────────── */
const advertenciaHtml = `
  <!-- Color gris SOLO para la advertencia -->
  <div style="font-size:14px; line-height:1.4; margin:8px 0; color:#606296;">
    <strong>Importante:</strong> Todos los contenidos están protegidos por derechos de autor. Tu acceso es personal e intransferible. Se prohíbe compartir tus credenciales de acceso o difundir el contenido sin autorización expresa. Cualquier uso indebido o sospechoso podrá dar lugar a la suspensión o cancelación de la cuenta.
  </div>
`.trim();

// Separadores: superior con espacio extra (~2–3 líneas) y luego uno normal
const sepHtml = `<hr style="margin:16px 0;border:0;border-top:1px solid #bbb;" />`;
const sepSuperiorHtml = `
  <div style="height:2.6em;line-height:1.6;"></div>
  <hr style="margin:16px 0;border:0;border-top:1px solid #bbb;" />
`.trim();

const advertenciaText = `IMPORTANTE: tu acceso es personal e intransferible. Queda prohibido compartir tus claves con terceros o distribuir el material sin autorización. Si se detecta actividad sospechosa o irregular se puede suspender o bloquear la cuenta.`;
const sepText = '------------------------------------------------------------';

/* ─────────────────────────────────────────
 * Envío
 * ───────────────────────────────────────── */
async function enviarEmailCanjeLibro({
  toEmail,
  nombre = '',
  apellidos = '',
  libroElegido,
  sessionId = '',
  wpUsername = '',
  userAlias = '',
  displayName = '',
  incluirAdvertencia = true, // ← por defecto SÍ incluimos la advertencia
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
    console.error('❌ Falta API KEY de SMTP2GO (SMTP2GO_API_KEY | SMTP2GO_KEY | SMTP_API_KEY | SMTP2GO_TOKEN)');
    try {
      await alertAdmin({
        area: 'regalos.email.smtp_config_missing',
        err: new Error('SMTP2GO_API_KEY missing'),
        meta: { toEmail: toEmail || null, libro: libroElegido || null }
      });
    } catch (_) {}
    return { ok: false, error: 'SMTP2GO_API_KEY missing' };
  }
  if (!toEmail || !isEmail(toEmail)) {
    return { ok: false, error: 'Parámetros insuficientes (toEmail)' };
  }

  // Saludo preferente con alias/usuario/displayName
  const pick = v => (String(v || '').trim());
  const nombreMostrar =
    pick(userAlias) ||
    pick(wpUsername) ||
    pick(displayName) ||
    pick([nombre, apellidos].filter(Boolean).join(' ')) ||
    (toEmail ? String(toEmail).split('@')[0] : '');

  const subject = `Código canjeado${libroElegido ? `: ${String(libroElegido).trim()}` : ''}`;

  // Base sin “Recuerda”
  const htmlBase = construirHTMLBase({
    nombreMostrar: esc(nombreMostrar),
    libroElegido : libroElegido ? esc(String(libroElegido).trim()) : ''
  });
  const textBase = construirTextoPlanoBase({ nombreMostrar, libroElegido });

  // Ensamblado final con ADVERTENCIA y PIE RGPD
  const html_body = incluirAdvertencia
    ? (htmlBase + '\n' + sepSuperiorHtml + '\n' + advertenciaHtml + '\n' + sepHtml + '\n' + PIE_HTML)
    : (htmlBase + '\n' + sepHtml + '\n' + PIE_HTML);

  const text_body = incluirAdvertencia
    ? [textBase, '', '', '', sepText, advertenciaText, sepText, '', PIE_TEXT].join('\n')
    : [textBase, '', sepText, '', PIE_TEXT].join('\n');

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

  // Reintentos suaves para fallos de red/5xx
  const sendOnce = async () => {
    const res = await fetch(SMTP2GO_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || (data && data.data && data.data.succeeded !== 1)) {
      console.error('❌ Error SMTP2GO:', res.status, data);
      try {
        await alertAdmin({
          area: 'regalos.email.smtp_send_error',
          email: toEmail,
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
      throw new Error(`SMTP2GO status ${res.status}`);
    }

    const messageId = data?.data?.messages?.[0]?.message_id || '';
    console.log(`📧 Email canje libro enviado a ${maskEmail(toEmail)} (${messageId || 'sin id'})`);
    return { ok:true, id: messageId };
  };

  try {
    // 3 intentos: 0ms, 400ms, 1600ms si 5xx/red
    const tries = [0, 400, 1600];
    let lastErr;
    for (const wait of tries) {
      try { if (wait) await new Promise(r=>setTimeout(r, wait)); return await sendOnce(); }
      catch (e) { lastErr = e; if (!(String(e.message||'').includes('5') || String(e.message||'').includes('status'))) break; }
    }
    throw lastErr;
  } catch (err) {
    console.error('❌ Excepción SMTP2GO:', err?.message || err);
    try {
      await alertAdmin({
        area: 'regalos.email.smtp_exception',
        email: toEmail,
        err,
        meta: { toEmail, libro: libroElegido || null, subject }
      });
    } catch (_) {}
    return { ok: false, error: String(err?.message || err) };
  }
}

module.exports = { enviarEmailCanjeLibro };
