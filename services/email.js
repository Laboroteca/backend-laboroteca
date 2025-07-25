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

  const pieHtml = `
    <hr style="margin-top: 40px; margin-bottom: 10px;" />
    <div style="font-size: 12px; color: #777; line-height: 1.5;">
      En cumplimiento del Reglamento (UE) 2016/679, le informamos que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera, DNI 20481042W, con domicilio en calle Enmedio nº 22, piso 3, puerta E, Castellón de la Plana, CP 12001.<br /><br />
      Su dirección se utiliza con la finalidad de prestarle servicios jurídicos. Usted tiene derecho a retirar su consentimiento en cualquier momento.<br /><br />
      Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición contactando con: ignacio.solsona@icacs.com. También puede presentar una reclamación ante la autoridad de control competente.
    </div>
  `;

  const pieText = `
------------------------------------------------------------
En cumplimiento del Reglamento (UE) 2016/679 (RGPD), su email forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera, DNI 20481042W, con domicilio en calle Enmedio nº 22, piso 3, puerta E, Castellón de la Plana, CP 12001.

Puede ejercer sus derechos en: ignacio.solsona@icacs.com
También puede reclamar ante la autoridad de control si lo considera necesario.
  `;

  const body = {
    api_key: process.env.SMTP2GO_API_KEY,
    to: destinatarios,
    sender: `"Laboroteca" <${process.env.SMTP2GO_FROM_EMAIL}>`,
    subject,
    html_body: html + pieHtml,
    text_body: text + '\n\n' + pieText
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
  const producto = (datos.producto || '').toLowerCase();

  const esClub = producto.includes('club laboroteca');

  const subject = esClub
    ? 'Factura mensual de tu suscripción al Club Laboroteca'
    : 'Factura de tu compra en Laboroteca';

  const html = esClub
    ? `
      <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333;">
        <p>Estimado miembro del Club Laboroteca,</p>
        <p>Adjuntamos a este correo la factura correspondiente a tu suscripción mensual.</p>
        <p>Importe: <strong>${importeTexto}</strong></p>
        <p>Muchas gracias por pertenecer al Club Laboroteca.</p>
        <p>Puedes acceder a todas las novedades desde:<br>
        <a href="https://www.laboroteca.es/club-laboroteca/">https://www.laboroteca.es/club-laboroteca/</a></p>
        <p>Un saludo,<br>Ignacio Solsona<br>Abogado</p>
      </div>
    `
    : `
      <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333;">
        <p>Hola ${nombre},</p>
        <p>Gracias por tu compra. Adjuntamos en este correo la factura correspondiente al producto:</p>
        <p><strong>${datos.producto}</strong></p>
        <p>Importe: <strong>${importeTexto}</strong></p>
        <p>Puedes acceder a tu contenido desde <a href="https://laboroteca.es/mi-cuenta">www.laboroteca.es/mi-cuenta</a></p>
        <p>Un afectuoso saludo,<br>Ignacio Solsona</p>
      </div>
    `;

  const text = esClub
    ? `Estimado miembro del Club Laboroteca,

Adjuntamos a este correo la factura correspondiente a tu suscripción mensual.
Importe: ${importeTexto}

Muchas gracias por pertenecer al Club Laboroteca.
Puedes acceder a todas las novedades desde: https://www.laboroteca.es/club-laboroteca/

Un saludo,
Ignacio Solsona
Abogado`
    : `Hola ${nombre},

Gracias por tu compra. Adjuntamos en este correo la factura correspondiente al producto:
- ${datos.producto}
- Importe: ${importeTexto}

Puedes acceder a tu contenido desde: https://laboroteca.es/mi-cuenta

Un afectuoso saludo,
Ignacio Solsona`;

  return enviarEmailPersonalizado({
    to: datos.email,
    subject,
    html,
    text,
    pdfBuffer
  });
}

