const path = require('path');
const fs = require('fs').promises;
const dayjs = require('dayjs');

const { generarCodigoEntrada } = require('../utils/codigos');
const { generarEntradaPDF } = require('../utils/generarEntradaPDF');
const { subirEntrada } = require('../utils/gcsEntradas');
const { guardarEntradaEnSheet } = require('../utils/sheetsEntradas');
const { enviarEmailConEntradas } = require('./enviarEmailConEntradas');
const { registrarEntradaFirestore } = require('./registrarEntradaFirestore');

/**
 * Procesa la compra de entradas: genera PDFs, guarda en Sheets, Firestore y envía email con adjuntos.
 * 
 * @param {Object} params
 * @param {Object} params.session - Sesión de Stripe
 * @param {Object} params.datosCliente - Datos del comprador
 * @param {Buffer|null} [params.pdfBuffer] - Factura en PDF (opcional, solo si se ha generado antes)
 */
module.exports = async function procesarEntradas({ session, datosCliente, pdfBuffer = null }) {
  const emailComprador  = datosCliente.email;

  // ⚙️ Datos del evento (preferimos descripcionProducto para carpeta/etiquetas)
  const nombreActuacion = session.metadata.nombreProducto || 'Evento Laboroteca';
  const descripcionProd = (session.metadata.descripcionProducto || nombreActuacion).trim();
  const fechaActuacion  = session.metadata.fechaActuacion || '';
  const imagenFondo     = session.metadata.imagenEvento || null;
  const formularioId    = session.metadata.formularioId;
  const total           = parseInt(session.metadata.totalAsistentes || 0, 10);

  if (!formularioId) throw new Error('Falta el formularioId en metadata');
  if (!total || total <= 0) throw new Error('Falta totalAsistentes válido');

  // slug del evento para el código (seguimos usando el “nombreActuacion” como antes)
  const slugEvento = nombreActuacion.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  // carpeta basada en la descripción (Madrid/Barcelona → carpetas distintas)
  const carpetaDescripcion = descripcionProd
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const asistentes = Array.from({ length: total }, () => ({
    nombre: '',
    apellidos: ''
  }));

  const archivosPDF = [];
  const fechaGeneracion = dayjs().format('YYYY-MM-DD HH:mm:ss');
  const sheetId = obtenerSheetIdPorFormulario(formularioId);

  for (const [index, asistente] of asistentes.entries()) {
    // Prefijo del código se sigue generando con el slug del evento (sin cambio)
    const codigo = generarCodigoEntrada(slugEvento);

    const pdfBufferEntrada = await generarEntradaPDF({
      nombre: asistente.nombre,
      apellidos: asistente.apellidos,
      codigo,
      nombreActuacion,                         // se muestra en el PDF
      fechaActuacion,
      descripcionProducto: descripcionProd,    // también disponible para el PDF
      direccionEvento: session.metadata.direccionEvento || '',
      imagenFondo
    });

    // 📂 NUEVA carpeta en GCS basada en descripcionProducto (no slugEvento)
    const { normalizar } = require('../utils/codigos'); // ya lo tienes
    const carpeta = normalizar(session.metadata.descripcionProducto || nombreActuacion);
    const nombreArchivo = `entradas/${carpeta}/${codigo}.pdf`;

    await subirEntrada(nombreArchivo, pdfBufferEntrada);

    await guardarEntradaEnSheet({
      sheetId,
      codigo,
      comprador: emailComprador,
      descripcionProducto: descripcionProd, // 👈 nuevo campo
      usado: 'NO',
      fecha: fechaGeneracion
    });


    await registrarEntradaFirestore({
      codigoEntrada: codigo,
      emailComprador,
      nombreAsistente: `${asistente.nombre} ${asistente.apellidos}`.trim(),
      slugEvento,                 // lo mantenemos por compatibilidad
      nombreEvento: nombreActuacion
      // (si más adelante quieres guardar también descripcionProd, se añade aquí)
    });

    archivosPDF.push({ buffer: pdfBufferEntrada });
  }

  // ✉️ En el email ponemos la descripción (así coincide con la carpeta y el asunto)
  await enviarEmailConEntradas({
    email: emailComprador,
    nombre: datosCliente.nombre,
    entradas: archivosPDF,
    descripcionProducto: descripcionProd,
    importe: datosCliente.importe,
    facturaAdjunta: pdfBuffer || null
  });

  console.log(`✅ Entradas generadas para ${emailComprador}: ${asistentes.length}`);
};

function obtenerSheetIdPorFormulario(formularioId) {
  const id = String(formularioId).trim();

  // Permite override por variables de entorno y tiene fallback fijo
  const mapa = {
    '22': process.env.SHEET_ID_FORM_22 || '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
    '39': process.env.SHEET_ID_FORM_39 || '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
    '40': process.env.SHEET_ID_FORM_40 || '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
    '41': process.env.SHEET_ID_FORM_41 || '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
    '42': process.env.SHEET_ID_FORM_42 || '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc'
  };

  const sheetId = mapa[id];
  if (!sheetId) {
    throw new Error(`No se ha definido una hoja para el formularioId: ${formularioId}`);
  }
  return sheetId;
}
