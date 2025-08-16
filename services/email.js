require('dotenv').config(); 
const fetch = require('node-fetch');

/**
 * Envía un email con o sin factura adjunta (PDF).
 * @param {Object} opciones - { to, subject, html, text, pdfBuffer, enviarACopy }
 * @returns {Promise<string>}
 */
async function enviarEmailPersonalizado({ to, subject, html, text, pdfBuffer = null, enviarACopy = false, attachments = [] }) {
  const destinatarios = Array.isArray(to) ? [...to] : [to];
  if (enviarACopy) destinatarios.push('laboroteca@gmail.com');

  const pieHtml = `
    <hr style="margin-top: 40px; margin-bottom: 10px;" />
    <div style="font-size: 12px; color: #777; line-height: 1.5;">
      En cumplimiento del Reglamento (UE) 2016/679, le informamos que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera, DNI 20481042W, con domicilio en calle Enmedio nº 22, piso 3, puerta E, Castellón de la Plana, CP 12001.<br /><br />
      Su dirección se utiliza con la finalidad de prestarle servicios jurídicos. Usted tiene derecho a retirar su consentimiento en cualquier momento.<br /><br />
      Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición contactando con: laboroteca@gmail.com. También puede presentar una reclamación ante la autoridad de control competente.
    </div>
  `;

  const pieText = `
------------------------------------------------------------
En cumplimiento del Reglamento (UE) 2016/679 (RGPD), su email forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera, DNI 20481042W, con domicilio en calle Enmedio nº 22, piso 3, puerta E, Castellón de la Plana, CP 12001.

Puede ejercer sus derechos en: laboroteca@gmail.com
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

// 🔁 Añadir adjuntos si vienen por `attachments` o por `pdfBuffer`
    if (Array.isArray(attachments) && attachments.length > 0) {
      body.attachments = attachments;
    } else if (pdfBuffer && Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 5000) {
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

  const esClub =
    (datos.tipoProducto && datos.tipoProducto.toString().toLowerCase() === 'club') ||
    [datos.producto, datos.nombreProducto, datos.descripcionProducto]
      .filter(Boolean)
      .map(s => s.toString().toLowerCase())
      .some(s => s.includes('club laboroteca'));

  // 👉 Nombre del producto a mostrar cuando NO es Club
  const nombreProductoMostrar = datos.nombreProducto || datos.descripcionProducto || 'Producto Laboroteca';

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
        <p><strong>${nombreProductoMostrar}</strong></p>
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
- ${nombreProductoMostrar}
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


// ✅ AVISO DE IMPAGO (cancelación inmediata, sin reintentos)
async function enviarAvisoImpago(email, nombre, intento, enlacePago = "https://www.laboroteca.es/membresia-club-laboroteca/", cancelarYa = false) {
  let subject, html, text;

  subject = 'Tu suscripción al Club Laboroteca ha sido CANCELADA por fallo en el pago';
  html = `
    <p>Hola ${nombre || ''},</p>
<p>No hemos podido procesar el cobro de tu suscripción mensual al Club Laboroteca.</p>
<p><b>Tu suscripción ha sido cancelada automáticamente.</b></p>
<p>
  <span style="color:#279052;">
    Puedes reactivarla en cualquier momento desde este enlace, <b>sin penalización y con el mismo precio</b>:
  </span>
</p>
<p>
  <a href="https://www.laboroteca.es/membresia-club-laboroteca/">https://www.laboroteca.es/membresia-club-laboroteca/</a>
</p>
<p>Si crees que se trata de un error, revisa tu método de pago o tarjeta.</p>

  `;
  text = `Hola ${nombre || ''},

No hemos podido cobrar tu suscripción mensual al Club Laboroteca y ha sido cancelada automáticamente.

Puedes reactivarla cuando quieras (sin penalización) aquí: https://www.laboroteca.es/membresia-club-laboroteca/

Si necesitas ayuda, contacta con Laboroteca.`;

  // Siempre enviamos el aviso único (no hay reintentos)
  return enviarEmailPersonalizado({ to: email, subject, html, text });
}

// ✅ CANCELACIÓN POR IMPAGO (puede usarse también si quieres notificar al admin)
async function enviarAvisoCancelacion(email, nombre, enlacePago = "https://www.laboroteca.es/membresia-club-laboroteca/") {
  const subject = 'Tu suscripción Club Laboroteca ha sido cancelada por impago';
  const html = `
    <p>Hola ${nombre},</p>
    <p>Tu suscripción ha sido cancelada por impago. Puedes reactivarla en cualquier momento por el mismo precio, sin ninguna penalización.</p>
    <p>Enlace para reactivación:<br><a href="https://www.laboroteca.es/membresia-club-laboroteca/">https://www.laboroteca.es/membresia-club-laboroteca/</a></p>
  `;
  const text = `Hola ${nombre},

Tu suscripción ha sido cancelada por impago. Puedes reactivarla en cualquier momento por el mismo precio, sin ninguna penalización.
Enlace: https://www.laboroteca.es/membresia-club-laboroteca/`;

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
    <p>Reactivar: <a href="https://www.laboroteca.es/membresia-club-laboroteca/">https://www.laboroteca.es/membresia-club-laboroteca/</a></p>
    <p>Un saludo,<br>Laboroteca</p>
  `;
  const text = `Hola ${nombre},

Te confirmamos que se ha cursado correctamente tu baja del Club Laboroteca.

Puedes volver a hacerte miembro en cualquier momento, por el mismo precio y sin compromiso de permanencia.
Reactivar: https://www.laboroteca.es/membresia-club-laboroteca/

Un saludo,
Laboroteca`;

  return enviarEmailPersonalizado({
    to: [email],
    subject,
    html,
    text,
    enviarACopy: true
  });
}

// ✅ EMAIL DE VALIDACIÓN PARA ELIMINAR CUENTA
async function enviarEmailValidacionEliminacionCuenta(email, token) {
  const enlace = `https://www.laboroteca.es/confirmar-eliminacion-cuenta/?token=${token}`;
  const subject = 'Confirmación de eliminación de tu cuenta en Laboroteca';
  const html = `
    <p>Hola,</p>
    <p>Has solicitado eliminar tu cuenta en Laboroteca. Para confirmar esta acción, pulsa en el siguiente enlace:</p>
    <p><a href="${enlace}" style="font-weight: bold;">Confirmar eliminación de cuenta</a></p>
    <p>Si no has solicitado esta acción, ignora este correo. El enlace caducará en 2 horas.</p>
  `;
  const text = `Has solicitado eliminar tu cuenta en Laboroteca.

Para confirmar esta acción, accede a este enlace (válido 2 horas):
${enlace}

Si no lo has solicitado tú, ignora este mensaje.`;

  return enviarEmailPersonalizado({
    to: email,
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
  enviarConfirmacionBajaClub,
  enviarEmailValidacionEliminacionCuenta,
  enviarEmailPersonalizado //
};