// ✅ AVISO DE IMPAGO (hasta 3 intentos)
async function enviarAvisoImpago(email, nombre, intento, enlacePago) {
  let subject, html, text;

  if (intento === 1) {
    subject = 'Primer aviso: fallo en el cobro de tu suscripción Club Laboroteca';
    html = `
      <p>Hola ${nombre},</p>
      <p>Tu pago de la membresía del Club Laboroteca no se ha podido procesar. Lo intentaremos de nuevo en 3 días.</p>
      <p>Puedes actualizar tu método de pago aquí:<br><a href="${enlacePago}">${enlacePago}</a></p>
    `;
    text = `Hola ${nombre},\n\nTu pago no se ha podido procesar. Lo intentaremos de nuevo en 3 días.\nActualizar método de pago: ${enlacePago}`;
  } else if (intento === 2) {
    subject = 'Segundo aviso: segundo intento de cobro fallido';
    html = `
      <p>Hola ${nombre},</p>
      <p>Seguimos sin poder procesar tu suscripción al Club Laboroteca. Queda un último intento antes de que se cancele automáticamente.</p>
      <p>Actualiza tu método de pago aquí:<br><a href="${enlacePago}">${enlacePago}</a></p>
    `;
    text = `Hola ${nombre},\n\nSeguimos sin poder cobrar tu suscripción. Queda un último intento antes de cancelarse.\nActualizar método de pago: ${enlacePago}`;
  } else if (intento === 3) {
    subject = 'Último aviso: último intento antes de la cancelación';
    html = `
      <p>Hola ${nombre},</p>
      <p>Este es el último intento para cobrar tu suscripción al Club Laboroteca. Si vuelve a fallar, se cancelará automáticamente.</p>
      <p>Aún estás a tiempo de evitarlo:<br><a href="${enlacePago}">${enlacePago}</a></p>
    `;
    text = `Hola ${nombre},\n\nÚltimo intento para cobrar tu suscripción. Si falla, se cancelará automáticamente.\nActualizar método de pago: ${enlacePago}`;
  } else {
    subject = 'Fallo de pago en tu suscripción Club Laboroteca';
    html = `
      <p>Hola ${nombre},</p>
      <p>Se ha producido un fallo en el cobro de tu suscripción al Club Laboroteca.</p>
      <p>Puedes revisar tu método de pago aquí:<br><a href="${enlacePago}">${enlacePago}</a></p>
    `;
    text = `Hola ${nombre},\n\nFallo en el cobro de tu suscripción.\nActualizar método de pago: ${enlacePago}`;
  }

  return enviarEmailPersonalizado({ to: email, subject, html, text });
}

// ✅ CANCELACIÓN POR IMPAGO (con copia)
async function enviarAvisoCancelacion(email, nombre, enlacePago) {
  const subject = 'Tu suscripción Club Laboroteca ha sido cancelada por impago';
  const html = `
    <p>Hola ${nombre},</p>
    <p>Tu suscripción ha sido cancelada por impago. Puedes reactivarla en cualquier momento.</p>
    <p>Enlace para reactivación:<br><a href="${enlacePago}">${enlacePago}</a></p>
  `;
  const text = `Hola ${nombre},\n\nTu suscripción ha sido cancelada por impago. Puedes reactivarla en cualquier momento.\nEnlace: ${enlacePago}`;

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
    <p><strong>Te confirmamos que se ha cursado correctamente tu baja del Club Laboroteca</strong>.</p>
    <p>Puedes volver a hacerte miembro en cualquier momento, por el mismo precio y sin compromiso de permanencia.</p>
    <p>Un saludo,<br>Laboroteca</p>
  `;
  const text = `Hola ${nombre},\n\nTe confirmamos que se ha cursado correctamente tu baja del Club Laboroteca.\n\nPuedes volver a hacerte miembro en cualquier momento, por el mismo precio y sin compromiso de permanencia.\n\nUn saludo,\nLaboroteca`;

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
