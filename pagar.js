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
  importe: 22.90
};

(async () => {
  try {
    const pdfBuffer = await crearFacturaEnFacturaCity(datos);

    await enviarFacturaPorEmail({
      ...datos,
      bcc: 'ignacio.laboroteca@gmail.com' // opcional
    }, pdfBuffer);

    console.log('✅ Factura oficial enviada por email');
  } catch (error) {
    console.error('❌ Error al procesar el pago:', error.message);
  }
})();
