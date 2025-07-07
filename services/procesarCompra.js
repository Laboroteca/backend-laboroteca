const admin = require('../firebase');
const firestore = admin.firestore();

const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { guardarEnGoogleSheets } = require('./googleSheets');
const { enviarFacturaPorEmail } = require('./email');
const { subirFactura } = require('./gcs');

module.exports = async function procesarCompra(datos) {
  const compraId = datos.session_id || datos.sessionId ||
    (datos.email_autorelleno || datos.email || '').toLowerCase() + '-' +
    (datos.nombreProducto || 'producto') + '-' +
    (Date.now());

  const docRef = firestore.collection('comprasProcesadas').doc(compraId);
  const docSnap = await docRef.get();

  if (docSnap.exists) {
    console.warn(`⛔️ [procesarCompra] Abortando proceso por duplicado: ${compraId}`);
    return { duplicate: true };
  }

  await docRef.set({
    compraId,
    estado: 'procesando',
    email: datos.email || datos.email_autorelleno || '',
    fechaInicio: new Date().toISOString()
  });

  try {
    const nombre = datos.nombre || datos.Nombre || '';
    const apellidos = datos.apellidos || datos.Apellidos || '';
    let email = (datos.email_autorelleno || datos.email || '').trim().toLowerCase();

    if (!email.includes('@')) {
      const alias = (datos.alias || datos.userAlias || '').trim();
      if (alias) {
        try {
          const userSnap = await firestore.collection('usuariosClub').doc(alias).get();
          if (userSnap.exists) {
            email = (userSnap.data().email || '').trim().toLowerCase();
          }
        } catch (err) {
          console.error(`❌ Error recuperando email por alias "${alias}":`, err);
        }
      }
    }

    if (!email || !email.includes('@')) {
      throw new Error(`❌ Email inválido tras intentos: "${email}"`);
    }

    const dni = datos.dni || '';
    const direccion = datos.direccion || datos['Dirección'] || '';
    const ciudad = datos.ciudad || datos['Municipio'] || '';
    const provincia = datos.provincia || datos['Provincia'] || '';
    const cp = datos.cp || datos['Código postal'] || '';
    const producto = datos.nombreProducto || 'producto_desconocido';
    const descripcionProducto = datos.descripcionProducto || '';
    const tipoProducto = datos.tipoProducto || 'Otro';
    const importe = parseFloat((datos.importe || '22.90').toString().replace(',', '.'));

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
      producto,
      descripcionProducto,
      tipoProducto
    };

    console.time(`🕒 Compra ${email}`);
    console.log('📦 [procesarCompra] Datos facturación finales:\n', JSON.stringify(datosCliente, null, 2));

    // Guardar en Google Sheets
    try {
      console.log('📄 → Guardando en Google Sheets...');
      await guardarEnGoogleSheets({
        ...datosCliente,
        importe: `${importe.toFixed(2)} €`
      });
      console.log('✅ Guardado en Sheets');
    } catch (sheetsErr) {
      console.error('❌ Error guardando en Sheets:', sheetsErr);
    }

    // Crear factura PDF
    let pdfBuffer;
    try {
      console.log('🧾 → Generando factura...');
      pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);
      console.log(`✅ Factura PDF generada (${pdfBuffer.length} bytes)`);
    } catch (err) {
      console.error('❌ Error al crear factura:', err);
      throw err;
    }

    // Subir a GCS
    try {
      const nombreArchivo = `facturas/${email}/Factura Laboroteca.pdf`;
      console.log('☁️ → Subiendo a GCS:', nombreArchivo);
      await subirFactura(nombreArchivo, pdfBuffer, {
        email,
        nombreProducto: producto,
        tipoProducto,
        importe
      });
      console.log('✅ Subido a GCS');
    } catch (err) {
      console.error('❌ Error subiendo a GCS:', err);
    }

    // Enviar email
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

    await docRef.update({
      estado: 'finalizado',
      facturaGenerada: true,
      fechaFin: new Date().toISOString()
    });

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
