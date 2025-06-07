require('dotenv').config();

const { crearFacturaEnFacturaCity } = require('./services/facturaCity');
const { enviarFacturaPorEmail } = require('./services/email');

const datos = {
  nombre: 'Juan',
  apellidos: 'Pérez',
  dni: '12345678Z',
  email: 'ignacio.solsona@icacs.com',
  direccion: 'Calle Mayor, 1',
  cp: '28013',
  ciudad: 'Madrid',
  provincia: 'Madrid',
  producto: 'Libro de prueba',
  descripcionProducto: 'Libro de prueba (membresía vitalicia - edición digital)', // ✅ Añadido
  importe: 22.90
};

(async () => {
  try {
    console.log('📤 Generando factura con los siguientes datos:');
    console.log(JSON.stringify(datos, null, 2));

    const pdfBuffer = await crearFacturaEnFacturaCity(datos);
    console.log('✅ Factura generada. Tamaño del PDF:', pdfBuffer.length);

    await enviarFacturaPorEmail(
      {
        ...datos,
        bcc: 'ignacio.laboroteca@gmail.com'
      },
      pdfBuffer
    );

    console.log('✅ Email enviado correctamente');
  } catch (error) {
    console.error('❌ Error durante el proceso:', error);
  }
})();
