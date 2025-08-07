require('dotenv').config();
const { generarFacturaPDF } = require('./services/pdf');
const { enviarFacturaPorEmail } = require('./services/email');

const datos = {
  nombre: 'Juan',
  apellidos: 'Pérez',
  dni: '12345678Z',
  email: 'TU_CORREO_REAL@correo.com',
  direccion: 'Calle Mayor, 1',
  cp: '28013',
  ciudad: 'Madrid',
  provincia: 'Madrid',
  producto: 'Libro de prueba',
  importe: 22.90,
};

(async () => {
  try {
    const pdfBuffer = await generarFacturaPDF(datos);
    await enviarFacturaPorEmail(datos, pdfBuffer);
    console.log('✅ PDF generado y email enviado');
  } catch (error) {
    console.error('❌ Error al enviar el email:', error.message);
  }
})();
