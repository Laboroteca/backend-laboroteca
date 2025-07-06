const admin = require('../firebase');
const firestore = admin.firestore();

const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { guardarEnGoogleSheets } = require('./googleSheets');
const { enviarFacturaPorEmail } = require('./email');
const { subirFactura } = require('./gcs');

module.exports = async function procesarCompra(datos) {
  // Generar ID único para la compra: preferiblemente session_id de Stripe, si no fallback
  const compraId = datos.session_id || datos.sessionId ||
    (datos.email_autorelleno || datos.email || '').toLowerCase() + '-' +
    (datos.nombreProducto || 'producto') + '-' +
    (Date.now());

  const docRef = firestore.collection('comprasProcesadas').doc(compraId);

  // Abortamos si ya está procesado (idempotencia estricta)
  const docSnap = await docRef.get();
  if (docSnap.exists) {
    console.warn(`⛔️ [procesarCompra] Abortando proceso por duplicado: ${compraId}`);
    return { duplicate: true };
  }

  // Marcamos como procesando para bloquear otras ejecuciones concurrentes
  await docRef.set({
    compraId,
    estado: 'procesando',
    email: datos.email || datos.email_autorelleno || '',
    fechaInicio: new Date().toISOString()
  });

  try {
    const nombre = datos.nombre || datos.Nombre || '';
    const apellidos = datos.apellidos || datos.Apellidos || '';
    console.log('🚦 [procesarCompra] Datos recibidos:', {
      email_autorelleno: datos.email_autorelleno,
      email: datos.email,
      alias: datos.alias || datos.userAlias || ''
    });

    let email = (datos.email_autorelleno || datos.email || '').trim().toLowerCase();

    // Si email inválido, intentamos recuperar por alias en Firestore
    if (!email.includes('@')) {
      const alias = (datos.alias || datos.userAlias || '').trim();
      if (alias) {
        try {
          const userSnap = await firestore.collection('usuariosClub').doc(alias).get();
          if (userSnap.exists) {
            email = (userSnap.data().email || '').trim().toLowerCase();
            console.log(`📩 [procesarCompra] Email recuperado por alias "${alias}": ${email}`);
          }
        } catch (err) {
          console.error(`❌ [procesarCompra] Error accediendo a Firestore para alias "${alias}":`, err);
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

    // Guardar en Google Sheets (intento controlado)
    try {
      console.log('📄 → Guardando en Google Sheets...');
      await guardarEnGoogleSheets(datosCliente);
      console.log('✅ Guardado en Sheets');
    } catch (sheetsErr) {
      console.error('❌ Error guardando en Google Sheets:', sheetsErr);
    }

    // Generar factura PDF
    let pdfBuffer;
    try {
      console.log('🧾 → Generando factura...');
      pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);
      console.log(`✅ Factura PDF generada (${pdfBuffer.length} bytes)`);
    } catch (facturaErr) {
      console.error('❌ Error generando factura:', facturaErr);
      throw facturaErr;
    }

    // Subir PDF a Google Cloud Storage
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
    } catch (gcsErr) {
      console.error('❌ Error subiendo a GCS:', gcsErr);
    }

    // Enviar email con factura (manejo error controlado)
    try {
      console.log('📧 → Enviando email con factura...');
      const resultado = await enviarFacturaPorEmail(datosCliente, pdfBuffer);
      if (resultado === 'OK') {
        console.log('✅ Email enviado');
      } else {
        console.warn('⚠️ Email enviado con respuesta inesperada:', resultado);
      }
    } catch (emailErr) {
      console.error('❌ Error enviando email:', emailErr);
    }

    // Marcamos como finalizado con éxito
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
