const { crearFactura } = require('./services/facturaService');
const { descargarPdfComoBuffer } = require('./services/descargarPdf');
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
  importe: 22.90,
};

(async () => {
  try {
    // 1. Crear factura en FacturaCity
    const factura = await crearFactura(datos);

    // 2. Obtener la URL del PDF oficial
    const pdfBuffer = await descargarPdfComoBuffer(factura.pdf_url); // ← asegúrate que ese campo existe

    // 3. Enviar email con el PDF de FacturaCity
    await enviarFacturaPorEmail(datos, pdfBuffer);

    console.log('✅ Factura oficial enviada por email.');
  } catch (error) {
    console.error('❌ Error en el envío:', error.message);
  }
})();
