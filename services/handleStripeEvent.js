const admin = require('../firebase');
const firestore = admin.firestore();

const { guardarEnGoogleSheets } = require('./googleSheets');
const { crearFacturaEnFacturaCity } = require('./facturaCity');
const { enviarFacturaPorEmail } = require('./email');
const { subirFactura } = require('./gcs');
const { activarMembresiaClub } = require('./activarMembresiaClub');
const { syncMemberpressClub } = require('./syncMemberpressClub');
const { syncMemberpressLibro } = require('./syncMemberpressLibro');
const fs = require('fs').promises;
const path = require('path');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const RUTA_CUPONES = path.join(__dirname, '../data/cupones.json');

// 🔤 Normalizador universal: elimina tildes, guiones, minúsculas y espacios extra
function normalizarProducto(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\-]+/g, ' ')
    .trim();
}

const MEMBERPRESS_IDS = {
  'el club laboroteca': 10663,
  'de cara a la jubilacion': 7994
};

async function handleStripeEvent(event) {
  const type = event.type;

  if (type === 'checkout.session.completed') {
    const session = event.data.object;
    const sessionId = session.id;
    if (session.payment_status !== 'paid') return { ignored: true };

    const docRef = firestore.collection('comprasProcesadas').doc(sessionId);
    const procesado = await firestore.runTransaction(async (transaction) => {
      const doc = await transaction.get(docRef);
      if (doc.exists) return true;
      transaction.set(docRef, {
        sessionId,
        email: '',
        producto: '',
        fecha: new Date().toISOString(),
        procesando: true,
        error: false,
        facturaGenerada: false
      });
      return false;
    });
    if (procesado) return { duplicate: true };

    const m = session.metadata || {};
    console.log('🧐 Stripe session.metadata:', m);

    // Priorizamos email_autorelleno y validamos siempre
    let email = (
      (m.email_autorelleno && typeof m.email_autorelleno === 'string' && m.email_autorelleno.includes('@') && m.email_autorelleno) ||
      (m.email && typeof m.email === 'string' && m.email.includes('@') && m.email) ||
      (session.customer_details?.email && typeof session.customer_details.email === 'string' && session.customer_details.email.includes('@') && session.customer_details.email) ||
      (session.customer_email && typeof session.customer_email === 'string' && session.customer_email.includes('@') && session.customer_email)
    )?.toLowerCase().trim();

    if (!email) {
      console.error('❌ No se pudo obtener un email válido en checkout.session.completed');
      await docRef.update({
        error: true,
        errorMsg: 'Email inválido o ausente en Stripe session'
      });
      return { error: 'Email inválido' };
    }

    const name = session.customer_details?.name || `${m.nombre || ''} ${m.apellidos || ''}`.trim();
    const amountTotal = session.amount_total || 0;

    // --- Normaliza nombre de producto para MemberPress (¡SIN TILDES NI GUIONES!)
    const rawNombreProducto = (m.nombreProducto || '').toLowerCase().trim();
    const productoSlug = normalizarProducto(rawNombreProducto);
    const memberpressId = MEMBERPRESS_IDS[productoSlug];

    console.log('🧩 Producto detectado:', {
      rawNombreProducto,
      productoSlug,
      memberpressId
    });

    const datosCliente = {
      nombre: m.nombre || name,
      apellidos: m.apellidos || '',
      dni: m.dni || '',
      email,
      direccion: m.direccion || '',
      ciudad: m.ciudad || '',
      provincia: m.provincia || '',
      cp: m.cp || '',
      importe: parseFloat((amountTotal / 100).toFixed(2)),
      tipoProducto: m.tipoProducto || 'Otro',
      nombreProducto: productoSlug,
      descripcionProducto: m.descripcionProducto || m.nombreProducto || 'producto_desconocido',
      producto: m.descripcionProducto || m.nombreProducto || 'producto_desconocido'
    };

    let errorProcesando = false;

    try {
      await guardarEnGoogleSheets(datosCliente);
      const pdfBuffer = await crearFacturaEnFacturaCity(datosCliente);

      const nombreArchivo = `facturas/${email}/${Date.now()}-${datosCliente.producto}.pdf`;
      await subirFactura(nombreArchivo, pdfBuffer, {
        email,
        nombreProducto: datosCliente.producto,
        tipoProducto: datosCliente.tipoProducto,
        importe: datosCliente.importe
      });

      try {
        await enviarFacturaPorEmail(datosCliente, pdfBuffer);
      } catch (err) {
        console.error('❌ Error enviando email con factura:', err?.message);
      }

      // --- LOG justo antes de activar membresía Club
      if (memberpressId === 10663) {
        console.log('🟦 Activando membresía CLUB para:', email, 'ID:', memberpressId);
        await syncMemberpressClub({
          email,
          accion: 'activar',
          membership_id: memberpressId,
          importe: datosCliente.importe
        });
        await activarMembresiaClub(email);
        console.log('✅ Club Laboroteca ACTIVADO en MemberPress y Firestore para', email);
      }

      // --- LOG justo antes de activar membresía Libro (solo si fue subscription)
      if (memberpressId === 7994) {
        console.log('🟨 Activando membresía LIBRO para:', email, 'ID:', memberpressId);
        if ((session.mode || '').toLowerCase() === 'subscription') {
          const resultLibro = await syncMemberpressLibro({
            email,
            accion: 'activar',
            membership_id: memberpressId,
            importe: datosCliente.importe
          });
          console.log('📗 Respuesta MemberPressLibro:', resultLibro);
        } else {
          console.log('🟨 No se crea suscripción periódica para el LIBRO (modo pago único).');
        }
      }

      // --- LOG si no detecta ningún producto
      if (!memberpressId) {
        console.log('🟥 No se detecta MemberPress ID para este producto:', productoSlug, rawNombreProducto);
      }

      // Marcar cupón como usado (si existe)
      if (m.codigoDescuento) {
        try {
          const raw = await fs.readFile(RUTA_CUPONES, 'utf8');
          const cupones = JSON.parse(raw);
          const index = cupones.findIndex(c => c.codigo === m.codigoDescuento && !c.usado);
          if (index !== -1) {
            cupones[index].usado = true;
            await fs.writeFile(RUTA_CUPONES, JSON.stringify(cupones, null, 2));
          }
        } catch (err) {
          console.error('❌ Error marcando cupón como usado:', err?.message);
        }
      }
    } catch (error) {
      errorProcesando = true;
      console.error('❌ Error en flujo checkout.session.completed:', error?.message);
      await docRef.update({
        error: true,
        errorMsg: error?.message || error
      });
      throw error;
    } finally {
      await docRef.update({
        email,
        producto: datosCliente.producto,
        fecha: new Date().toISOString(),
        procesando: false,
        facturaGenerada: !errorProcesando,
        error: !!errorProcesando
      });
    }

    return { success: true };
  }

  return { ignored: true };
}

module.exports = handleStripeEvent;
