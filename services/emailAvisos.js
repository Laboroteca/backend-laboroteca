require('dotenv').config();
const fetch = require('node-fetch');

// Helpers PII-safe y saneado básico
const maskEmail = (e='') => {
  const [u,d] = String(e).split('@');
  if (!u || !d) return '***';
  return `${u.slice(0,2)}***@***${d.slice(Math.max(0,d.length-3))}`;
};
// quita scripts y normaliza <br>, permite markup simple controlado
const sanitizeHtml = (s='') =>
  String(s)
    .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '<br>')
    .trim();

// convierte HTML “simple” a texto: <br>→\n y quita etiquetas
const htmlToText = (s='') =>
  String(s)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();

async function enviarEmailAvisoImpago({ to, subject, body, bccAdmin=false, replyTo='laboroteca@gmail.com' }) {
  // Validación de entrada
  if (!to || !subject || !body) {
    throw new Error('Faltan campos obligatorios para enviar el aviso de email.');
  }
  const API_KEY = String(process.env.SMTP2GO_API_KEY || '').trim();
  const FROM = String(process.env.SMTP2GO_FROM_EMAIL || '').trim();
  if (!API_KEY || !FROM) {
    throw new Error('SMTP2GO_API_KEY o SMTP2GO_FROM_EMAIL no configurados.');
  }

  // Saneado y construcción de cuerpos
  const safeSubject = String(subject).replace(/\r?\n/g, ' ').slice(0, 250);
  const safeHtmlBody = sanitizeHtml(body);
  const html_body = `
    <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333;">
      ${safeHtmlBody}
      <br><br>
      <p style="font-size:13px; color:#888; margin-top:30px;">
        Si tienes cualquier duda, contacta con Ignacio Solsona – 
        <a href="mailto:laboroteca@gmail.com">laboroteca@gmail.com</a>
      </p>
    </div>
  `.trim();

  const text_body = htmlToText(safeHtmlBody + '\n\nSi tienes dudas, escribe a: laboroteca@gmail.com');

  // BCC opcional sin exponer destinatarios
  const SEND_ADMIN_COPY = String(process.env.SEND_ADMIN_COPY || 'false').toLowerCase() === 'true';
  const bcc = (bccAdmin && SEND_ADMIN_COPY) ? ['laboroteca@gmail.com'] : [];

  // Cabeceras útiles de entregabilidad
  const custom_headers = [
    { header: 'List-Unsubscribe', value: '<mailto:laboroteca@gmail.com>, <https://www.laboroteca.es/unsubscribe>' },
    { header: 'X-Auto-Response-Suppress', value: 'All' }
  ];

  const payload = {
    api_key: API_KEY,
    to: [to],
    bcc,
    sender: `"Laboroteca" <${FROM}>`,
    subject: safeSubject,
    html_body,
    text_body,
    reply_to: `"Laboroteca" <${replyTo}>`,
    custom_headers
  };

  let response, raw;
  try {
    response = await fetch('https://api.smtp2go.com/v3/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload)
    });
    raw = await response.text();
  } catch (netErr) {
    console.error('❌ SMTP2GO network error:', netErr?.message || netErr);
    throw new Error('No se pudo contactar con el proveedor de email');
  }

  let resultado;
  try { resultado = JSON.parse(raw); } catch { resultado = { success:false, raw }; }

  const succeeded = Number(resultado?.data?.succeeded ?? 0);
  const failed = Number(resultado?.data?.failed ?? 0);
  const ok = (resultado?.success === true) || (succeeded >= 1 && failed === 0);

  if (!ok) {
    console.error('❌ Error SMTP2GO:', {
      httpStatus: response?.status,
      succeeded, failed,
      snippet: (resultado?.raw || raw || '').slice(0, 400)
    });
    throw new Error('Error al enviar aviso de impago con SMTP2GO');
  }

  console.log('✅ Aviso de impago enviado a', maskEmail(to));
  return 'OK';
}

module.exports = { enviarEmailAvisoImpago };
