require('dotenv').config();
const fetch = require('node-fetch');
const { alertAdminProxy: alertAdmin } = require('./utils/alertAdminProxy');

/**
 * Envía un email con o sin factura adjunta (PDF).
 * @param {Object} opciones - { to, subject, html, text, pdfBuffer, enviarACopy, attachments }
 * @returns {Promise<string>}
 */
async function enviarEmailPersonalizado({
  to,
  subject,
  html,
  text,
  pdfBuffer = null,
  enviarACopy = false,
  attachments = []
}) {
  const destinatarios = Array.isArray(to) ? [...to] : [to];

  // Copia al admin opcional controlada por env
  const SEND_ADMIN_COPY = String(process.env.SEND_ADMIN_COPY || 'false').toLowerCase() === 'true';
  if (enviarACopy && SEND_ADMIN_COPY && !destinatarios.includes('laboroteca@gmail.com')) {
    destinatarios.push('laboroteca@gmail.com');
  }

  const pieHtml = `
    <hr style="margin-top:40px;margin-bottom:10px;" />
    <div style="font-size:12px;color:#777;line-height:1.5;">
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

  // Adjuntos: prioriza attachments explícitos; si no, adjunta el PDF si existe
  if (Array.isArray(attachments) && attachments.length > 0) {
    body.attachments = attachments;
  } else if (pdfBuffer && Buffer.isBuffer(pdfBuffer) && pdfBuffer.length > 5000) {
    body.attachments = [
      {
        filename: 'Factura Laboroteca.pdf',
        fileblob: pdfBuffer.toString('base64'),
        mimetype: 'application/pdf'
      }
    ];
  }

  let response;
  let resultado;
  let successReal;

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
      console.error(
        'Error real desde SMTP2GO:',
        typeof resultado.raw === 'string' ? resultado.raw : JSON.stringify(resultado, null, 2)
      );

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
        meta: { subject, provider: 'smtp2go' }
      });
    } catch (_) {}
    throw e;
  }

  if (successReal) {
    console.log(`Email "${subject}" enviado correctamente a ${destinatarios.join(', ')}`);
  } else {
    console.warn(`Advertencia: Email "${subject}" enviado pero con posibles incidencias:`, resultado);
    try {
      await alertAdmin({
        area: 'smtp2go_warning',
        email: Array.isArray(to) ? to.join(', ') : to,
        err: new Error('SMTP2GO warning'),
        meta: { subject, provider: 'smtp2go', resultado }
      });
    } catch (_) {}
  }

  return 'OK';
}

/** Utilidad: formatea € con coma */
function euros(v) {
  return typeof v === 'number' ? `${Number(v).toFixed(2).replace('.', ',')} €` : 'importe no disponible';
}

/**
 * ENVÍO DE FACTURA (Club: ALTA/RENOVACIÓN; otros productos —no entradas—)
 */
async function enviarFacturaPorEmail(datos, pdfBuffer) {
  const email = datos.email;
  const importeTexto = euros(datos.importe);
  const nombre = datos.nombre || '';

  const esClub =
    (datos.tipoProducto && String(datos.tipoProducto).toLowerCase() === 'club') ||
    [datos.producto, datos.nombreProducto, datos.descripcionProducto]
      .filter(Boolean)
      .map(s => String(s).toLowerCase())
      .some(s => s.includes('club laboroteca'));

  const etiqueta = `${String(datos.nombreProducto || '')} ${String(datos.descripcionProducto || '')}`.toLowerCase();
  const esAltaClub = esClub && /(alta y primera cuota|alta)/i.test(etiqueta);
  const esRenovClub = esClub && /(renovación mensual|renovacion mensual|subscription_cycle|renovación)/i.test(etiqueta);

  const nombreProductoMostrar = datos.nombreProducto || datos.descripcionProducto || 'Producto Laboroteca';

  let subject = '';
  let html = '';
  let text = '';

  if (esClub && esAltaClub) {
    // ALTA INICIAL
    subject = 'Tu suscripción al Club Laboroteca está activada';
    html = `
      <div style="font-family:Arial,sans-serif;font-size:16px;color:#333;">
        <p>Estimado ${nombre || 'cliente'},</p>
        <p>Ya tienes activada tu suscripción al Club Laboroteca. Puedes acceder a todo el contenido exclusivo a través de https://www.laboroteca.es/club-laboroteca/.</p>
        <p>Adjunto a este correo la factura correspondiente a tu suscripción mensual.</p>
        <p>Importe: ${importeTexto}</p>
        <p><strong>Muchas gracias por pertenecer al Club Laboroteca.</strong></p>
        <p>(Recuerda que en cualquier momento puedes cancelar tu suscripción sin ninguna penalización en: https://www.laboroteca.es/cancelar-suscripcion-club-laboroteca/)</p>
        <p>Ignacio Solsona<br/>Abogado</p>
      </div>`;
    text = `Estimado ${nombre || 'cliente'},
Ya tienes activada tu suscripción al Club Laboroteca. Puedes acceder a todo el contenido exclusivo a través de https://www.laboroteca.es/club-laboroteca/.
Adjunto a este correo la factura correspondiente a tu suscripción mensual.
Importe: ${importeTexto}

Muchas gracias por pertenecer al Club Laboroteca.
(Recuerda que en cualquier momento puedes cancelar tu suscripción sin ninguna penalización en: https://www.laboroteca.es/cancelar-suscripcion-club-laboroteca/)
Ignacio Solsona
Abogado`;
  } else if (esClub && esRenovClub) {
    // RENOVACIÓN
    subject = 'Se ha renovado tu suscripción al Club Laboroteca';
    html = `
      <div style="font-family:Arial,sans-serif;font-size:16px;color:#333;">
        <p>Estimado ${nombre || 'cliente'},</p>
        <p>Se ha renovado tu suscripción al Club Laboroteca. Puedes acceder a todo el contenido exclusivo a través de https://www.laboroteca.es/club-laboroteca/.</p>
        <p>Adjunto a este correo la factura correspondiente a tu suscripción mensual.</p>
        <p>Importe: ${importeTexto}</p>
        <p><strong>Muchas gracias por pertenecer al Club Laboroteca.</strong></p>
        <p>(Recuerda que en cualquier momento puedes cancelar tu suscripción sin ninguna penalización en: https://www.laboroteca.es/cancelar-suscripcion-club-laboroteca/)</p>
        <p>Ignacio Solsona<br/>Abogado</p>
      </div>`;
    text = `Estimado ${nombre || 'cliente'},
Se ha renovado tu suscripción al Club Laboroteca. Puedes acceder a todo el contenido exclusivo a través de https://www.laboroteca.es/club-laboroteca/.
Adjunto a este correo la factura correspondiente a tu suscripción mensual.
Importe: ${importeTexto}

Muchas gracias por pertenecer al Club Laboroteca.
(Recuerda que en cualquier momento puedes cancelar tu suscripción sin ninguna penalización en: https://www.laboroteca.es/cancelar-suscripcion-club-laboroteca/)
Ignacio Solsona
Abogado`;
  } else {
    // OTROS PRODUCTOS (NO entradas)
    subject = `Has comprado ${nombreProductoMostrar}`;
    html = `
      <div style="font-family:Arial,sans-serif;font-size:16px;color:#333;">
        <p>Hola ${nombre || 'cliente'},</p>
        <p>Gracias por tu compra.</p>
        <p><strong>${nombreProductoMostrar}.</strong></p>
        <p>Puedes acceder a tu contenido desde: www.laboroteca.es/mi-cuenta</p>
        <p>Adjuntamos en este correo la factura correspondiente al producto:</p>
        <p>Importe: ${importeTexto}</p>
        <p>Un afectuoso saludo,<br/>Ignacio Solsona<br/>Abogado</p>
      </div>`;
    text = `Hola ${nombre || 'cliente'},
Gracias por tu compra.
${nombreProductoMostrar}.
Puedes acceder a tu contenido desde: www.laboroteca.es/mi-cuenta
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
    pdfBuffer, // adjunta la factura siempre que llegue
    enviarACopy: false
  });
}

// AVISO DE IMPAGO
async function enviarAvisoImpago(
  email,
  nombre,
  intento,
  enlacePago = 'https://www.laboroteca.es/membresia-club-laboroteca/'
) {
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

// CANCELACIÓN POR IMPAGO (evitar duplicados de correos)
async function enviarAvisoCancelacion(email, nombre, enlacePago) {
  console.log('enviarAvisoCancelacion omitido (duplicación evitada)');
  return 'OK';
}

// 📧 ACUSE DE SOLICITUD DE BAJA VOLUNTARIA (en el momento de solicitarla)
async function enviarEmailSolicitudBajaVoluntaria(nombre = '', email, fechaSolicitudISO, fechaEfectosISO) {
  const fmt = iso => {
    try {
      return new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day:'2-digit', month:'2-digit', year:'numeric' });
    } catch { return iso || ''; }
  };
  const FECHA_SOLICITUD = fmt(fechaSolicitudISO);
  const FECHA_EFECTOS   = fmt(fechaEfectosISO);
  const subject = 'Hemos recibido tu solicitud de baja del Club Laboroteca';
  const html = `
Hola ${nombre || 'cliente'},<br><br>
Hemos recibido tu <strong>solicitud de baja voluntaria</strong> del Club Laboroteca el <strong>${FECHA_SOLICITUD}</strong>.<br>
Tu suscripción seguirá activa hasta el <strong>${FECHA_EFECTOS}</strong>, que es el fin de tu periodo de facturación actual.<br><br>
En esa fecha tramitaremos la baja y perderás el acceso a los contenidos del Club. 
Si cambias de opinión puedes volver a darte de alta en cualquier momento y sin ninguna penalización.<br><br>
Gracias por haber formado parte del Club Laboroteca.<br>
`.trim();
  const text = `Hola ${nombre || 'cliente'},

Hemos recibido tu solicitud de baja voluntaria del Club Laboroteca el ${FECHA_SOLICITUD}.
Tu suscripción seguirá activa hasta el ${FECHA_EFECTOS}, que es el fin de tu periodo de facturación actual.

En esa fecha tramitaremos la baja y perderás el acceso a los contenidos del Club.
Si cambias de opinión puedes volver a darte de alta en cualquier momento y sin ninguna penalización.

Gracias por haber formado parte del Club Laboroteca.`;
  return enviarEmailPersonalizado({ to: email, subject, html, text, enviarACopy: false });
}


// CONFIRMACIÓN DE BAJA VOLUNTARIA
async function enviarConfirmacionBajaClub(email, nombre = '') {
  const subject = 'Confirmación de baja del Club Laboroteca';
  const html = `
    <p>Hola ${nombre},</p>
    <p><strong>Te confirmamos que se ha cursado correctamente tu baja del Club Laboroteca</strong>.</p>
    <p>Puedes volver a hacerte miembro en cualquier momento, por el mismo precio y sin compromiso de permanencia.</p>
    <p>Reactivar: https://www.laboroteca.es/membresia-club-laboroteca/</p>
    <p>Un saludo,<br/>Laboroteca</p>`;
  const text = `Hola ${nombre},

Te confirmamos que se ha cursado correctamente tu baja del Club Laboroteca.

Puedes volver a hacerte miembro en cualquier momento, por el mismo precio y sin compromiso de permanencia.
Reactivar: https://www.laboroteca.es/membresia-club-laboroteca/

Un saludo
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
    <p>Un saludo,<br/>Laboroteca</p>`;
  const text = `Hola ${nombre},

Tu suscripción al Club Laboroteca ha sido cancelada manualmente.
Puedes volver a hacerte miembro cuando quieras, por el mismo precio y sin compromiso de permanencia.
Reactivar: https://www.laboroteca.es/membresia-club-laboroteca/

Un saludo
Laboroteca`;

  return enviarEmailPersonalizado({ to: [email], subject, html, text });
}

/**
 * EMAIL DE CONFIRMACIÓN PARA LA ELIMINACIÓN DE LA CUENTA
 */
async function enviarEmailValidacionEliminacionCuenta(email, token) {
  const enlace = `https://www.laboroteca.es/confirmar-eliminacion-cuenta/?token=${token}`;
  const subject = 'Confirma la eliminación de tu cuenta en Laboroteca';
  const html = `
    <p>Hola,</p>
    <p>Has solicitado eliminar tu cuenta en Laboroteca. Necesitamos que confirmes que has sido tú quien lo ha solicitado. Si estás suscrito al Club Laboroteca, se eliminará también tu membresía.</p>
    <p>Para confirmar la eliminación, pulsa en el siguiente enlace:</p>
    <p><a href="${enlace}" style="font-weight:bold;">Confirmar eliminación de cuenta</a></p>
    <p>Si no has solicitado esta acción, ignora este correo. El enlace caducará en 2 horas.</p>
    <p>Un saludo<br/>Laboroteca</p>`;
  const text = `Hola,

Has solicitado eliminar tu cuenta en Laboroteca. Necesitamos que confirmes que has sido tú quien lo ha solicitado. Si estás suscrito al Club Laboroteca, se eliminará también tu membresía.

Para confirmar la eliminación, pulsa en el siguiente enlace:
Confirmar eliminación de cuenta -> ${enlace}

Si no has solicitado esta acción, ignora este correo. El enlace caducará en 2 horas.
Un saludo
Laboroteca`;

  return enviarEmailPersonalizado({ to: email, subject, html, text, enviarACopy: false });
}

module.exports = {
  enviarFacturaPorEmail,
  enviarAvisoImpago,
  enviarAvisoCancelacion,
  enviarConfirmacionBajaClub,
  enviarEmailValidacionEliminacionCuenta,
  enviarEmailPersonalizado,
  enviarEmailSolicitudBajaVoluntaria
};

