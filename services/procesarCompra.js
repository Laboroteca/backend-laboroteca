const generarPDF = require('./pdf');
const subirFacturaGCS = require('./gcs');
const registrarEnSheets = require('./googleSheets');
const enviarEmail = require('./email');

module.exports = async function procesarCompra(datos) {
  try {
    const {
      names: { Nombre, Apellidos },
      email,
      dni,
      address_1: {
        Dirección: direccion,
        Municipio: ciudad,
        Provincia: provincia,
        'Código postal': cp
      },
      'Membresía Libro "De cara a la jubilación" (Acceso vitalicio)': tipoProducto = 'Libro',
    } = datos;

    const nombreCompleto = `${Nombre} ${Apellidos}`;
    const fecha = new Date().toLocaleDateString('es-ES');
    const producto = 'Libro "De cara a la jubilación"';
    const importe = '22,90 €';

    // 1. Generar PDF de factura
    const facturaBuffer = await generarPDF({
      nombreCompleto,
      email,
      dni,
      direccion,
      ciudad,
      provincia,
      cp,
      producto,
      importe,
      fecha,
    });

    // 2. Subir a Google Cloud Storage
    const nombreArchivo = `${dni}_${Date.now()}.pdf`;
    const urlDescarga = await subirFacturaGCS(nombreArchivo, facturaBuffer);

    // 3. Registrar en Google Sheets
    await registrarEnSheets({
      Nombre: Nombre,
      Apellidos: Apellidos,
      DNI: dni,
      Importe: importe,
      Fecha: fecha,
      Email: email,
      Dirección: direccion,
      Ciudad: ciudad,
      CP: cp,
      Provincia: provincia,
    });

    // 4. Enviar email al cliente con factura
    await enviarEmail({
      to: email,
      subject: '✅ Confirmación de compra en Laboroteca',
      text: `Hola ${Nombre}, adjuntamos la factura de tu compra del libro.`,
      attachments: [
        {
          filename: 'Factura-Laboroteca.pdf',
          content: facturaBuffer,
        },
      ],
    });

    console.log(`✅ Compra procesada con éxito para ${nombreCompleto}`);
  } catch (error) {
    console.error('❌ Error al procesar la compra:', error);
    throw error; // Para que el controlador lo capture y devuelva 500
  }
};
