require('dotenv').config();
const fetch = require('node-fetch');
const { alertAdmin } = require('../utils/alertAdmin');

/**
 * Envía un email con o sin factura adjunta (PDF).
 * @param {Object} opciones - { to, subject, html, text, pdfBuffer, enviarACopy, attachments }
 * @returns {Promise<string>}
 */
async function enviarEmailPersonalizado({ to, subject, html, text, pdfBuffer = null, enviarACopy = false, attachments = [] }) {
  const destinatarios = Array.isArray(to) ? [...to] : [to];
  const SEND_ADMIN_COPY = String(process.env.SEND_ADMIN_COPY || 'false').toLowerCase() === 'true';
  if (enviarACopy && SEND_ADMIN_COPY && !destinatarios.includes('laboroteca@gmail.com')) {
    destinatarios.push('laboroteca@gmail.com');
  }

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

  // Adjuntos
  if (Array.isArray(attachments) && attachments.length > 0) {
    body.attachments = attachments;
  } else if (pdfBuffer && Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 5000) {
    body.attachments = [{
      filename: 'Factura Laboroteca.pdf',
      fileblob: pdfBuffer.toString('base64'),
      mimetype: 'application/pdf'
    }];
  }

  let response, resultado, successReal;

  try {
    response = await fetch('https://api.smtp2go.com/v3/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const raw = await response.text();
    try {
      resultado = JSON.parse(raw);
    } catch {
      resultado = { success: false, data: {}, raw };
    }

    successReal = resultado?.data?.succeeded === 1 && resultado?.data?.failed === 0;

    if (!resultado.success && !successReal) {
      console.error('Error real desde SMTP2GO:', typeof resultado.raw === 'string' ? resultado.raw : JSON.stringify(resultado, null, 2));

      try {
        await alertAdmin({
          area: 'smtp2go_send',
          email: Array.isArray(to) ? to.join(', ') : to,
          err: new Error('Fallo SMTP2GO al enviar email'),
          meta: {
            subject,
            provider: 'smtp2go',
            httpStatus: response?.status ?? null,
            responseSnippet: (resultado?.raw || raw || '').slice(0, 500)
          }
        });
      } catch (_) {}

      throw new Error('Error al enviar email con SMTP2GO');
    }
  } catch (e) {
    try {
      await alertAdmin({
        area: 'smtp2go_network',
        email: Array.isArray(to) ? to.join(', ') : to,
        err: e,
        meta: {
          subject,
          provider: 'smtp2go'
        }
      });
    } catch (_) {}
    throw e;
  }

  if (successReal) {
    console.log(`Email "${subject}" enviado correctamente a ${destinatarios.join(', ')}`);
  } else {
    console.warn(`Advertencia: Email "${subject}" enviado pero con posibles incidencias:`, resultado);
  }

  return 'OK';
}

// ENVÍO DE FACTURA (Club: ALTA/RENOVACIÓN; Otros productos: no entradas)
async function enviarFacturaPorEmail(datos, pdfBuffer) {
  const email = datos.email;
  const importeTexto = datos.importe ? `${Number(datos.importe).toFixed(2)} €` : 'importe no disponible';
  const nombre = datos.nombre || '';

  const esClub =
    (datos.tipoProducto && datos.tipoProducto.toString().toLowerCase() === 'club') ||
    [datos.producto, datos.nombreProducto, datos.descripcionProducto]
      .filter(Boolean)
      .map(s => s.toString().toLowerCase())
      .some(s => s.includes('club laboroteca'));

  const etiqueta = `${datos.nombreProducto || ''} ${datos.descripcionProducto || ''}`.toLowerCase();
  const esAltaClub = esClub && /(alta y primera cuota|alta)/i.test(etiqueta);
  const esRenovClub = esClub && /(renovación mensual|renovacion mensual|subscription_cycle|renovación)/i.test(etiqueta);

  const nombreProductoMostrar = datos.nombreProducto || datos.descripcionProducto || 'Producto Laboroteca';

  let subject = '';
  let html = '';
  let text = '';

  if (esClub && esAltaClub) {
    subject = 'Tu suscripción al Club Laboroteca está activada';
    html = `
      <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333;">
        <p>Estimado ${nombre || 'cliente'},</p>
        <p>Ya tienes activada tu suscripción al Club Laboroteca. Puedes acceder a todo el contenido exclusivo a través de https://www.laboroteca.es/club-laboroteca/.</p>
        <p>Adjunto a este correo la factura correspondiente a tu suscripción mensual.</p>
        <p>Importe: <strong>${importeTexto}</strong></p>
        <p>Muchas gracias por pertenecer al Club Laboroteca.</p>
        <p>Ignacio Solsona<br/>Abogado</p>
      </div>`;
    text = `Estimado ${nombre || 'cliente'},

Ya tienes activada tu suscripción al Club Laboroteca. Puedes acceder a todo el contenido exclusivo a través de https://www.laboroteca.es/club-laboroteca/.
Adjunto a este correo la factura correspondiente a tu suscripción mensual.
Importe: ${importeTexto}

Muchas gracias por pertenecer al Club Laboroteca.
Ignacio Solsona
Abogado`;
  } else if (esClub && esRenovClub) {
    subject = 'Se ha renovado tu suscripción al Club Laboroteca';
    html = `
      <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333;">
        <p>Estimado ${nombre || 'cliente'},</p>
        <p>Se ha renovado tu suscripción al Club Laboroteca. Puedes acceder a todo el contenido exclusivo a través de https://www.laboroteca.es/club-laboroteca/.</p>
        <p>Adjunto a este correo la factura correspondiente a tu suscripción mensual.</p>
        <p>Importe: <strong>${importeTexto}</strong></p>
        <p>Muchas gracias por pertenecer al Club Laboroteca.</p>
        <p>Ignacio Solsona<br/>Abogado</p>
      </div>`;
    text = `Estimado ${nombre || 'cliente'},

Se ha renovado tu suscripción al Club Laboroteca. Puedes acceder a todo el contenido exclusivo a través de https://www.laboroteca.es/club-laboroteca/.
Adjunto a este correo la factura correspondiente a tu suscripción mensual.
Importe: ${importeTexto}

Muchas gracias por pertenecer al Club Laboroteca.
Ignacio Solsona
Abogado`;
  } else {
    subject = `Has comprado ${nombreProductoMostrar}`;
    html = `
      <div style="font-family: Arial, sans-serif; font-size: 16px; color: #333;">
        <p>Hola ${nombre || 'cliente'},</p>
        <p>Gracias por tu compra. Ya tienes acceso a ${nombreProductoMostrar}. Puedes acceder desde:</p>
        <p>www.laboroteca.es/mi-cuenta</p>
        <p>Adjuntamos en este correo la factura correspondiente al producto:</p>
        <p>Importe: <strong>${importeTexto}</strong></p>
        <p>Un afectuoso saludo,<br/>Ignacio Solsona<br/>Abogado</p>
      </div>`;
    text = `Hola ${nombre || 'cliente'},

Gracias por tu compra. Ya tienes acceso a ${nombreProductoMostrar}. Puedes acceder desde:
www.laboroteca.es/mi-cuenta
Adjuntamos en este correo la factura correspondiente al producto:
Importe: ${importeTexto}

Un afectuoso saludo,
Ignacio Solsona
Abogado`;
  }

  return enviarEmailPersonalizado({
    to: [email],
    subject,
    html,
    text,
    enviarACopy: false
  });
}

// AVISO DE IMPAGO
async function enviarAvisoImpago(email, nombre, intento, enlacePago = "https://www.laboroteca.es/membresia-club-laboroteca/") {
  const subject = 'Tu suscripción al Club Laboroteca ha sido cancelada por impago';
  const html = `
    <p>Hola ${nombre || ''},</p>
    <p>No hemos podido procesar el cobro de tu suscripción mensual al Club Laboroteca.</p>
    <p>Tu suscripción ha sido cancelada automáticamente.</p>
    <p>Puedes reactivarla en cualquier momento desde este enlace, sin penalización y con el mismo precio:</p>
    <p>${enlacePago}</p>
    <p>Si crees que se trata de un error, revisa tu método de pago o tarjeta.</p>`;
  const text = `Hola ${nombre || ''},

No hemos podido procesar el cobro de tu suscripción mensual al Club Laboroteca.
Tu suscripción ha sido cancelada automáticamente.

Puedes reactivarla en cualquier momento desde este enlace, sin penalización y con el mismo precio:
${enlacePago}

Si crees que se trata de un error, revisa tu método de pago o tarjeta.`;

  return enviarEmailPersonalizado({ to: email, subject, html, text });
}

// CANCELACIÓN POR IMPAGO (no-op para evitar duplicados)
async function enviarAvisoCancelacion(email, nombre, enlacePago) {
  console.log('enviarAvisoCancelacion omitido (duplicación evitada)');
  return 'OK';
}

// CONFIRMACIÓN DE BAJA VOLUNTARIA
async function enviarConfirmacionBajaClub(email, nombre = '') {
  const subject = 'Confirmación de baja del Club Laboroteca';
  const html = `
    <p>Hola ${nombre},</p>
    <p><strong>Te confirmamos que se ha cursado correctamente tu baja del Club Laboroteca</strong>.</p>
    <p>Puedes volver a hacerte miembro en cualquier momento, por el mismo precio y sin compromiso de permanencia.</p>
    <p>Reactivar: https://www.laboroteca.es/membresia-club-laboroteca/</p>
    <p>Un saludo,<br>Laboroteca</p>`;
  const text = `Hola ${nombre},

Te confirmamos que se ha cursado correctamente tu baja del Club Laboroteca.

Puedes volver a hacerte miembro en cualquier momento, por el mismo precio y sin compromiso de permanencia.
Reactivar: https://www.laboroteca.es/membresia-club-laboroteca/

Un saludo,
Laboroteca`;

  return enviarEmailPersonalizado({ to: [email], subject, html, text, enviarACopy: false });
}

// AVISO DE CANCELACIÓN MANUAL (por admin/dashboard)
async function enviarAvisoCancelacionManual(email, nombre = '') {
  const subject = 'Tu suscripción al Club Laboroteca ha sido cancelada';
  const html = `
    <p>Hola ${nombre},</p>
    <p>Tu suscripción al Club Laboroteca ha sido cancelada.</p>
    <p>Puedes volver a hacerte miembro cuando quieras, por el mismo precio y sin compromiso de permanencia.</p>
    <p>Reactivar: https://www.laboroteca.es/membresia-club-laboroteca/</p>
    <p>Un saludo,<br>Laboroteca</p>
  `;
  const text = `Hola ${nombre},

Tu suscripción al Club Laboroteca ha sido cancelada manualmente.
Puedes volver a hacerte miembro cuando quieras, por el mismo precio y sin compromiso de permanencia.
Reactivar: https://www.laboroteca.es/membresia-club-laboroteca/

Un saludo,
Laboroteca`;

  return enviarEmailPersonalizado({
    to: [email],
    subject,
    html,
    text,
  });
}

// EMAIL VALIDACIÓN ELIMINACIÓN CUENTA
async function enviarEmailValidacionEliminacionCuenta(email, token) {
  const enlace = `https://www.laboroteca.es/confirmar-eliminacion-cuenta/?token=${token}`;
  const subject = 'Confirmación de eliminación de tu cuenta en Laboroteca';
  const html = `
    <p>Hola,</p>
    <p>Has solicitado eliminar tu cuenta en Laboroteca. Para confirmar esta acción, pulsa en el siguiente enlace:</p>
    <p><a href="${enlace}" style="font-weight: bold;">Confirmar eliminación de cuenta</a></p>
    <p>Si no has solicitado esta acción, ignora este correo. El enlace caducará en 2 horas.</p>`;
  const text = `Has solicitado eliminar tu cuenta en Laboroteca.

Para confirmar esta acción, accede a este enlace (válido 2 horas):
${enlace}

Si no lo has solicitado tú, ignora este mensaje.`;

  return enviarEmailPersonalizado({ to: email, subject, html, text, enviarACopy: false });
}

module.exports = {
  enviarFacturaPorEmail,
  enviarAvisoImpago,
  enviarAvisoCancelacion,
  enviarConfirmacionBajaClub,
  enviarEmailValidacionEliminacionCuenta,
  enviarEmailPersonalizado
};
