const admin = require('../firebase');
const firestore = admin.firestore();
const crypto = require('crypto');

const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail } = require('./email');
const { subirFactura } = require('./gcs');
const { guardarEnGoogleSheets } = require('./googleSheets');

// 🔧 Normalización consistente
function normalizarProducto(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .replace(/suscripcion mensual a el club laboroteca.*$/i, 'club laboroteca')
    .replace(/suscripcion mensual al club laboroteca.*$/i, 'club laboroteca')
    .replace(/el club laboroteca.*$/i, 'club laboroteca')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

module.exports = async function procesarCompra(datos) {
  let email = (datos.email_autorelleno || datos.email || '').trim().toLowerCase();
  let rawProducto = (datos.nombreProducto || 'producto').trim();

  // 🧮 Importe en coma o punto
  let importe = parseFloat((datos.importe || '22,90').toString().replace(',', '.'));

  // 💡 Si es 4,99€ asumimos que es el Club y forzamos nombre estándar
  if (importe === 4.99) {
    rawProducto = 'el club laboroteca';
  }

  const producto = normalizarProducto(rawProducto);

  // ID único por email + producto
  const hash = crypto.createHash('md5').update(`${email}-${producto}`).digest('hex');
  const compraId = `compra-${hash}`;

  const docRef = firestore.collection('comprasProcesadas').doc(compraId);
  const docSnap = await docRef.get();

  const descripcionProducto = datos.descripcionProducto || rawProducto || 'Producto Laboroteca';
  const tipoProducto = datos.tipoProducto || '';
  const nombreProducto = datos.nombreProducto || '';
  const key = normalizarProducto(tipoProducto || nombreProducto);
  const productoInfo = {
  tipoProducto,
  nombreProducto,
  key,
};

console.log('🧪 tipoProducto:', tipoProducto);
console.log('🧪 nombreProducto:', nombreProducto);
console.log('🔑 key normalizado:', key);
const producto = PRODUCTOS[key];
console.log('📦 producto encontrado:', !!producto);



  if (docSnap.exists) {
    console.warn(`⛔️ [procesarCompra] Abortando proceso por duplicado: ${compraId}`);
    return { duplicate: true };
  }

  await docRef.set({
    compraId,
    estado: 'procesando',
    email,
    fechaInicio: new Date().toISOString()
  });

  try {
    const nombre = datos.nombre || datos.Nombre || '';
    const apellidos = datos.apellidos || datos.Apellidos || '';

    // 🔍 Buscar email por alias si no es válido
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

    // 📝 Descripción real del producto
    const descripcionProducto = datos.descripcionProducto || rawProducto || 'Producto Laboroteca';
    const tipoProducto = datos.tipoProducto || 'Otro';

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
      nombreProducto: rawProducto,
      descripcionProducto,
      tipoProducto
    };

    console.time(`🕒 Compra ${email}`);
    console.log('📦 [procesarCompra] Datos facturación finales:\n', JSON.stringify(datosCliente, null, 2));

    // 1. Crear factura PDF
    let pdfBuffer;
    try {
      console.log('🧾 → Generando factura...');
      pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);
      console.log(`✅ Factura PDF generada (${pdfBuffer.length} bytes)`);
    } catch (err) {
      console.error('❌ Error al crear factura:', err);
      throw err;
    }

    // 2. Subir a GCS
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

    // 3. Enviar email con factura
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

    // 4. Registrar en Google Sheets (evita duplicados internamente)
    try {
      console.log('📝 → Registrando en Google Sheets...');
      await guardarEnGoogleSheets(datosCliente);
    } catch (err) {
      console.error('❌ Error al registrar en Google Sheets:', err);
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
