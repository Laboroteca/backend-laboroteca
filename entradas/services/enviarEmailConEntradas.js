// 📂 /entradas/services/enviarEmailConEntradas.js
const { enviarEmailPersonalizado } = require('../../services/email');

/**
 * Envía un email con entradas (y factura opcional).
 * Soporta modo "compra" (por defecto) o "reenvio".
 *
 * @param {Object} opciones
 * @param {string} opciones.email               - Destinatario
 * @param {string} [opciones.nombre]            - Nombre del destinatario (fallback: parte local del email)
 * @param {Array<{ buffer: Buffer }>} opciones.entradas - Entradas en PDF (mín. 1)
 * @param {Buffer|null} [opciones.facturaAdjunta=null]  - Factura PDF (opcional, solo en compra normalmente)
 * @param {string} opciones.descripcionProducto - Nombre del evento
 * @param {number} [opciones.importe]           - Importe total en € (opcional en reenvío)
 * @param {"compra"|"reenvio"} [opciones.modo="compra"] - Tipo de email
 * @param {string} [opciones.fecha]             - Fecha del evento (texto tal cual, p.ej. "30/10/2025 - 17:00")
 * @param {string} [opciones.direccion]         - Dirección/Lugar del evento
 * @param {string} [opciones.subject]           - Sobrescribir asunto
 * @param {string} [opciones.html]              - Sobrescribir HTML completo
 */
async function enviarEmailConEntradas({
  email,
  nombre,
  entradas,
  facturaAdjunta = null,
  descripcionProducto,
  importe,
  modo = 'compra',
  fecha,
  direccion,
  subject,
  html
}) {
  // Validaciones mínimas
  if (!email || typeof email !== 'string') {
    throw new Error('Email de destino inválido.');
  }
  if (!Array.isArray(entradas) || entradas.length === 0) {
    throw new Error('No hay entradas que enviar.');
  }
  if (!descripcionProducto) {
    throw new Error('Falta descripcionProducto.');
  }

  // Utilidades
  const displayName = (nombre && String(nombre).trim()) || String(email).split('@')[0] || '';
  const numEntradas = entradas.length;

  const formatEuros = (n) => {
    if (typeof n !== 'number' || !isFinite(n)) return null;
    const fixed = n.toFixed(2);
    return {
      html: fixed.replace('.', ','), // 12.50 -> 12,50
      text: fixed.replace('.', ',')
    };
  };

  // Solo calculamos euros si es compra
  const euros = modo === 'compra' ? formatEuros(importe) : null;

  // Bloque evento opcional
  const bloqueEventoHTML = (fecha || direccion)
    ? `<p><strong>Fecha:</strong> ${fecha ? String(fecha) : '—'}<br><strong>Lugar:</strong> ${direccion ? String(direccion) : '—'}</p>`
    : '';

  // Asunto por defecto según modo
  const defaultSubject =
    modo === 'reenvio'
      ? `Reenvío de entradas: «${descripcionProducto}»`
      : `🎟️ Tus entradas para «${descripcionProducto}»`;

  const finalSubject = subject || defaultSubject;

  // Cuerpos por defecto
  const htmlPorDefecto =
    modo === 'reenvio'
      ? `
      <p>Hola ${escapeHtml(displayName)},</p>
      <p>Te reenviamos tus <strong>${numEntradas}</strong> entrada(s) para <strong>«${escapeHtml(descripcionProducto)}»</strong>.</p>
      ${bloqueEventoHTML}
      <p>Puedes presentar el <strong>PDF adjunto</strong> en tu móvil o impreso. Cada entrada incluye su <strong>código QR único</strong>.</p>
      <p>
        Una vez validada tu entrada en el evento, el código de la misma podrá canjearse por un libro digital gratuito desde:<br/>
        https://www.laboroteca.es/canjear-codigo-regalo/<br/>
        Si no asistes y tu entrada no es validada, no podrás realizar el canje.<br/>
        Solo se validará una entrada por cada asistente.
      </p>
      <p>Un saludo,<br><strong>Ignacio Solsona</strong><br>Laboroteca</p>
    `
      : `
      <p>Hola ${escapeHtml(displayName)},</p>
      <p>Gracias por tu compra. Adjuntamos tus <strong>${numEntradas}</strong> entrada(s) para:</p>
      <p><strong>${escapeHtml(descripcionProducto)}</strong></p>
      ${bloqueEventoHTML}
      ${euros ? `<p>Importe total: <strong>${euros.html} €</strong></p>` : ''}
      <p>Cada entrada incluye un código QR único que se validará el día del evento. Puedes llevarlas en el móvil o impresas.</p>
      <p>
        Una vez validada tu entrada en el evento, el código de la misma podrá canjearse por un libro digital gratuito desde:<br/>
        https://www.laboroteca.es/canjear-codigo-regalo/<br/>
        Si no asistes y tu entrada no es validada, no podrás realizar el canje.<br/>
        Solo se validará una entrada por cada asistente.
      </p>
      <p>Un saludo,<br><strong>Ignacio Solsona</strong><br>Laboroteca</p>
    `;

  const textPorDefecto =
    modo === 'reenvio'
      ? `Hola ${displayName},

Te reenviamos tus ${numEntradas} entrada(s) para:
- ${descripcionProducto}
${fecha ? `- Fecha: ${fecha}\n` : ''}${direccion ? `- Lugar: ${direccion}\n` : ''}

Cada entrada incluye un código QR único que se validará el día del evento.
Puedes llevarlas en el móvil o impresas.

Una vez validada tu entrada en el evento, el código de la misma podrá canjearse por un libro digital gratuito desde:
https://www.laboroteca.es/canjear-codigo-regalo/
Si no asistes y tu entrada no es validada, no podrás realizar el canje.
Solo se validará una entrada por cada asistente.

Un saludo,
Ignacio Solsona
Laboroteca`
      : `Hola ${displayName},

Gracias por tu compra. Adjuntamos tus ${numEntradas} entrada(s) para:
- ${descripcionProducto}
${fecha ? `- Fecha: ${fecha}\n` : ''}${direccion ? `- Lugar: ${direccion}\n` : ''}${euros ? `- Importe total: ${euros.text} €\n` : ''}

Cada entrada incluye un código QR único que se validará el día del evento.
Puedes llevarlas en el móvil o impresas.

Una vez validada tu entrada en el evento, el código de la misma podrá canjearse por un libro digital gratuito desde:
https://www.laboroteca.es/canjear-codigo-regalo/
Si no asistes y tu entrada no es validada, no podrás realizar el canje.
Solo se validará una entrada por cada asistente.

Un saludo,
Ignacio Solsona
Laboroteca`;

  // Adjuntos (entradas + factura opcional)
  const attachments = entradas.map((entrada, i) => ({
    filename: `ENTRADA ${i + 1}.pdf`,
    fileblob: entrada.buffer.toString('base64'),
    mimetype: 'application/pdf'
  }));

  if (facturaAdjunta && Buffer.isBuffer(facturaAdjunta)) {
    attachments.push({
      filename: 'Factura Laboroteca.pdf',
      fileblob: facturaAdjunta.toString('base64'),
      mimetype: 'application/pdf'
    });
  }

  // Envío
  await enviarEmailPersonalizado({
    to: email,
    subject: finalSubject,
    html: html || htmlPorDefecto,
    text: textPorDefecto,
    attachments
  });

  console.log(`📧 Email (${modo}) con ${numEntradas} entrada(s) enviado a ${email}`);
}

/** Escapa caracteres HTML básicos */
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { enviarEmailConEntradas };
