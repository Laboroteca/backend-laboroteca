const admin = require('../firebase');
const firestore = admin.firestore();

const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail } = require('./email');
const { subirFactura } = require('./gcs');
const { guardarEnGoogleSheets } = require('./googleSheets');
const { activarMembresiaClub } = require('./activarMembresiaClub');
const { syncMemberpressClub } = require('./syncMemberpressClub');
const { normalizarProducto, MEMBERPRESS_IDS } = require('../utils/productos');
const { ensureOnce } = require('../utils/dedupe');


module.exports = async function procesarCompra(datos) {
  let email = (datos.email_autorelleno || datos.email || '').trim().toLowerCase();
  let nombreProducto = (datos.nombreProducto || 'Producto Laboroteca').trim();
  let descripcionProducto = datos.descripcionProducto || nombreProducto;
  let tipoProducto = datos.tipoProducto || 'Otro';
  let importe = parseFloat((datos.importe || '29,90').toString().replace(',', '.'));

  // 🔍 Buscar email por alias si no es válido
  if (!email.includes('@')) {
    const alias = (datos.alias || datos.userAlias || '').trim();
    if (alias) {
      try {
        const userSnap = await firestore.collection('usuariosClub').doc(alias).get();
        if (userSnap.exists) {
          email = (userSnap.data().email || '').trim().toLowerCase();
          console.log(`📩 Email recuperado por alias (${alias}):`, email);
        }
      } catch (err) {
        console.error(`❌ Error recuperando email por alias "${alias}":`, err);
      }
    }
  }

  if (!email || !email.includes('@')) {
    throw new Error(`❌ Email inválido: "${email}"`);
  }

    // 🛑 DEDUPLICACIÓN TEMPRANA (ATÓMICA) + logs
    const claveNormalizada = normalizarProducto(nombreProducto);

    // Clave de idempotencia priorizando IDs "fuertes"
    const dedupeKey =
      datos.invoiceId ||
      datos.sessionId ||
      datos.pedidoId ||
      // fallback conservador: para Club, una por día por email+importe
      (tipoProducto?.toLowerCase() === 'club'
        ? `club:${email}:${importe.toFixed(2)}:${new Date().toISOString().slice(0,10)}`
        : null);


    if (dedupeKey) {
      const first = await ensureOnce('comprasOnce', dedupeKey);
      if (!first) {
        console.warn(`🟡 Duplicado ignorado key=${dedupeKey}`);
        return { success: false, mensaje: 'Compra ya procesada (duplicado)' };
      }

      // 🔒 Segundo cerrojo: evita carreras simultáneas en paralelo
      const lockRef = firestore.collection('locks').doc(dedupeKey);
      try {
        await lockRef.create({ createdAt: admin.firestore.FieldValue.serverTimestamp() });
      } catch (e) {
        if (e.code === 6 || /already exists/i.test(String(e.message || ''))) {
          console.warn(`🟡 Duplicado ignorado (lock existe) key=${dedupeKey}`);
          return { success: false, mensaje: 'Compra ya procesada (duplicado)' };
        }
        throw e;
      }
    }


    // ✅ LOGS
    console.log('🧪 tipoProducto:', tipoProducto);
    console.log('🧪 nombreProducto:', nombreProducto);
    console.log('🔑 Clave normalizada para deduplicación:', claveNormalizada);


  const compraId = `compra-${Date.now()}`;
  const docRef = firestore.collection('comprasProcesadas').doc(compraId);
  let compRef = null; // ← añadido para tracking por dedupeKey


  await docRef.set({
    compraId,
    estado: 'procesando',
    email,
    producto: claveNormalizada,
    dedupeKey: dedupeKey || null,
    fechaInicio: new Date().toISOString()
  });

  // Tracking estable por dedupeKey (además del doc temporal con timestamp)
    if (dedupeKey) {
      compRef = firestore.collection('comprasProcesadas').doc(dedupeKey);
      await compRef.set({
        estado: 'procesando',
        email,
        producto: claveNormalizada,
        dedupeKey,
        tipoProducto,
        importe,
        fechaInicio: new Date().toISOString()
      }, { merge: true });
    }



  try {
    const nombre = datos.nombre || datos.Nombre || '';
    const apellidos = datos.apellidos || datos.Apellidos || '';
    const dni = datos.dni || '';
    const direccion = datos.direccion || datos['Dirección'] || '';
    const ciudad = datos.ciudad || datos['Municipio'] || '';
    const provincia = datos.provincia || datos['Provincia'] || '';
    const cp = datos.cp || datos['Código postal'] || '';

    const datosCliente = {
      nombre,
      apellidos,
      dni,
      importe,
      email,
      direccion,
      ciudad,
      cp,
      provincia,
      nombreProducto,
      descripcionProducto,
      tipoProducto
    };

    if (datos.invoiceId) {
      datosCliente.invoiceId = datos.invoiceId;
    }
    
    if (!nombre || !apellidos || !dni || !direccion || !ciudad || !provincia || !cp) {
      console.warn(`⚠️ [procesarCompra] Datos incompletos para factura de ${email}`);
    }

    console.time(`🕒 Compra ${email}`);
    console.log('📦 [procesarCompra] Datos facturación finales:\n', JSON.stringify(datosCliente, null, 2));

    
// ⛔ Kill-switch de facturación
const invoicingDisabled =
  String(process.env.DISABLE_INVOICING).toLowerCase() === 'true' ||
  process.env.DISABLE_INVOICING === '1';

let pdfBuffer;

if (invoicingDisabled) {
  console.warn('⛔ Facturación deshabilitada en procesarCompra. Saltando creación/subida/email.');

  // ✅ Registrar SIEMPRE en Google Sheets aunque no haya factura
  try {
    console.log('📝 → Registrando en Google Sheets (kill-switch activo)...');
    await guardarEnGoogleSheets(datosCliente);
  } catch (err) {
    console.error('❌ Error en Google Sheets:', err);
  }

} else {
  // 1) Crear factura
  try {
    console.log('🧾 → Generando factura...');
    pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);
    if (!pdfBuffer) {
    console.warn('🟡 FacturaCity devolvió null (posible duplicado). No se sube ni se envía.');
  } else {
    console.log(`✅ Factura PDF generada (${pdfBuffer.length} bytes)`);
  }

  } catch (err) {
    console.error('❌ Error al crear factura:', err);
    throw err; // conservamos comportamiento
  }

  // 2) Subir a GCS
  try {
    if (pdfBuffer) {
      const nombreArchivo = `facturas/${email}/${datos.invoiceId || Date.now()}-${claveNormalizada}.pdf`;
      console.log('☁️ → Subiendo a GCS:', nombreArchivo);
      await subirFactura(nombreArchivo, pdfBuffer, {
        email,
        nombreProducto,
        tipoProducto,
        importe
      });
      console.log('✅ Subido a GCS');
    }
  } catch (err) {
    console.error('❌ Error subiendo a GCS:', err);
  }

  // 3) Enviar por email
  try {
    if (pdfBuffer) {
      console.log('📧 → Enviando email con factura...');
      const resultado = await enviarFacturaPorEmail(datosCliente, pdfBuffer);
      if (resultado === 'OK') {
        console.log('✅ Email enviado');
      } else {
        console.warn('⚠️ Resultado inesperado del envío de email:', resultado);
      }
    }
  } catch (err) {
    console.error('❌ Error enviando email:', err);
  }


  // 4) Registrar en Google Sheets
  try {
    console.log('📝 → Registrando en Google Sheets...');
    await guardarEnGoogleSheets(datosCliente);
  } catch (err) {
    console.error('❌ Error en Google Sheets:', err);
  }
}


    const membership_id = MEMBERPRESS_IDS[claveNormalizada];

if (membership_id) { // ← robusto: activa CLUB por mapeo del producto, no por texto "club"
  try {
    console.log(`🔓 → Activando membresía CLUB con ID ${membership_id} para ${email}`);
    await activarMembresiaClub(email);
    await syncMemberpressClub({ email, accion: 'activar', membership_id, importe });
    console.log('✅ Membresía del CLUB activada correctamente');
  } catch (err) {
    console.error('❌ Error activando membresía del CLUB:', err.message || err);
  }
} else if (tipoProducto.toLowerCase() === 'libro') {
  try {
    const { syncMemberpressLibro } = require('./syncMemberpressLibro');
    console.log(`📘 → Activando membresía LIBRO para ${email}`);
    await syncMemberpressLibro({ email, accion: 'activar', importe });
    console.log('✅ Membresía del LIBRO activada correctamente');
  } catch (err) {
    console.error('❌ Error activando membresía del LIBRO:', err.message || err);
  }
}

    const datosFiscalesRef = firestore.collection('datosFiscalesPorEmail').doc(email);

    // ✅ Guardar/actualizar datos fiscales sin borrar el documento (merge)
    try {
      console.log('🧾 Guardando/actualizando datos fiscales en Firestore (merge)');
      await datosFiscalesRef.set({
        nombre,
        apellidos,
        dni,
        direccion,
        ciudad,
        provincia,
        cp,
        email,
        fecha: new Date().toISOString()
      }, { merge: true });
    } catch (err) {
      console.error('❌ Error guardando datos fiscales en Firestore:', err.message || err);
    }


    await docRef.update({
      estado: 'finalizado',
      facturaGenerada: !!pdfBuffer,
      fechaFin: new Date().toISOString()
    });

    if (compRef) {
      await compRef.set({
        estado: 'finalizado',
        facturaGenerada: !!pdfBuffer,
        fechaFin: new Date().toISOString()
      }, { merge: true });
    }



    if (datos.invoiceId) {
      await firestore.collection('facturasGeneradas').doc(datos.invoiceId).set({
        procesada: true,
        fecha: new Date().toISOString()
      });
      console.log(`🧾 Factura ${datos.invoiceId} marcada como procesada`);
    }

    console.log(`✅ Compra procesada con éxito para ${nombre} ${apellidos}`);
    console.timeEnd(`🕒 Compra ${email}`);
    return { success: true };

  } catch (error) {
    await docRef.update({
      estado: 'error',
      errorMsg: error?.message || error
    });
    if (compRef) {
      await compRef.set({
        estado: 'error',
        errorMsg: error?.message || String(error),
        fechaFin: new Date().toISOString()
      }, { merge: true });
    }
    console.error('❌ Error en procesarCompra:', error);
    throw error;
  }

};
