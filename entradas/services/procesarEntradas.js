// entradas/services/procesarEntradas.js
const dayjs = require('dayjs');

const { generarCodigoEntrada, normalizar } = require('../utils/codigos');
const { generarEntradaPDF } = require('../utils/generarEntradaPDF');
const { subirEntrada } = require('../utils/gcsEntradas');
const { guardarEntradaEnSheet } = require('../utils/sheetsEntradas');
const { enviarEmailConEntradas } = require('./enviarEmailConEntradas');
const { registrarEntradaFirestore } = require('./registrarEntradaFirestore');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

module.exports = async function procesarEntradas({ session, datosCliente, pdfBuffer = null }) {
  const requestId = (Math.random().toString(36).slice(2) + Date.now().toString(36)).toUpperCase();
  const maskEmail = (e) => {
    if (!e) return '';
    const [u, d] = String(e).split('@');
    const uh = (u || '').slice(0,2);
    const tld = (d || '').split('.').pop() || '';
    return `${uh}***@***.${tld}`;
  };
  const emailComprador = datosCliente.email;

  // ⚙️ Datos del evento (preferimos descripcionProducto para carpeta/etiquetas)
  const md = session?.metadata || {};
  const nombreActuacion = md.nombreProducto || 'Evento Laboroteca';
  const descripcionProd = String(md.descripcionProducto || nombreActuacion).trim();
  const fechaActuacion  = md.fechaActuacion || '';
  const imagenFondo     = md.imagenEvento || null;
  const formularioId    = md.formularioId;
  const total           = parseInt(md.totalAsistentes || 0, 10);
  const direccionEvento = md.direccionEvento || '';

  if (!formularioId) throw new Error('Falta el formularioId en metadata');
  if (!total || total <= 0) throw new Error('Falta totalAsistentes válido');
  if (!descripcionProd || /^entrada\s*$/i.test(descripcionProd)) {
    throw new Error('Descripción de producto inválida para la factura');
  }

  // slug del evento para el código (seguimos usando el “nombreActuacion” como antes)
  const slugEvento = nombreActuacion.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  // Carpeta basada en la descripción (Madrid/Barcelona → carpetas distintas)
  const carpetaDescripcion = normalizar(descripcionProd);

  // 1) Generar TODOS los PDFs en memoria (sin subir/registrar aún)
  const asistentes = Array.from({ length: total }, () => ({ nombre: '', apellidos: '' }));
  const archivosPDF = []; // [{ buffer }]
  const codigos = [];     // códigos por entrada (mismo índice que archivosPDF)
  const codigosSet = new Set(); // evitar colisiones accidentales

  for (let i = 0; i < asistentes.length; i++) {
    // Generar código único (reintentos acotados por si colisiona)
    let codigo = generarCodigoEntrada(slugEvento);
    let tries = 0;
    while (codigosSet.has(codigo) && tries < 3) {
      codigo = generarCodigoEntrada(slugEvento);
      tries++;
    }
    codigosSet.add(codigo);
    try {
      const pdfBufferEntrada = await generarEntradaPDF({
        nombre: asistentes[i].nombre,
        apellidos: asistentes[i].apellidos,
        codigo,
        nombreActuacion,
        fechaActuacion,
        descripcionProducto: descripcionProd,
        direccionEvento,
        imagenFondo
      });
      archivosPDF.push({ buffer: pdfBufferEntrada });
      codigos.push(codigo);
    } catch (e) {
      // No bloquea: seguimos con el resto, avisamos y registramos error luego
      try {
        await alertAdmin({
          area: 'entradas.procesar.pdf',
          email: emailComprador,
          err: e,
          meta: { requestId, idx: i + 1, codigo, descripcionProducto: descripcionProd }
        });
      } catch (_) {}
      // No añadimos entrada inválida al array: enviamos las que sí se generaron
    }
  }

  // 2) Enviar SIEMPRE email al comprador con los PDFs (este es el hito incondicional)
  try {
    // 1º intento: con factura si está disponible
    await enviarEmailConEntradas({
      email: emailComprador,
      nombre: datosCliente.nombre,
      entradas: archivosPDF,
      descripcionProducto: descripcionProd,
      importe: datosCliente.importe,
      facturaAdjunta: pdfBuffer || null
    });
  } catch (e) {
    console.error('❌ Falló el envío con factura (o sin ella si no había):', e?.message || e);
    // Aviso admin del fallo del 1º intento
    try {
      await alertAdmin({
        area: 'entradas.procesar.email.factura',
        email: emailComprador,
        err: e,
        meta: {
          sessionId: session?.id || '-',
          totalAsistentes: parseInt(md.totalAsistentes || 0, 10) || 0,
          descripcionProducto: descripcionProd,
          hadFacturaAdjunta: !!pdfBuffer,
          requestId
        }
      });
    } catch (_) {}
    // 2º intento: reenviar sin factura
    try {
      await enviarEmailConEntradas({
        email: emailComprador,
        nombre: datosCliente.nombre,
        entradas: archivosPDF,
        descripcionProducto: descripcionProd,
        importe: datosCliente.importe,
        facturaAdjunta: null
      });
    } catch (e2) {
      console.error('❌ También falló el reenvío sin factura:', e2?.message || e2);
      try {
        await alertAdmin({
          area: 'entradas.procesar.email.reintento',
          email: emailComprador,
          err: e2,
          meta: {
            sessionId: session?.id || '-',
            descripcionProducto: descripcionProd,
            nota: 'Fallo en segundo intento de envío (sin factura)',
            requestId
          }
        });
      } catch (_) {}
    }
    // Email informativo al admin SOLO si realmente había factura prevista
    if (pdfBuffer) {
      try {
        const { enviarEmailPersonalizado } = require('../../services/email');
        await enviarEmailPersonalizado({
          to: 'laboroteca@gmail.com',
          subject: '⚠️ Fallo al adjuntar factura en venta de entradas',
          text: `El comprador ${emailComprador} ha pagado entradas pero la factura no se adjuntó.\nEvento: ${nombreActuacion} · ${descripcionProd}\nStripe session: ${session?.id || '-'}\n\nError: ${e.message || e}`,
          html: `<p><strong>El comprador ${emailComprador} ha pagado entradas pero la factura no se adjuntó.</strong></p>
                <p>Evento: ${nombreActuacion} · ${descripcionProd}</p>
                <p>Stripe session: ${session?.id || '-'}</p>
                <p>Error: ${e.message || e}</p>`
        });
      } catch (err) {
        console.error('⚠️ No se pudo avisar al admin del fallo de factura:', err?.message || err);
      }
    }
  }


  // 3) Registrar best-effort en GCS / Sheets / Firestore (errores no bloquean)
  const errores = [];
  const fechaGeneracion = dayjs().format('YYYY-MM-DD HH:mm:ss');

  // Intentar resolver sheetId, pero no bloquear si falla
  let sheetId = null;
  try {
    sheetId = obtenerSheetIdPorFormulario(formularioId);
  } catch (e) {
    console.warn('🟨 Sin sheetId para formularioId', formularioId, e?.message || e);
    try {
      await alertAdmin({
        area: 'entradas.procesar.sheets_cfg',
        email: emailComprador,
        err: e,
        meta: { formularioId }
      });
    } catch (_) {}
    errores.push({
      paso: 'SHEETS_CFG',
      detalle: `formularioId=${formularioId}`,
      motivo: 'Configuración inválida de Google Sheets (sheetId no resuelto)'
    });
  }

  for (let i = 0; i < archivosPDF.length; i++) {
    const codigo = codigos[i];
    const buf = archivosPDF[i].buffer;

    // GCS (best-effort)
    try {
      const nombreArchivo = `entradas/${carpetaDescripcion}/${codigo}.pdf`;
      await subirEntrada(nombreArchivo, buf);
    } catch (e) {
      console.error('❌ GCS:', e.message || e);
      try {
        await alertAdmin({
          area: 'entradas.procesar.gcs',
          email: emailComprador,
          err: e,
          meta: { codigo, carpeta: carpetaDescripcion, requestId }
        });
      } catch (_) {}
      errores.push({
        paso: 'GCS',
        codigo,
        detalle: e?.message || String(e),
        motivo: 'No se han subido las entradas en GCS'
      });
    }

    // Sheets (best-effort; solo si tenemos sheetId)
    if (sheetId) {
      try {
        await guardarEntradaEnSheet({
          sheetId,
          codigo,
          comprador: emailComprador,
          descripcionProducto: descripcionProd,
          usado: 'NO',
          fecha: fechaGeneracion
        });
      } catch (e) {
        console.error('❌ Sheets:', e.message || e);
        try {
          await alertAdmin({
            area: 'entradas.procesar.sheets',
            email: emailComprador,
            err: e,
            meta: { codigo, sheetId, fecha: fechaGeneracion, descripcionProducto: descripcionProd, requestId }
          });
        } catch (_) {}
        errores.push({
          paso: 'SHEETS',
          codigo,
          detalle: e?.message || String(e),
          motivo: 'No se ha registrado la venta en Google Sheets'
        });
      }
    }

    // Firestore (best-effort)
    try {
      await registrarEntradaFirestore({
        codigoEntrada: codigo,
        emailComprador,
        nombreAsistente: '',            // no tenemos nombres por entrada aquí
        slugEvento,
        nombreEvento: nombreActuacion,
        descripcionProducto: descripcionProd,
        direccionEvento,
        fechaActuacion                  // "DD/MM/YYYY - HH:mm"
      });
    } catch (e) {
      console.error('❌ Firestore:', e.message || e);
      try {
        await alertAdmin({
          area: 'entradas.procesar.firestore',
          email: emailComprador,
          err: e,
          meta: { codigo, slugEvento, descripcionProducto: descripcionProd, requestId }
        });
      } catch (_) {}
      errores.push({
        paso: 'FIRESTORE',
        codigo,
        detalle: e?.message || String(e),
        motivo: 'No se ha registrado en Firebase (Firestore)'
      });
    }
  }

  // 4) Aviso a admin si hubo fallos en cualquiera de los pasos post-email (no bloquea)
  if (errores.length) {
    try {
      const { enviarEmailPersonalizado } = require('../../services/email');

      // Resumen de motivos únicos
      const motivosUnicos = Array.from(new Set(errores.map(e => e.motivo).filter(Boolean)));

      const subject = '⚠️ Fallos durante la venta de Entradas';

      const textoErrores = errores
        .map(e => `- Paso: ${e.paso}${e.codigo ? ` | Código: ${e.codigo}` : ''} | Motivo: ${e.motivo || '-'} | Detalle: ${e.detalle}`)
        .join('\n');

      const text =
`Ha ocurrido un fallo durante la venta de entradas.
El usuario ha pagado las entradas y se le han mandado por email, pero se han producido los siguientes problemas:
${motivosUnicos.length ? motivosUnicos.map(m => `- ${m}`).join('\n') : '- (sin motivo específico)'}

Usuario afectado: ${emailComprador}
Evento: ${nombreActuacion} · ${descripcionProd}
Fecha del evento: ${fechaActuacion || '-'}
Lugar del evento: ${direccionEvento || '-'}
Formulario: ${formularioId || '-'}
Stripe session: ${session?.id || '-'}
Payment intent: ${session?.payment_intent || '-'}

Entradas afectadas: ${codigos.length ? codigos.join(', ') : '(desconocido)'}

Detalle de errores:
${textoErrores}
`;

      const html = `
        <p><strong>Ha ocurrido un fallo durante la venta de entradas.</strong></p>
        <p>El usuario ha pagado las entradas y se le han mandado por email, pero se han producido los siguientes problemas:</p>
        <ul style="margin:0 0 12px 18px">
          ${motivosUnicos.length
            ? motivosUnicos.map(m => `<li><span style="font-size:16px"><strong>${m}</strong></span></li>`).join('')
            : '<li><span style="font-size:16px"><strong>(sin motivo específico)</strong></span></li>'}
        </ul>


        <h4>Contexto</h4>
        <ul>
          <li><strong>Usuario afectado:</strong> ${emailComprador}</li>
          <li><strong>Evento:</strong> ${nombreActuacion} · ${descripcionProd}</li>
          <li><strong>Fecha del evento:</strong> ${fechaActuacion || '-'}</li>
          <li><strong>Lugar del evento:</strong> ${direccionEvento || '-'}</li>
          <li><strong>Formulario:</strong> ${formularioId || '-'}</li>
          <li><strong>Stripe session:</strong> ${session?.id || '-'}</li>
          <li><strong>Payment intent:</strong> ${session?.payment_intent || '-'}</li>
          <li><strong>Entradas afectadas:</strong> ${codigos.length ? codigos.join(', ') : '(desconocido)'}</li>
        </ul>

        <h4>Detalle de errores</h4>
        <ul>
          ${errores.map(e => `<li><strong>${e.paso}</strong>${e.codigo ? ` · Código: ${e.codigo}` : ''} · Motivo: ${e.motivo || '-'} · ${e.detalle}</li>`).join('')}
        </ul>

        <p style="margin-top:16px;color:#666">Este mensaje se ha generado automáticamente tras la entrega de entradas al comprador.</p>
      `;

      await enviarEmailPersonalizado({
        to: 'laboroteca@gmail.com',
        subject,
        html,
        text
      });
      // Aviso breve por proxy para tener traza en adminAlerts (dedupe)
      try {
        await alertAdmin({
          area: 'entradas.procesar.resumen',
          email: emailComprador,
          err: new Error('Fallos post-email en generar/registrar entradas'),
          meta: {
            formularioId,
            sessionId: session?.id || '-',
            codigos,
            motivos: motivosUnicos,
            requestId
          }
        });
      } catch (_) {}
    } catch (e) {
      console.error('⚠️ No se pudo avisar al admin:', e.message || e);
    }
  }

  console.log(`✅ Entradas generadas y enviadas a ${maskEmail(emailComprador)}: ${archivosPDF.length} [${requestId}]`);
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
