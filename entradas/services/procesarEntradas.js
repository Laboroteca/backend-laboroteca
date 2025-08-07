const path = require('path');
const fs = require('fs').promises;
const dayjs = require('dayjs');

const { generarCodigoEntrada } = require('../utils/codigos');
const { generarEntradaPDF } = require('../utils/generarEntradaPDF');
const { subirEntrada } = require('../utils/gcsEntradas');
const { guardarEntradaEnSheet } = require('../utils/sheetsEntradas');
const { enviarEmailConEntradas } = require('./enviarEmailConEntradas');

/**
 * Procesa la compra de entradas: genera PDFs, guarda en Sheets y envía email con adjuntos.
 * 
 * @param {Object} params
 * @param {Object} params.session - Sesión de Stripe
 * @param {Object} params.datosCliente - Datos del comprador
 * @param {Buffer|null} [params.pdfBuffer] - Factura en PDF (opcional, solo si se ha generado antes)
 */
module.exports = async function procesarEntradas({ session, datosCliente, pdfBuffer = null }) {
  const emailComprador = datosCliente.email;
  const nombreActuacion = session.metadata.nombreProducto || 'Evento Laboroteca';
  const fechaActuacion = session.metadata.fechaActuacion || '';
  const slugEvento = nombreActuacion.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const imagenFondo = session.metadata.imagenEvento || null;
  const formularioId = session.metadata.formularioId;
  const total = parseInt(session.metadata.totalAsistentes || 0);

  if (!formularioId) throw new Error('Falta el formularioId en metadata');
  if (!total || total <= 0) throw new Error('Falta totalAsistentes válido');

  const asistentes = Array.from({ length: total }, () => ({
    nombre: '',
    apellidos: ''
  }));

  const archivosPDF = [];
  const fechaGeneracion = dayjs().format('YYYY-MM-DD HH:mm:ss');
  const sheetId = obtenerSheetIdPorFormulario(formularioId);

  for (const [index, asistente] of asistentes.entries()) {
    const codigo = generarCodigoEntrada(slugEvento);

    const pdfBuffer = await generarEntradaPDF({
      nombre: asistente.nombre,
      apellidos: asistente.apellidos,
      codigo,
      nombreActuacion,
      fechaActuacion,
      descripcionProducto: session.metadata.descripcionProducto || '',
      direccionEvento: session.metadata.direccionEvento || '',
      imagenFondo
    });

    const nombreArchivo = `entradas/${slugEvento}/${codigo}.pdf`;
    await subirEntrada(nombreArchivo, pdfBuffer);

    await guardarEntradaEnSheet({
      sheetId,
      codigo,
      comprador: emailComprador,
      usado: 'NO',
      fecha: fechaGeneracion
    });

    archivosPDF.push({ buffer: pdfBuffer }); // ✅ pdfBuffer sí está definido
  }

  await enviarEmailConEntradas({
    email: emailComprador,
    nombre: datosCliente.nombre,
    entradas: archivosPDF,
    descripcionProducto: nombreActuacion,
    importe: datosCliente.importe,
    facturaAdjunta: pdfBuffer || null // 👈🏼 Se adjunta correctamente aquí
  });

  console.log(`✅ Entradas generadas para ${emailComprador}: ${asistentes.length}`);
};

function obtenerSheetIdPorFormulario(formularioId) {
  const mapa = {
    '22': '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
    '25': '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
    '28': '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
    '31': '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
    '34': '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc'
  };

  const id = String(formularioId);
  if (!mapa[id]) throw new Error(`No se ha definido una hoja para el formularioId: ${formularioId}`);
  return mapa[id];
}
