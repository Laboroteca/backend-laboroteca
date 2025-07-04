const admin = require('../firebase');
const firestore = admin.firestore();

const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { guardarEnGoogleSheets } = require('./googleSheets');
const { enviarFacturaPorEmail } = require('./email');
const { subirFactura } = require('./gcs');

module.exports = async function procesarCompra(datos) {
  try {
    const nombre = datos.nombre || datos.Nombre || '';
    const apellidos = datos.apellidos || datos.Apellidos || '';
    let email = datos.email_autorelleno || datos.email || '';
    const dni = datos.dni || '';
    const direccion = datos.direccion || datos['Dirección'] || '';
    const ciudad = datos.ciudad || datos['Municipio'] || '';
    const provincia = datos.provincia || datos['Provincia'] || '';
    const cp = datos.cp || datos['Código postal'] || '';
    const producto = datos.nombreProducto || 'producto_desconocido';
    const descripcionProducto = datos.descripcionProducto || '';
    const tipoProducto = datos.tipoProducto || 'Otro';
    const importe = parseFloat((datos.importe || '22.90').toString().replace(',', '.'));

    // 🛡️ Verificación del email y recuperación si es inválido
    if (!email.includes('@')) {
      const alias = datos.alias || datos.userAlias || '';
      if (alias) {
        const userSnap = await firestore.collection('usuariosClub').doc(alias).get();
        if (userSnap.exists) {
          email = userSnap.data().email || '';
          console.log(`📩 Email recuperado desde Firestore para alias ${alias}: ${email}`);
        }
      }
    }

    if (!email || !email.includes('@')) {
      throw new Error(`❌ Email inválido en procesarCompra: "${email}"`);
    }

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
    console.log('📦 Datos finales de facturación:\n', JSON.stringify(datosCliente, null, 2));

    // Guardar en Sheets
    try {
      console.log('📄 → Guardando en Google Sheets...');
      await guardarEnGoogleSheets(datosCliente);
      console.log('✅ Guardado en Sheets');
    } catch (sheetsErr) {
      console.error('❌ Error guardando en Google Sheets:', sheetsErr);
    }

    // Generar factura
    let pdfBuffer;
    try {
      console.log('🧾 → Generando factura...');
      pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);
      console.log(`✅ Factura PDF generada (${pdfBuffer.length} bytes)`);
    } catch (facturaErr) {
      console.error('❌ Error generando la factura:', facturaErr);
      throw facturaErr;
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
    } catch (gcsErr) {
      console.error('❌ Error subiendo a GCS:', gcsErr);
    }

    // Enviar email con la factura
    try {
      console.log('📧 → Enviando email con la factura...');
      const resultado = await enviarFacturaPorEmail(datosCliente, pdfBuffer);
      if (resultado === 'OK') {
        console.log('✅ Email enviado');
      } else {
        console.warn('⚠️ Email enviado pero respuesta inesperada:', resultado);
      }
    } catch (emailErr) {
      console.error('❌ Error enviando email:', emailErr);
    }

    console.log(`✅ Compra procesada con éxito para ${nombre} ${apellidos}`);
    console.timeEnd(`🕒 Compra ${email}`);
  } catch (error) {
    console.error('❌ Error en procesarCompra:', error);
    throw error;
  }
};
