require('dotenv').config();
const fetch = require('node-fetch');
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');
// ^ sin cambios de import

// PII-safe helpers
const maskEmail = (e='') => {
  const [u,d] = String(e).split('@');
  if (!u || !d) return '***';
  return `${u.slice(0,2)}***@***${d.slice(Math.max(0,d.length-3))}`;
};
const maskEmails = (arr=[]) => arr.map(maskEmail).join(', ');
// Escapar HTML básico para variables que vienen del usuario/formularios
const escapeHtml = (s='') => String(s)
  .replace(/&/g,'&amp;')
  .replace(/</g,'&lt;')
  .replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;')
  .replace(/'/g,'&#39;');


/**
 * Envía un email con o sin factura adjunta (PDF).
 * @param {Object} opciones - { to, subject, html, text, pdfBuffer, enviarACopy, attachments, incluirAdvertencia }
 * @returns {Promise<string>}
 */
async function enviarEmailPersonalizado({
  to,
  subject,
  html = '',
  text = '',
  pdfBuffer = null,
  enviarACopy = false,
  attachments = [],
  incluirAdvertencia = false
}) {
  const destinatarios = (Array.isArray(to) ? [...to] : [to]).filter(Boolean);
  if (destinatarios.length === 0) {
    throw new Error('enviarEmailPersonalizado: lista de destinatarios vacía');
  }

  // Copia al admin opcional controlada por env
  const SEND_ADMIN_COPY = String(process.env.SEND_ADMIN_COPY || 'false').toLowerCase() === 'true';
  // 👉 usa BCC (no mezclar con TO para no exponer destinatarios)
  const bcc = (enviarACopy && SEND_ADMIN_COPY) ? ['laboroteca@gmail.com'] : [];

  const pieHtml = `
    <div style="font-size:14px;color:#777;line-height:1.4;">
      En cumplimiento del Reglamento (UE) 2016/679 (RGPD) y la LOPDGDD, le informamos de que su dirección de correo electrónico forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera (DNI 20481042W), con domicilio en calle Enmedio nº 22, 3.º E, 12001 Castellón de la Plana (España).<br /><br />
      Finalidades: prestación de servicios jurídicos, venta de infoproductos, gestión de entradas a eventos, emisión y envío de facturas por email y, en su caso, envío de newsletter y comunicaciones comerciales si usted lo ha consentido. Base jurídica: ejecución de contrato y/o consentimiento. Puede retirar su consentimiento en cualquier momento.<br /><br />
      Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición escribiendo a <a href="mailto:laboroteca@gmail.com">laboroteca@gmail.com</a>. También puede presentar una reclamación ante la autoridad de control competente. Más información en nuestra política de privacidad: <a href="https://www.laboroteca.es/politica-de-privacidad/" target="_blank" rel="noopener">https://www.laboroteca.es/politica-de-privacidad/</a>.
    </div>
  `;
  const pieText = `
En cumplimiento del Reglamento (UE) 2016/679 (RGPD) y la LOPDGDD, su email forma parte de la base de datos de Ignacio Solsona Fernández-Pedrera (DNI 20481042W), calle Enmedio nº 22, 3.º E, 12001 Castellón de la Plana (España).

Finalidades: prestación de servicios jurídicos, venta de infoproductos, gestión de entradas a eventos, emisión y envío de facturas por email y, en su caso, envío de newsletter y comunicaciones comerciales si usted lo ha consentido. Base jurídica: ejecución de contrato y/o consentimiento. Puede retirar su consentimiento en cualquier momento.

Puede ejercer sus derechos de acceso, rectificación, supresión, portabilidad, limitación y oposición escribiendo a: laboroteca@gmail.com.
También puede presentar una reclamación ante la autoridad de control competente.
Más información: https://www.laboroteca.es/politica-de-privacidad/
  `;

  // ——— ADVERTENCIA (mismo tamaño/fuente que el pie RGPD: 14px; color #606296) ———
  const advertenciaHtml = `
    <div style="font-size:14px;color:#606296;line-height:1.4;margin:8px 0;">
      <strong>Importante:</strong> Todos los contenidos están protegidos por derechos de autor. Tu acceso es personal e intransferible.  
Se prohíbe compartir tus credenciales de acceso o difundir el contenido sin autorización expresa.  
Cualquier uso indebido o sospechoso podrá dar lugar a la suspensión o cancelación de la cuenta.
    </div>
  `;
  // Separadores: el superior con espacio extra (≈2–3 líneas) para que quede más abajo del nombre
  const sepHtml       = `<hr style="margin:16px 0;border:0;border-top:1px solid #bbb;" />`;
  const sepSuperiorHtml = `
    <div style="height:2.6em;line-height:1.6;"></div>
    <hr style="margin:16px 0;border:0;border-top:1px solid #bbb;" />
  `;

  const advertenciaText = `IMPORTANTE: Todos los contenidos están protegidos por derechos de autor. Tu acceso es personal e intransferible. Se prohíbe compartir tus credenciales de acceso o difundir el contenido sin autorización expresa. Cualquier uso indebido o sospechoso podrá dar lugar a la suspensión o cancelación de la cuenta.`;
  const sepText = '------------------------------------------------------------';
  // Construcción de cuerpo: la advertencia SOLO se incluye si incluirAdvertencia === true
  const html_body = incluirAdvertencia
    ? (html + sepSuperiorHtml + advertenciaHtml + sepHtml + pieHtml)
    : (html + sepHtml + pieHtml);

  const text_body = incluirAdvertencia
    ? [text, '', '', '', sepText, advertenciaText, sepText, '', pieText].join('\n')
    : [text, '', sepText, '', pieText].join('\n');

  // Escape defensivo del subject si llega de usuario/metadata
  const safeSubject = String(subject || '').replace(/\r?\n/g,' ').slice(0,250);
  const body = {
    api_key: process.env.SMTP2GO_API_KEY,
    to: destinatarios,
    bcc,
    sender: `"Laboroteca" <${process.env.SMTP2GO_FROM_EMAIL}>`,
    subject: safeSubject,
    html_body,
    text_body
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
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const raw = await response.text();
    try {
      resultado = JSON.parse(raw);
    } catch {
      resultado = { success: false, data: {}, raw };
    }

 const succeeded = Number(resultado?.data?.succeeded ?? 0);
 const failed = Number(resultado?.data?.failed ?? 0);
 successReal = succeeded >= destinatarios.length && failed === 0;

    if (!resultado.success && !successReal) {
      console.error(
        'Error real desde SMTP2GO:',
        typeof resultado.raw === 'string' ? resultado.raw : JSON.stringify(resultado, null, 2)
      );

      try {
        await alertAdmin({
          area: 'smtp2go_send',
          email: Array.isArray(to) ? maskEmails(to) : maskEmail(to),
          err: new Error('Fallo SMTP2GO al enviar email'),
        meta: {
          subject: safeSubject,
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
        email: Array.isArray(to) ? maskEmails(to) : maskEmail(to),
        err: e,
        meta: { subject: safeSubject, provider: 'smtp2go' }
      });
    } catch (_) {}
    throw e;
  }

  if (successReal) {
    console.log(`Email "${safeSubject}" enviado correctamente a ${maskEmails(destinatarios)}`);
  } else {
    console.warn(`Advertencia: Email "${safeSubject}" enviado pero con posibles incidencias:`, {
      succeeded: Number(resultado?.data?.succeeded ?? 0),
      failed: Number(resultado?.data?.failed ?? 0)
    });
    try {
      await alertAdmin({
        area: 'smtp2go_warning',
        email: Array.isArray(to) ? maskEmails(to) : maskEmail(to),
        err: new Error('SMTP2GO warning'),
        meta: { subject: safeSubject, provider: 'smtp2go' }
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
  // Usar solo el primer nombre en saludos (fallback a 'cliente')
  const nombreCompleto = escapeHtml(datos.nombre || '');
  const nombre = (nombreCompleto.trim().split(/\s+/)[0] || 'cliente');

  const esClub =
    (datos.tipoProducto && String(datos.tipoProducto).toLowerCase() === 'club') ||
    [datos.producto, datos.nombreProducto, datos.descripcionProducto]
      .filter(Boolean)
      .map(s => String(s).toLowerCase())
      .some(s => s.includes('club laboroteca'));

  const etiqueta = `${String(datos.nombreProducto || '')} ${String(datos.descripcionProducto || '')}`.toLowerCase();
  const esAltaClub = esClub && /(alta y primera cuota|alta)/i.test(etiqueta);
  const esRenovClub = esClub && /(renovación mensual|renovacion mensual|subscription_cycle|renovación)/i.test(etiqueta);

  const nombreProductoMostrar = escapeHtml(datos.nombreProducto || datos.descripcionProducto || 'Producto Laboroteca');
  const debeIncluirAdvertencia = (!esClub) || esAltaClub || esRenovClub; // ✅ ahora también en renovaciones del Club
  let subject = '';
  let html = '';
  let text = '';

  if (esClub && esAltaClub) {
    // ALTA INICIAL
    subject = 'Tu suscripción al Club Laboroteca está activada';
    html = `
      <div style="font-family:Arial,sans-serif;font-size:16px;color:#333;line-height:1.4;">
        <p>Estimado/a ${nombre || 'cliente'},</p>
        <p>Ya tienes activada tu suscripción al Club Laboroteca. Puedes acceder a todo el contenido exclusivo a través de <a href="https://www.laboroteca.es/club-laboroteca/">https://www.laboroteca.es/club-laboroteca/</a>.</p>
        <p>Adjunto a este correo la factura correspondiente a tu suscripción mensual.</p>
        <p>Importe: ${importeTexto}</p>
        <p><strong>Muchas gracias por pertenecer al Club Laboroteca.</strong></p>
        <p>Recuerda que en cualquier momento puedes cancelar tu suscripción sin ninguna penalización en: <a href="https://www.laboroteca.es/cancelar-suscripcion-club-laboroteca/">https://www.laboroteca.es/cancelar-suscripcion-club-laboroteca/</a></p>
        <p>Ignacio Solsona<br/>Abogado</p>
      </div>`;
    text = `Estimado/a ${nombre || 'cliente'},
Ya tienes activada tu suscripción al Club Laboroteca. Puedes acceder a todo el contenido exclusivo a través de https://www.laboroteca.es/club-laboroteca/.
Adjunto a este correo la factura correspondiente a tu suscripción mensual.
Importe: ${importeTexto}

Muchas gracias por pertenecer al Club Laboroteca.
Recuerda que en cualquier momento puedes cancelar tu suscripción sin ninguna penalización en: https://www.laboroteca.es/cancelar-suscripcion-club-laboroteca/
Ignacio Solsona
Abogado`;
  } else if (esClub && esRenovClub) {
    // RENOVACIÓN
    subject = 'Se ha renovado tu suscripción al Club Laboroteca';
    html = `
      <div style="font-family:Arial,sans-serif;font-size:16px;color:#333;line-height:1.4;">
        <p>Estimado/a ${nombre || 'cliente'},</p>
        <p>Se ha renovado tu suscripción al Club Laboroteca. Puedes acceder a todo el contenido exclusivo a través de <a href="https://www.laboroteca.es/club-laboroteca/">https://www.laboroteca.es/club-laboroteca/</a>.</p>
        <p>Adjunto a este correo la factura correspondiente a tu suscripción mensual.</p>
        <p>Importe: ${importeTexto}</p>
        <p><strong>Muchas gracias por pertenecer al Club Laboroteca.</strong></p>
        <p>Recuerda que en cualquier momento puedes cancelar tu suscripción sin ninguna penalización en: <a href="https://www.laboroteca.es/cancelar-suscripcion-club-laboroteca/">https://www.laboroteca.es/cancelar-suscripcion-club-laboroteca/</a></p>
        <p>Ignacio Solsona<br/>Abogado</p>
      </div>`;
    text = `Estimado/a ${nombre || 'cliente'},
Se ha renovado tu suscripción al Club Laboroteca. Puedes acceder a todo el contenido exclusivo a través de https://www.laboroteca.es/club-laboroteca/.
Adjunto a este correo la factura correspondiente a tu suscripción mensual.
Importe: ${importeTexto}

Muchas gracias por pertenecer al Club Laboroteca.
Recuerda que en cualquier momento puedes cancelar tu suscripción sin ninguna penalización en: https://www.laboroteca.es/cancelar-suscripcion-club-laboroteca/
Ignacio Solsona
Abogado`;
  } else {
    // OTROS PRODUCTOS (NO entradas)
    subject = `Has comprado ${nombreProductoMostrar}`;
    html = `
      <div style="font-family:Arial,sans-serif;font-size:16px;color:#333;line-height:1.4;">
        <p>Hola ${nombre || 'cliente'},</p>
        <p>Gracias por tu compra.</p>
        <p><strong>${nombreProductoMostrar}.</strong></p>
        <p>Puedes acceder a tu contenido desde: <a href="https://www.laboroteca.es/mi-cuenta">https://www.laboroteca.es/mi-cuenta</a></p>
        <p>Adjuntamos en este correo la factura correspondiente al producto:</p>
        <p>Importe: ${importeTexto}</p>
        <p>Un afectuoso saludo,<br/>Ignacio Solsona<br/>Abogado</p>
      </div>`;
    text = `Hola ${nombre || 'cliente'},
Gracias por tu compra.
${nombreProductoMostrar}.
Puedes acceder a tu contenido desde: https://www.laboroteca.es/mi-cuenta
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
    enviarACopy: false,
    incluirAdvertencia: debeIncluirAdvertencia
  });
}

// AVISO DE IMPAGO
async function enviarAvisoImpago(
  email,
  nombre,
  intento,
  enlacePago = 'https://www.laboroteca.es/membresia-club-laboroteca/'
) {
  const nombreCompleto = escapeHtml(nombre || '');
  nombre = nombreCompleto.split(' ')[0];
  const subject = 'Tu suscripción al Club Laboroteca ha sido cancelada por impago';
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:16px;color:#333;line-height:1.4;">
      <p>Hola ${nombre || ''},</p>
      <p><strong>No hemos podido procesar el cobro de tu suscripción mensual al Club Laboroteca.</strong></p>
      <p>Tu suscripción ha sido cancelada automáticamente.</p>
      <p>Puedes reactivarla en cualquier momento desde este enlace, sin penalización y con el mismo precio:</p>
      <p><a href="${enlacePago}">${enlacePago}</a></p>
      <p>Si crees que se trata de un error, revisa tu método de pago o tarjeta y solicita de nuevo el alta.</p>
    </div>`;
  const text = `Hola ${nombre || ''},

**No hemos podido procesar el cobro de tu suscripción mensual al Club Laboroteca.**
Tu suscripción ha sido cancelada automáticamente.

Puedes reactivarla en cualquier momento desde este enlace, sin penalización y con el mismo precio:
${enlacePago}

Si crees que se trata de un error, revisa tu método de pago o tarjeta y solicita de nuevo el alta.`;

  return enviarEmailPersonalizado({ to: email, subject, html, text });
}

// CANCELACIÓN POR IMPAGO (evitar duplicados de correos)
async function enviarAvisoCancelacion(email, nombre, enlacePago) {
  console.log('enviarAvisoCancelacion omitido (duplicación evitada)');
  // ⚠️ Política: este correo permanece desactivado para evitar duplicados.
  // Si en el futuro se reactivase el envío, NUNCA incluir advertencia:
  // return enviarEmailPersonalizado({ to: [email], subject, html, text, incluirAdvertencia: false });
  return 'OK';
}

// 📧 ACUSE DE SOLICITUD DE BAJA VOLUNTARIA (en el momento de solicitarla)
async function enviarEmailSolicitudBajaVoluntaria(nombre = '', email, fechaSolicitudISO, fechaEfectosISO) {
  const nombreCompleto = escapeHtml(nombre || '');
  nombre = nombreCompleto.split(' ')[0];
  const fmt = iso => {
    try {
      return new Date(iso).toLocaleString('es-ES', { timeZone: 'Europe/Madrid', day:'2-digit', month:'2-digit', year:'numeric' });
    } catch { return iso || ''; }
  };
  const FECHA_SOLICITUD = fmt(fechaSolicitudISO);
  const FECHA_EFECTOS   = fmt(fechaEfectosISO);
  const subject = 'Hemos recibido tu solicitud de baja del Club Laboroteca';
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:16px;color:#333;line-height:1.4;">
      Hola ${nombre || 'cliente'},<br><br>
      Hemos recibido tu <strong>solicitud de baja voluntaria</strong> del Club Laboroteca el <strong>${FECHA_SOLICITUD}</strong>.<br>
      Tu suscripción seguirá activa hasta el <strong>${FECHA_EFECTOS}</strong>, que es el fin de tu periodo de facturación actual.<br><br>
      En esa fecha tramitaremos la baja y perderás el acceso a los contenidos del Club. 
      Si cambias de opinión puedes volver a darte de alta en cualquier momento y sin ninguna penalización.<br><br>
      Gracias por haber formado parte del Club Laboroteca.<br>
    </div>`.trim();
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
  const nombreCompleto = escapeHtml(nombre || '');
  nombre = nombreCompleto.split(' ')[0];
  const subject = 'Confirmación de baja del Club Laboroteca';
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:16px;color:#333;line-height:1.4;">
      <p>Hola ${nombre},</p>
      <p>Tu suscripción al Club Laboroteca ha sido cancelada.</p>
      <p>Puedes volver a hacerte miembro cuando quieras, por el mismo precio y sin compromiso de permanencia.</p>
      <p>Reactivar: <a href="https://www.laboroteca.es/membresia-club-laboroteca/">https://www.laboroteca.es/membresia-club-laboroteca/</a></p>
      <p>Un saludo,<br/>Laboroteca</p>
    </div>`;
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
  const nombreCompleto = escapeHtml(nombre || '');
  nombre = nombreCompleto.split(' ')[0];
  const subject = 'Tu suscripción al Club Laboroteca ha sido cancelada';
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:16px;color:#333;line-height:1.4;">
      <p>Hola ${nombre},</p>
      <p>Tu suscripción al Club Laboroteca ha sido cancelada.</p>
      <p>Puedes volver a hacerte miembro cuando quieras, por el mismo precio y sin compromiso de permanencia.</p>
      <p>Reactivar: <a href="https://www.laboroteca.es/membresia-club-laboroteca/">https://www.laboroteca.es/membresia-club-laboroteca/</a></p>
      <p>Un saludo,<br/>Laboroteca</p>
    </div>`;
  const text = `Hola ${nombre},

Tu suscripción al Club Laboroteca ha sido cancelada manualmente.
Puedes volver a hacerte miembro cuando quieras, por el mismo precio y sin compromiso de permanencia.
Reactivar: https://www.laboroteca.es/membresia-club-laboroteca/

Un saludo
Laboroteca`;

  // 1) Aviso de cancelación manual (sin advertencia)…
  await enviarEmailPersonalizado({ to: [email], subject, html, text, incluirAdvertencia: false });
  // 2) …y además enviar la confirmación estándar de baja
  return enviarConfirmacionBajaClub(email, nombre);
}

/**
 * EMAIL DE CONFIRMACIÓN PARA LA ELIMINACIÓN DE LA CUENTA
 */
async function enviarEmailValidacionEliminacionCuenta(email, token) {
  const enlace = `https://www.laboroteca.es/confirmar-eliminacion-cuenta/?token=${token}`;
  const subject = 'Confirma la eliminación de tu cuenta en Laboroteca';
  const html = `
    <div style="font-family:Arial,sans-serif;font-size:16px;color:#333;line-height:1.4;">
      <p>Hola,</p>
      <p>Has solicitado eliminar tu cuenta en Laboroteca. Necesitamos que confirmes que has sido tú quien lo ha solicitado. Si estás suscrito al Club Laboroteca, o tienes activa cualquier membresía, perderás el acceso.</p>
      <p>Para confirmar la eliminación, pulsa en el siguiente enlace:</p>
      <p><a href="${enlace}" style="font-weight:bold;">Confirmar eliminación de cuenta</a></p>
      <p>Si no has solicitado esta acción, ignora este correo. El enlace caducará en 2 horas.</p>
      <p>Un saludo<br/>Laboroteca</p>
    </div>`;
  const text = `Hola,

Has solicitado eliminar tu cuenta en Laboroteca. Necesitamos que confirmes que has sido tú quien lo ha solicitado. Si estás suscrito al Club Laboroteca, o tienes activa cualquier membresía, perderás el acceso.

Para confirmar la eliminación, pulsa en el siguiente enlace:
Confirmar eliminación de cuenta -> ${enlace}

Si no has solicitado esta acción, ignora este correo. El enlace caducará en 2 horas.
Un saludo
Laboroteca`;

  return enviarEmailPersonalizado({ to: email, subject, html, text, enviarACopy: false, incluirAdvertencia: false });
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

