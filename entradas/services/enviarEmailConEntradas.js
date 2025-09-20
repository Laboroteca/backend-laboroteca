// 📂 /entradas/services/enviarEmailConEntradas.js
const { enviarEmailPersonalizado } = require('../../services/email');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

/** Carga segura de la política RGPD usada en los emails de compra (si existe) */
function getPoliticaHTML() {
  try {
    const mod = require('../../services/politica');
    if (mod && typeof mod.politicaHTML === 'string') return mod.politicaHTML;
  } catch (_) {}
  return '';
}
function getPoliticaTEXT() {
  try {
    const mod = require('../../services/politica');
    if (mod && typeof mod.politicaTEXT === 'string') return mod.politicaTEXT;
  } catch (_) {}
  return '';
}

/**
 * Envía un email con entradas (y factura opcional).
 * Soporta modo "compra" (por defecto), "reenvio" y "regalo".
 *
 * @param {Object} opciones
 * @param {string} opciones.email               - Destinatario
 * @param {string} [opciones.nombre]            - Nombre del destinatario (fallback: parte local del email)
 * @param {Array<{ buffer: Buffer }>} opciones.entradas - Entradas en PDF (mín. 1)
 * @param {Buffer|null} [opciones.facturaAdjunta=null]  - Factura PDF (opcional, solo en compra normalmente)
 * @param {string} opciones.descripcionProducto - Nombre del evento
 * @param {number} [opciones.importe]           - Importe total en € (solo en compra)
 * @param {"compra"|"reenvio"|"regalo"} [opciones.modo="compra"] - Tipo de email
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

  const requestId = (Math.random().toString(36).slice(2) + Date.now().toString(36)).toUpperCase();
  const maskEmail = (e) => {
    if (!e) return '';
    const [u, d] = String(e).split('@');
    const uh = (u || '').slice(0,2);
    const tld = (d || '').split('.').pop() || '';
    return `${uh}***@***.${tld}`;
  };

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
  // Cada entrada debe traer un Buffer válido
  if (!entradas.every(e => e && Buffer.isBuffer(e.buffer))) {
    throw new Error('Formato de entradas inválido: se esperaba Buffer en cada elemento.');
  }
  // Si viene factura, debe ser Buffer
  if (facturaAdjunta && !Buffer.isBuffer(facturaAdjunta)) {
    throw new Error('Formato de facturaAdjunta inválido: se esperaba Buffer.');
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

  const bloqueEventoTEXT = (fecha || direccion)
    ? `${fecha ? `- Fecha: ${fecha}\n` : ''}${direccion ? `- Lugar: ${direccion}\n` : ''}`
    : '';

  // Política (si existe en el proyecto, se añade al final)
  const politicaHTML = getPoliticaHTML();
  const politicaTEXT = getPoliticaTEXT();

  // Asunto por defecto según modo
  const defaultSubject =
    modo === 'reenvio'
      ? `Reenvío de entradas: «${descripcionProducto}»`
      : modo === 'regalo'
        ? `Tus entradas de regalo para «${descripcionProducto}»`
        : `🎟️ Tus entradas para «${descripcionProducto}»`;

  const finalSubject = subject || defaultSubject;
  // Sanitizar subject para evitar inyección de cabeceras (CRLF)
  const safeSubject = String(finalSubject || '')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200); // límite razonable

  // Cuerpos por defecto (HTML)
  const htmlPorDefecto =
    modo === 'reenvio'
      ? `
      <p>Hola ${escapeHtml(displayName)},</p>
      <p>Te reenviamos tus <strong>${numEntradas}</strong> entrada(s) para <strong>«${escapeHtml(descripcionProducto)}»</strong>.</p>
      ${bloqueEventoHTML}
      <p>Puedes presentar el <strong>PDF adjunto</strong> en tu móvil o impreso. Cada entrada incluye su <strong>código QR único</strong>.</p>
      <p>
        Una vez validada tu entrada en el evento, el código de la misma podrá canjearse por un libro digital gratuito desde:<br/>
        <a href="https://www.laboroteca.es/canjear-codigo-regalo/">https://www.laboroteca.es/canjear-codigo-regalo/</a><br/>
        Si no asistes y tu entrada no es validada, no podrás realizar el canje.<br/>
        Solo se validará una entrada por cada asistente.
      </p>
      <p>Un saludo,<br><strong>Ignacio Solsona</strong><br>Laboroteca</p>
      ${politicaHTML || ''}
    `
      : modo === 'regalo'
        ? `
      <p>Estimado ${escapeHtml(displayName)},</p>
      <p>Te mando de forma <strong>totalmente gratuita</strong> tus entradas para: <strong>${escapeHtml(descripcionProducto)}</strong>.</p>
      ${bloqueEventoHTML}
      <p>Cada entrada incluye un código QR único que se validará el día del evento. Puedes llevarlas en el móvil o impresas.</p>
      <p>
        Una vez validada tu entrada en el evento, el código de la misma podrá canjearse por un libro digital gratuito desde:<br/>
        <a href="https://www.laboroteca.es/canjear-codigo-regalo/">https://www.laboroteca.es/canjear-codigo-regalo/</a><br/>
        Si no asistes y tu entrada no es validada, no podrás realizar el canje.<br/>
        Solo se validará una entrada por cada asistente.
      </p>
      <p>Un saludo,<br>
        <strong>Ignacio Solsona</strong><br>
        Abogado
      </p>
      <hr/>
      ${politicaHTML || ''}
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
        <a href="https://www.laboroteca.es/canjear-codigo-regalo/">https://www.laboroteca.es/canjear-codigo-regalo/</a><br/>
        Si no asistes y tu entrada no es validada, no podrás realizar el canje.<br/>
        Solo se validará una entrada por cada asistente.
      </p>
      <p>Un saludo,<br><strong>Ignacio Solsona</strong><br>Laboroteca</p>
      ${politicaHTML || ''}
    `;

  // Cuerpos por defecto (Texto plano)
  const textPorDefecto =
    modo === 'reenvio'
      ? `Hola ${displayName},

Te reenviamos tus ${numEntradas} entrada(s) para:
- ${descripcionProducto}
${bloqueEventoTEXT}

Cada entrada incluye un código QR único que se validará el día del evento.
Puedes llevarlas en el móvil o impresas.

Una vez validada tu entrada en el evento, el código de la misma podrá canjearse por un libro digital gratuito desde:
https://www.laboroteca.es/canjear-codigo-regalo/
Si no asistes y tu entrada no es validada, no podrás realizar el canje.
Solo se validará una entrada por cada asistente.

Un saludo,
Ignacio Solsona
Laboroteca
${politicaTEXT || ''}`
      : modo === 'regalo'
        ? `Estimado ${displayName},

Te mando de forma totalmente gratuita tus entradas para:
- ${descripcionProducto}
${bloqueEventoTEXT}

Cada entrada incluye un código QR único que se validará el día del evento.
Puedes llevarlas en el móvil o impresas.

Una vez validada tu entrada en el evento, el código de la misma podrá canjearse por un libro digital gratuito desde:
https://www.laboroteca.es/canjear-codigo-regalo/
Si no asistes y tu entrada no es validada, no podrás realizar el canje.
Solo se validará una entrada por cada asistente.

Un saludo,
Ignacio Solsona
Abogado
${politicaTEXT || ''}`
        : `Hola ${displayName},

Gracias por tu compra. Adjuntamos tus ${numEntradas} entrada(s) para:
- ${descripcionProducto}
${bloqueEventoTEXT}${euros ? `- Importe total: ${euros.text} €\n` : ''}

Cada entrada incluye un código QR único que se validará el día del evento.
Puedes llevarlas en el móvil o impresas.

Una vez validada tu entrada en el evento, el código de la misma podrá canjearse por un libro digital gratuito desde:
https://www.laboroteca.es/canjear-codigo-regalo/
Si no asistes y tu entrada no es validada, no podrás realizar el canje.
Solo se validará una entrada por cada asistente.

Un saludo,
Ignacio Solsona
Laboroteca
${politicaTEXT || ''}`;

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
  try {
    await enviarEmailPersonalizado({
      to: email,
      subject: safeSubject,
      html: html || htmlPorDefecto,
      text: textPorDefecto,
      attachments
    });
  } catch (e) {
    // Aviso centralizado si falla el envío (deduplicado por alertAdminProxy)
    try {
      await alertAdmin({
        area: 'email.entradas.enviar',
        email,
        err: e,
        meta: {
          modo,
          descripcionProducto,
          numEntradas,
          hasFactura: !!facturaAdjunta,
          requestId
        }
      });
    } catch (_) {}
    throw e; // mantener comportamiento: propagar al caller
  }


  console.log(`📧 Email (${modo}) con ${numEntradas} entrada(s) enviado a ${maskEmail(email)} [${requestId}]`);
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
