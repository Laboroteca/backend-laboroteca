require('dotenv').config();
const fetch = require('node-fetch');

/**
 * Envía un email con o sin factura adjunta (PDF).
 * @param {Object} opciones - { to, subject, html, text, pdfBuffer, enviarACopy }
 * @returns {Promise<string>}
 */
async function enviarEmailPersonalizado({ to, subject, html, text, pdfBuffer = null, enviarACopy = false }) {
  const destinatarios = Array.isArray(to) ? [...to] : [to];
  if (enviarACopy) destinatarios.push('laboroteca@gmail.com');

  const body = {
    api_key: process.env.SMTP2GO_API_KEY,
    to: destinatarios,
    sender: `"Laboroteca" <${process.env.SMTP2GO_FROM_EMAIL}>`,
    subject,
    html_body: html,
    text_body: text
  };

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
  const successReal = resultado?.data?.succeeded === 1 && resultado?.data?.failed === 0;

  if (!resultado.success && !successReal) {
    console.error('❌ Error real desde SMTP2GO:', JSON.stringify(resultado, null, 2));
    throw new Error('Error al enviar email con SMTP2GO');
  }

  if (successReal) {
    console.log(`✅ Email "${subject}" enviado correctamente a ${destinatarios.join(', ')}`);
  } else {
    console.warn(`⚠️ Advertencia: Email "${subject}" enviado pero con posibles incidencias:`, resultado);
  }

  return 'OK';
}

// ✅ ENVÍO DE FACTURA CON PDF
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
    `.trim(),
    pdfBuffer
  });
}

// ✅ AVISO DE IMPAGO
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
    text = `Estimado/a ${nombre},\n\nTu pago no se ha podido procesar. Lo intentaremos de nuevo en 2 días.\nActualizar método de pago: ${enlacePago}`;
  } else {
    subject = 'Segundo aviso: fallo en el cobro de tu suscripción Club Laboroteca';
    html = `
      <p>Estimado/a ${nombre},</p>
      <p>Segundo intento de cobro fallido. Si el próximo pago falla, lamentamos decirte que tendremos que cancelar tu suscripción.</p>
      <p>Si quieres, puedes actualizar tu método de pago aquí:<br>
      <a href="${enlacePago}">${enlacePago}</a></p>
    `;
    text = `Estimado/a ${nombre},\n\nSegundo intento fallido. Si el próximo pago falla, se cancelará tu suscripción.\nActualizar método de pago: ${enlacePago}`;
  }

  return enviarEmailPersonalizado({ to: email, subject, html, text });
}

// ✅ CANCELACIÓN POR IMPAGO (con copia)
async function enviarAvisoCancelacion(email, nombre, enlacePago) {
  const subject = 'Tu suscripción Club Laboroteca ha sido cancelada por impago';
  const html = `
    <p>Estimado/a ${nombre},</p>
    <p>Tu suscripción ha sido cancelada por impago. Puedes reactivarla en cualquier momento.</p>
    <p>Enlace para reactivación:<br>
    <a href="${enlacePago}">${enlacePago}</a></p>
  `;
  const text = `Estimado/a ${nombre},\n\nTu suscripción ha sido cancelada por impago. Puedes reactivarla en cualquier momento.\nEnlace: ${enlacePago}`;

  return enviarEmailPersonalizado({
    to: [email],
    subject,
    html,
    text,
    enviarACopy: true
  });
}

// ✅ CONFIRMACIÓN DE BAJA VOLUNTARIA
async function enviarConfirmacionBajaClub(email, nombre = '') {
  const subject = 'Confirmación de baja del Club Laboroteca';
  const html = `
    <p>Hola ${nombre},</p>
    <p>Te confirmamos que se ha cursado correctamente tu baja del <strong>Club Laboroteca</strong>.</p>
    <p>Puedes volver a hacerte miembro en cualquier momento, por el mismo precio y sin compromiso de permanencia.</p>
    <p>Un saludo,<br>Laboroteca</p>
  `;
  const text = `
Hola ${nombre},

Te confirmamos que se ha cursado correctamente tu baja del Club Laboroteca.

Puedes volver a hacerte miembro en cualquier momento, por el mismo precio y sin compromiso de permanencia.

Un saludo,
Laboroteca
  `.trim();

  return enviarEmailPersonalizado({
    to: [email],
    subject,
    html,
    text,
    enviarACopy: true
  });
}

module.exports = {
  enviarFacturaPorEmail,
  enviarAvisoImpago,
  enviarAvisoCancelacion,
  enviarConfirmacionBajaClub
};
