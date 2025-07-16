const admin = require('../firebase');
const firestore = admin.firestore();
const crypto = require('crypto');

const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail } = require('./email');
const { subirFactura } = require('./gcs');
const { guardarEnGoogleSheets } = require('./googleSheets');
const { activarMembresiaClub } = require('./activarMembresiaClub');
const { syncMemberpressClub } = require('./syncMemberpressClub');

const MEMBERPRESS_ID_CLUB = 10663;

module.exports = async function procesarCompra(datos) {
  let email = (datos.email_autorelleno || datos.email || '').trim().toLowerCase();
  let nombreProducto = (datos.nombreProducto || 'Producto Laboroteca').trim();
  let descripcionProducto = datos.descripcionProducto || nombreProducto;
  let tipoProducto = datos.tipoProducto || 'Otro';
  let importe = parseFloat((datos.importe || '22,90').toString().replace(',', '.'));

  // 🔍 Buscar email por alias si no es válido
  if (!email.includes('@')) {
    const alias = (datos.alias || datos.userAlias || '').trim();
    if (alias) {
      try {
        const userSnap = await firestore.collection('usuariosClub').doc(alias).get();
        if (userSnap.exists) {
          email = (userSnap.data().email || '').trim().toLowerCase();
          console.log(`📩 Email recuperado por alias (${alias}):`, email);
        }
      } catch (err) {
        console.error(`❌ Error recuperando email por alias "${alias}":`, err);
      }
    }
  }

  if (!email || !email.includes('@')) {
    throw new Error(`❌ Email inválido: "${email}"`);
  }

  // ✅ LOGS ADICIONALES
  console.log('🧪 tipoProducto:', tipoProducto);
  console.log('🧪 nombreProducto:', nombreProducto);

  const claveNormalizada = nombreProducto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\W+/g, '');

  console.log('🔑 Clave normalizada para deduplicación:', claveNormalizada);

  // 🔒 Hash de deduplicación por email + producto + importe
  const hash = crypto.createHash('md5').update(`${email}-${claveNormalizada}-${importe.toFixed(2)}`).digest('hex');
  const compraId = `compra-${hash}`;
  console.log('🧩 Hash generado:', hash);

  const docRef = firestore.collection('comprasProcesadas').doc(compraId);
  const docSnap = await docRef.get();

  if (docSnap.exists) {
    console.warn(`⛔️ [procesarCompra] Compra ya registrada: ${compraId}`);
    return { duplicate: true };
  }

  // ✅ Registrar inicio
  await docRef.set({
    compraId,
    estado: 'procesando',
    email,
    producto: claveNormalizada,
    fechaInicio: new Date().toISOString()
  });

  try {
    // 🔁 Usar datos nuevos si hay, pero preferencia por los de compra inicial
    const nombre = datos.nombre || datos.Nombre || '';
    const apellidos = datos.apellidos || datos.Apellidos || '';
    const dni = datos.dni || '';
    const direccion = datos.direccion || datos['Dirección'] || '';
    const ciudad = datos.ciudad || datos['Municipio'] || '';
    const provincia = datos.provincia || datos['Provincia'] || '';
    const cp = datos.cp || datos['Código postal'] || '';

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
      nombreProducto,
      descripcionProducto,
      tipoProducto
    };

    // 🛡️ Validación extra
    if (!nombre || !apellidos || !dni || !direccion || !ciudad || !provincia || !cp) {
      console.warn(`⚠️ [procesarCompra] Datos incompletos para factura de ${email}`);
    }

    console.time(`🕒 Compra ${email}`);
    console.log('📦 [procesarCompra] Datos facturación finales:\n', JSON.stringify(datosCliente, null, 2));

    // 1. Crear factura
    let pdfBuffer;
    try {
      console.log('🧾 → Generando factura...');
      pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);
      console.log(`✅ Factura PDF generada (${pdfBuffer.length} bytes)`);
    } catch (err) {
      console.error('❌ Error al crear factura:', err);
      throw err;
    }

    // 2. Subida a GCS
    try {
      const nombreArchivo = `facturas/${email}/Factura Laboroteca.pdf`;
      console.log('☁️ → Subiendo a GCS:', nombreArchivo);
      await subirFactura(nombreArchivo, pdfBuffer, {
        email,
        nombreProducto,
        tipoProducto,
        importe
      });
      console.log('✅ Subido a GCS');
    } catch (err) {
      console.error('❌ Error subiendo a GCS:', err);
    }

    // 3. Email con factura
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

    // 4. Registro en Sheets
    try {
      console.log('📝 → Registrando en Google Sheets...');
      await guardarEnGoogleSheets(datosCliente);
    } catch (err) {
      console.error('❌ Error en Google Sheets:', err);
    }

    // 5. Activación Club
    if (claveNormalizada.includes('clublaboroteca')) {
      try {
        console.log('🔓 → Activando membresía del Club...');
        await activarMembresiaClub(email);
        await syncMemberpressClub({
          email,
          accion: 'activar',
          membership_id: MEMBERPRESS_ID_CLUB,
          importe
        });
        console.log('✅ Membresía activada correctamente');
      } catch (err) {
        console.error('❌ Error activando membresía del Club:', err.message || err);
      }
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

