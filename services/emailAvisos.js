require('dotenv').config();
const fetch = require('node-fetch');

async function enviarEmailAvisoImpago({ to, subject, body }) {
  try {
    if (!to || !subject || !body) {
      throw new Error('Faltan campos obligatorios para enviar el aviso de email.');
    }

    const html_body = `
      <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333;">
        ${body}
        <br><br>
        <p style="font-size:13px; color: #888; margin-top:30px;">
          Si tienes cualquier duda, contacta con Ignacio Solsona – <a href="mailto:laboroteca@gmail.com">laboroteca@gmail.com</a>
        </p>
      </div>
    `;

    const text_body = body.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');

    const response = await fetch('https://api.smtp2go.com/v3/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.SMTP2GO_API_KEY,
        to: [to],
        sender: `"Laboroteca" <${process.env.SMTP2GO_FROM_EMAIL}>`,
        subject,
        html_body,
        text_body
      })
    });

    const resultado = await response.json();

    if (!resultado.success && resultado.data?.succeeded !== 1) {
      console.error('❌ Error desde SMTP2GO:', JSON.stringify(resultado, null, 2));
      throw new Error('Error al enviar aviso de impago con SMTP2GO');
    }

    console.log('✅ Aviso de impago enviado a', to);
    return 'OK';
  } catch (error) {
    console.error('❌ Error al enviar email de aviso de impago:', error);
    throw error;
  }
}

module.exports = { enviarEmailAvisoImpago };
