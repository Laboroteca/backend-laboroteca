const admin = require('../firebase');
const firestore = admin.firestore();
const crypto = require('crypto');

const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail } = require('./email');
const { subirFactura } = require('./gcs');
const { guardarEnGoogleSheets } = require('./googleSheets');
const { activarMembresiaClub } = require('./activarMembresiaClub');
const { syncMemberpressClub } = require('./syncMemberpressClub');
const { normalizarProducto, MEMBERPRESS_IDS } = require('../utils/productos');

module.exports = async function procesarCompra(datos) {
  let email = (datos.email_autorelleno || datos.email || '').trim().toLowerCase();
  let nombreProducto = (datos.nombreProducto || 'Producto Laboroteca').trim();
  let descripcionProducto = datos.descripcionProducto || nombreProducto;
  let tipoProducto = datos.tipoProducto || 'Otro';
  let importe = parseFloat((datos.importe || '22,90').toString().replace(',', '.'));

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

  // 🛑 DEDUPLICACIÓN TEMPRANA POR invoiceId
  if (datos.invoiceId) {
    const facturaDoc = await firestore.collection('facturasGeneradas').doc(datos.invoiceId).get();
    if (facturaDoc.exists) {
      console.log(`🛑 La factura ${datos.invoiceId} ya fue procesada. Cancelando ejecución.`);
      return { success: false, mensaje: 'Factura ya procesada' };
    }
  }

  // ✅ LOGS ADICIONALES
  console.log('🧪 tipoProducto:', tipoProducto);
  console.log('🧪 nombreProducto:', nombreProducto);

  const claveNormalizada = normalizarProducto(nombreProducto);

  console.log('🔑 Clave normalizada para deduplicación:', claveNormalizada);

  const compraId = `compra-${Date.now()}`;
  const docRef = firestore.collection('comprasProcesadas').doc(compraId);

  await docRef.set({
    compraId,
    estado: 'procesando',
    email,
    producto: claveNormalizada,
    fechaInicio: new Date().toISOString()
  });

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

    if (!nombre || !apellidos || !dni || !direccion || !ciudad || !provincia || !cp) {
      console.warn(`⚠️ [procesarCompra] Datos incompletos para factura de ${email}`);
    }

    console.time(`🕒 Compra ${email}`);
    console.log('📦 [procesarCompra] Datos facturación finales:\n', JSON.stringify(datosCliente, null, 2));

    let pdfBuffer;
    try {
      console.log('🧾 → Generando factura...');
      pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);
      console.log(`✅ Factura PDF generada (${pdfBuffer.length} bytes)`);
    } catch (err) {
      console.error('❌ Error al crear factura:', err);
      throw err;
    }

    try {
      const nombreArchivo = `facturas/${email}/Factura Laboroteca.pdf`;
      console.log('☁️ → Subiendo a GCS:', nombreArchivo);
      await subirFactura(nombreArchivo, pdfBuffer, {
        email,
        nombreProducto,
        tipoProducto,
        importe
      });
      console.log('✅ Subido a GCS');
    } catch (err) {
      console.error('❌ Error subiendo a GCS:', err);
    }

    try {
      console.log('📧 → Enviando email con factura...');
      const resultado = await enviarFacturaPorEmail(datosCliente, pdfBuffer);
      if (resultado === 'OK') {
        console.log('✅ Email enviado');
      } else {
        console.warn('⚠️ Resultado inesperado del envío de email:', resultado);
      }
    } catch (err) {
      console.error('❌ Error enviando email:', err);
    }

    try {
      console.log('📝 → Registrando en Google Sheets...');
      await guardarEnGoogleSheets(datosCliente);
    } catch (err) {
      console.error('❌ Error en Google Sheets:', err);
    }

    const membership_id = MEMBERPRESS_IDS[claveNormalizada];
    if (tipoProducto.toLowerCase() === 'club' && membership_id) {
      try {
        console.log(`🔓 → Activando membresía CLUB con ID ${membership_id} para ${email}`);
        await activarMembresiaClub(email);
        await syncMemberpressClub({
          email,
          accion: 'activar',
          membership_id,
          importe
        });
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
    try {
      console.log('🧨 Eliminando datos fiscales antiguos de Firestore (si existían)');
      await datosFiscalesRef.delete();
    } catch (err) {
      console.warn('⚠️ No se pudo eliminar el documento previo (puede que no existiera):', err.message || err);
    }

    console.log('🧾 Guardando nuevos datos fiscales en Firestore');
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
    });

    await docRef.update({
      estado: 'finalizado',
      facturaGenerada: true,
      fechaFin: new Date().toISOString()
    });

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
    console.error('❌ Error en procesarCompra:', error);
    throw error;
  }
};
