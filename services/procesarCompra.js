const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { guardarEnGoogleSheets } = require('./googleSheets');
const { enviarFacturaPorEmail } = require('./email');
const { subirFactura } = require('./gcs');

module.exports = async function procesarCompra(datos) {
  try {
    const nombre = datos.nombre || datos.Nombre || '';
    const apellidos = datos.apellidos || datos.Apellidos || '';
    const email = datos.email || '';
    const dni = datos.dni || '';
    const direccion = datos.direccion || datos['Dirección'] || '';
    const ciudad = datos.ciudad || datos['Municipio'] || '';
    const provincia = datos.provincia || datos['Provincia'] || '';
    const cp = datos.cp || datos['Código postal'] || '';
    const producto = datos.nombreProducto || 'producto_desconocido';
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
      tipoProducto
    };

    console.log('📦 Datos finales de facturación:\n', JSON.stringify(datosCliente, null, 2));

    // 1. Guardar en Google Sheets
    console.log('📄 → Guardando en Google Sheets...');
    await guardarEnGoogleSheets(datosCliente);
    console.log('✅ Guardado en Sheets');

    // 2. Generar factura en PDF (vía FacturaCity)
    console.log('🧾 → Generando factura...');
    const pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);
    console.log(`✅ Factura PDF generada (${pdfBuffer.length} bytes)`);

    // 3. Subir a Google Cloud Storage
    const nombreArchivo = `facturas/${email}/${Date.now()}-${producto}.pdf`;
    console.log('☁️ → Subiendo a GCS:', nombreArchivo);
    await subirFactura(nombreArchivo, pdfBuffer, {
      email,
      nombreProducto: producto,
      tipoProducto,
      importe
    });
    console.log('✅ Subido a GCS');

    // 4. Enviar por email
    console.log('📧 → Enviando email con la factura...');
    await enviarFacturaPorEmail(datosCliente, pdfBuffer);
    console.log('✅ Email enviado');

    console.log(`✅ Compra procesada con éxito para ${nombre} ${apellidos}`);
  } catch (error) {
    console.error('❌ Error en procesarCompra:', error);
    throw error;
  }
};
