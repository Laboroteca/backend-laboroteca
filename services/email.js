// services/email.js
require('dotenv').config();
const fetch = require('node-fetch');

/**
 * Envía un email con o sin factura adjunta.
 * @param {Object} opciones - { to, subject, html, text, pdfBuffer, enviarACopy }
 * @returns {Promise<string>}
 */
async function enviarEmailPersonalizado({ to, subject, html, text, pdfBuffer = null, enviarACopy = false }) {
  const destinatarios = Array.isArray(to) ? to : [to];
  if (enviarACopy) destinatarios.push('laboroteca@gmail.com');

  const body = {
    api_key: process.env.SMTP2GO_API_KEY,
    to: destinatarios,
    sender: `"Laboroteca" <${process.env.SMTP2GO_FROM_EMAIL}>`,
    subject: subject,
    html_body: html,
    text_body: text
  };

  // Adjuntar PDF solo si existe
  if (pdfBuffer && Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 5000) {
    body.attachments = [{
      filename: 'Factura Laboroteca.pdf',
      fileblob: pdfBuffer.toString('base64'),
      mimetype: 'application/pdf'
    }];
  }

  const response = await fetch('https://api.smtp2go.com/v3/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const resultado = await response.json();

  if (!resultado.success && resultado.data?.succeeded !== 1) {
    console.error('❌ Error desde SMTP2GO:', JSON.stringify(resultado, null, 2));
    throw new Error('Error al enviar email con SMTP2GO');
  }

  console.log(`✅ Email "${subject}" enviado con éxito a ${destinatarios.join(', ')}`);
  return 'OK';
}

// FUNCIONES DE USO

// ENVÍO DE FACTURA (como antes)
async function enviarFacturaPorEmail(datos, pdfBuffer) {
  const importeTexto = datos.importe ? `${Number(datos.importe).toFixed(2)} €` : 'importe no disponible';
  const nombre = datos.nombre || '';

  return enviarEmailPersonalizado({
    to: datos.email,
    subject: 'Factura de tu compra en Laboroteca',
    html: `
      <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333;">
        <p>Hola ${nombre},</p>
        <p>Gracias por tu compra. Adjuntamos en este correo la factura correspondiente al producto:</p>
        <p><strong>${datos.producto}</strong></p>
        <p>Importe: <strong>${importeTexto}</strong></p>
        <p>Puedes acceder a tu contenido desde <a href="https://laboroteca.es/mi-cuenta">www.laboroteca.es/mi-cuenta</a></p>
        <p>Un afectuoso saludo,<br>Ignacio Solsona</p>
        <hr style="margin-top: 40px; margin-bottom: 10px;" />
        <div style="font-size: 12px; color: #777; line-height: 1.5;">
          En cumplimiento del Reglamento (UE) 2016/679, le informamos que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera, DNI 20481042W, con domicilio en calle Enmedio nº 22, piso 3, puerta E, Castellón de la Plana, CP 12001.<br /><br />
          Su dirección se utiliza con la finalidad de prestarle servicios jurídicos. Usted tiene derecho a retirar su consentimiento en cualquier momento.<br /><br />
          Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición contactando con: ignacio.solsona@icacs.com. También puede presentar una reclamación ante la autoridad de control competente.
        </div>
      </div>
    `,
    text: `
Hola ${nombre},

Gracias por tu compra. Adjuntamos en este correo la factura correspondiente al producto:
- ${datos.producto}
- Importe: ${importeTexto}

Puedes acceder a tu contenido desde: https://laboroteca.es/mi-cuenta

Un afectuoso saludo,
Ignacio Solsona

------------------------------------------------------------
En cumplimiento del Reglamento (UE) 2016/679 (RGPD), su email forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera, DNI 20481042W, con domicilio en calle Enmedio nº 22, piso 3, puerta E, Castellón de la Plana, CP 12001.

Puede ejercer sus derechos en: ignacio.solsona@icacs.com
También puede reclamar ante la autoridad de control si lo considera necesario.
`,
    pdfBuffer
  });
}

// ENVÍO AVISO IMPAGO (intentos 1 y 2, solo al usuario)
async function enviarAvisoImpago(email, nombre, intento, enlacePago) {
  let subject, html, text;
  if (intento === 1) {
    subject = 'Primer aviso: fallo en el cobro de tu suscripción Club Laboroteca';
    html = `
      <p>Estimado/a ${nombre},</p>
      <p>Tu pago de la membresía Club Laboroteca no se ha podido procesar. Lo intentaremos de nuevo en 2 días.</p>
      <p>Si quieres, puedes actualizar tu método de pago aquí:<br>
      <a href="${enlacePago}">${enlacePago}</a></p>
    `;
    text = `Estimado/a ${nombre},\n\nTu pago de la membresía Club Laboroteca no se ha podido procesar. Lo intentaremos de nuevo en 2 días.\nPuedes actualizar tu método de pago aquí: ${enlacePago}`;
  } else {
    subject = 'Segundo aviso: fallo en el cobro de tu suscripción Club Laboroteca';
    html = `
      <p>Estimado/a ${nombre},</p>
      <p>Segundo intento de cobro fallido. Si el próximo pago falla, lamentamos decirte que tendremos que cancelar tu suscripción.</p>
      <p>Si quieres, puedes actualizar tu método de pago aquí:<br>
      <a href="${enlacePago}">${enlacePago}</a></p>
    `;
    text = `Estimado/a ${nombre},\n\nSegundo intento de cobro fallido. Si el próximo pago falla, lamentamos decirte que tendremos que cancelar tu suscripción.\nPuedes actualizar tu método de pago aquí: ${enlacePago}`;
  }

  return enviarEmailPersonalizado({
    to: email,
    subject,
    html,
    text
  });
}

// ENVÍO AVISO CANCELACIÓN (al usuario y a Ignacio)
async function enviarAvisoCancelacion(email, nombre, enlacePago) {
  const subject = 'Tu suscripción Club Laboroteca ha sido cancelada por impago';
  const html = `
    <p>Estimado/a ${nombre},</p>
    <p>Tu suscripción ha sido cancelada por impago. Puedes reactivar en cualquier momento.</p>
    <p>Si deseas reactivar la suscripción o actualizar tu método de pago, utiliza este enlace:<br>
    <a href="${enlacePago}">${enlacePago}</a></p>
  `;
  const text = `Estimado/a ${nombre},\n\nTu suscripción ha sido cancelada por impago. Puedes reactivar en cualquier momento.\nActualizar método de pago: ${enlacePago}`;

  return enviarEmailPersonalizado({
    to: [email, 'laboroteca@gmail.com'],
    subject,
    html,
    text,
    enviarACopy: true
  });
}

module.exports = {
  enviarFacturaPorEmail,
  enviarAvisoImpago,
  enviarAvisoCancelacion
};
