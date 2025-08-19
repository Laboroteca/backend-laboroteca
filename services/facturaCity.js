const axios = require('axios');
const qs = require('qs');
require('dotenv').config();

const FACTURACITY_API_KEY = process.env.FACTURACITY_API_KEY?.trim().replace(/"/g, '');
const API_BASE = process.env.FACTURACITY_API_URL;

function obtenerFechaHoy() {
  const hoy = new Date();
  const dd = String(hoy.getDate()).padStart(2, '0');
  const mm = String(hoy.getMonth() + 1).padStart(2, '0');
  const yyyy = hoy.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

const { ensureOnce } = require('../utils/dedupe');

const AXIOS_TIMEOUT = 10000; // 10s razonable
const fcHeaders = { Token: FACTURACITY_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' };

// ───────── Firestore (registro de facturas) ─────────
const admin = require('../firebase');
const firestore = admin.firestore();

function pickNumeroFactura(doc) {
  return (
    doc?.numfactura ||
    doc?.numero ||
    doc?.numFactura ||
    doc?.codigo ||
    doc?.codigoFactura ||
    null
  );
}

function pickFechaFactura(doc) {
  // intenta extraer fecha de la respuesta de FacturaCity; si no, usa "hoy"
  const raw = doc?.fechafactura || doc?.fecha || null;
  if (typeof raw === 'string') {
    // admite "dd/mm/aaaa" o "aaaa-mm-dd" o "dd-mm-aaaa"
    const m1 = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m1) {
      const [_, dd, mm, yyyy] = m1;
      const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
      return {
        iso: d.toISOString(),
        texto: `${dd}/${mm}/${yyyy}`
      };
    }
    const m2 = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m2) {
      const [_, yyyy, mm, dd] = m2;
      const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
      return {
        iso: d.toISOString(),
        texto: `${dd}/${mm}/${yyyy}`
      };
    }
    const m3 = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (m3) {
      const [_, dd, mm, yyyy] = m3;
      const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
      return {
        iso: d.toISOString(),
        texto: `${dd}/${mm}/${yyyy}`
      };
    }
  }
  // fallback: hoy
  const hoy = new Date();
  const dd = String(hoy.getDate()).padStart(2, '0');
  const mm = String(hoy.getMonth() + 1).padStart(2, '0');
  const yyyy = hoy.getFullYear();
  return { iso: hoy.toISOString(), texto: `${dd}/${mm}/${yyyy}` };
}

async function registrarFacturaEnFirestore(payload) {
  try {
    // ── ID del documento robusto ──
    const docId =
      payload.invoiceId
        ? `inv_${payload.invoiceId}`
        : payload.idfactura
          ? `fc_${payload.idfactura}`
          : `tmp_${Date.now()}`;

    // ── Normalización de fecha ──
    const fechaObj = pickFechaFactura(payload);

    // ── Escritura en colección 'facturas' ──
    await firestore.collection('facturas').doc(docId).set({
      // Claves fuertes
      invoiceId: payload.invoiceId || null,
      idfactura: payload.idfactura || null,
      numeroFactura: payload.numeroFactura || null,

      // Datos de control
      email: payload.email || null,
      tipo: payload.tipo || null, // alta o renovacion
      fechaISO: fechaObj.iso,
      fechaTexto: fechaObj.texto,

      // Descripción e importes
      descripcionProducto: payload.descripcionProducto || null,
      importeTotalIVA: payload.importeTotalIVA ?? null,
      moneda: payload.moneda || 'EUR',

      // Timestamp de inserción
      insertadoEn: new Date().toISOString()
    }, { merge: true });
  } catch (e) {
    console.error('❌ Error al registrar factura en Firestore:', e);
    // no romper el flujo, solo loguear
  }
}


// Trunca a 4 decimales sin redondear (hacia abajo)
function trunc4(n) {
  return Math.floor(n * 10000) / 10000; // 4 decimales exactos
}

async function crearFacturaEnFacturaCity(datosCliente) {
  try {
    // ✅ Kill-switch de duplicados FacturaCity
   if (datosCliente.invoiceId) {
      const first = await ensureOnce('facturasGeneradas', datosCliente.invoiceId);
      if (!first) {
        console.warn(`🟡 Duplicado invoiceId=${datosCliente.invoiceId} ignorado en crearFacturaEnFacturaCity`);
        return null;
      }
    }

    const maskedKey = FACTURACITY_API_KEY ? FACTURACITY_API_KEY.slice(-4).padStart(8, '•') : '(no definida)';
    console.log('🔐 API KEY utilizada (mascarada):', maskedKey);

    if (!API_BASE) {
      throw new Error('FACTURACITY_API_URL no está definida');
    }
    if (!FACTURACITY_API_KEY) {
      throw new Error('FACTURACITY_API_KEY no está definida');
    }


    console.log('🌐 API URL utilizada:', API_BASE);
    console.log('🧾 Datos del cliente recibidos para facturar:', JSON.stringify(datosCliente, null, 2));

    // PVP CON IVA recibido
    const totalConIVA = Number.parseFloat(String(datosCliente.importe).replace(',', '.'));
    if (!totalConIVA || Number.isNaN(totalConIVA)) {
      throw new Error(`❌ El importe recibido no es válido: "${datosCliente.importe}"`);
    }

    // === CALCULAR BASE IMPONIBLE TRUNCADA A 4 DECIMALES (sin redondeo) ===
    const baseTotal = trunc4(totalConIVA / 1.21); // Mantener 4 decimales
    console.log('💶 Base imponible (truncada):', baseTotal.toFixed(4), '→ Total con IVA:', totalConIVA.toFixed(2));

    // ===== Cliente =====
    const cliente = {
      nombre: `${datosCliente.nombre} ${datosCliente.apellidos}`,
      razonsocial: `${datosCliente.nombre} ${datosCliente.apellidos}`,
      personafisica: '1',
      tipoidfiscal: 'NIF',
      cifnif: datosCliente.dni,
      direccion: datosCliente.direccion || 'Dirección no facilitada',
      codpostal: datosCliente.cp || '',
      ciudad: datosCliente.ciudad || '',
      provincia: datosCliente.provincia || '',
      pais: 'ES',
      email: datosCliente.email,
      regimeniva: 'General'
    };

    const clienteResp = await axios.post(`${API_BASE}/clientes`, qs.stringify(cliente), {
      headers: fcHeaders,
      timeout: AXIOS_TIMEOUT
    });

    const codcliente = clienteResp.data?.data?.codcliente;
    if (!codcliente) throw new Error('❌ No se pudo obtener codcliente');
    console.log(`✅ Cliente creado en FacturaCity codcliente=${codcliente} email=${datosCliente.email}`);

    // 🏠 Dirección fiscal (opcional)
    try {
      const direccionFiscal = {
        codcliente,
        descripcion: `${datosCliente.nombre} ${datosCliente.apellidos}`,
        direccion: datosCliente.direccion || '',
        codpostal: datosCliente.cp || '',
        ciudad: datosCliente.ciudad || '',
        provincia: datosCliente.provincia || '',
        pais: 'España',
        nombre: datosCliente.nombre,
        apellidos: datosCliente.apellidos,
        email: datosCliente.email
      };
      await axios.post(`${API_BASE}/direccionescliente`, qs.stringify(direccionFiscal), {
        headers: fcHeaders,
        timeout: AXIOS_TIMEOUT
      });

      console.log(`🏠 Dirección fiscal añadida para codcliente=${codcliente} email=${datosCliente.email}`);
    } catch (err) {
      console.warn('⚠️ No se pudo añadir dirección fiscal:', err.message);
    }

    // ===== Referencia/Descripción =====
    const descripcion = datosCliente.descripcionProducto || datosCliente.descripcion || datosCliente.producto;
    let referencia = 'OTRO001';
    const tp = (datosCliente.tipoProducto || '').toLowerCase();
    const nombreNorm = (datosCliente.nombreProducto || '').toLowerCase().replace(/\s+/g,' ').trim();
    const esClub = /club laboroteca/.test(nombreNorm) || tp === 'club';
    if (esClub) referencia = 'CLUB001';
    else if (tp === 'libro') referencia = 'LIBRO001';
    else if (tp === 'curso') referencia = 'CURSO001';
    else if (tp === 'guia') referencia = 'GUIA001';


    // ===== Cantidad y PRECIO UNITARIO BASE (sin IVA) =====
    const esEntrada = tp === 'entrada';
    let cantidad = esEntrada ? parseInt(datosCliente.totalAsistentes || '1', 10) : 1;
    if (!Number.isFinite(cantidad) || cantidad < 1) cantidad = 1;

    // Base unitario = baseTotal / cantidad, TRUNCADO a 4 decimales (no redondear)
    const pvpUnitarioBase = trunc4(baseTotal / cantidad).toFixed(4);

    // === Línea SIN incluyeiva (0) para que FacturaCity calcule total exacto desde la base truncada ===
    const lineas = [
      {
        referencia,
        descripcion,
        cantidad: parseInt(cantidad, 10), // 👈 Forzamos número entero (sin decimales)
        pvpunitario: pvpUnitarioBase,     // BASE imponible por unidad
        codimpuesto: 'IVA21',
        incluyeiva: '0'                   // 👈 Indicamos que el pvpunitario NO incluye IVA
      }
    ];


    // ===== Cabecera factura =====
    const factura = {
      codcliente,
      lineas: JSON.stringify(lineas),
      pagada: 1,
      fecha: obtenerFechaHoy(),
      codserie: 'A',
      nombrecliente: `${datosCliente.nombre} ${datosCliente.apellidos}`,
      cifnif: datosCliente.dni,
      direccion: datosCliente.direccion || '',
      ciudad: datosCliente.ciudad || '',
      provincia: datosCliente.provincia || '',
      codpostal: datosCliente.cp || ''
    };

    const facturaResp = await axios.post(`${API_BASE}/crearFacturaCliente`, qs.stringify(factura), {
      headers: fcHeaders,
      timeout: AXIOS_TIMEOUT
    });


    console.log('📩 Respuesta completa de crearFacturaCliente:', JSON.stringify(facturaResp.data, null, 2));

    const idfactura = facturaResp.data?.doc?.idfactura;
    if (!idfactura) throw new Error('❌ No se recibió idfactura');
    console.log(`✅ Factura emitida idfactura=${idfactura} invoiceId=${datosCliente.invoiceId || 'N/A'} email=${datosCliente.email}`);


    // Nº de factura (legible si lo devuelve la API) y fecha
    const numeroFactura = pickNumeroFactura(facturaResp.data?.doc) || String(idfactura);
    const { iso: fechaISO, texto: fechaTexto } = pickFechaFactura(facturaResp.data?.doc);

    // Registrar en Firestore (NO BLOQUEA)
    await registrarFacturaEnFirestore({
      invoiceId: datosCliente.invoiceId || null,
      idfactura,
      numeroFactura,

      email: datosCliente.email,
      nombre: datosCliente.nombre,
      apellidos: datosCliente.apellidos,
      dni: datosCliente.dni,

      fechaISO,
      fechaTexto,

      descripcionProducto: (datosCliente.descripcionProducto || datosCliente.descripcion || datosCliente.producto || '').trim(),
      nombreProducto: datosCliente.nombreProducto || null,
      tipoProducto: datosCliente.tipoProducto || null,
      importeTotalIVA: Number.parseFloat(String(datosCliente.importe).replace(',', '.')),
      importeBase: Number(baseTotal.toFixed(4)),  // ya lo calculas arriba
      cantidad,                                   // ya calculada arriba
      referencia,                                 // ya calculada arriba
    });


    const pdfUrl = `${API_BASE}/exportarFacturaCliente/${idfactura}?lang=es_ES`;
    const pdfResponse = await axios.get(pdfUrl, {
      headers: { Token: FACTURACITY_API_KEY },
      responseType: 'arraybuffer',
      timeout: AXIOS_TIMEOUT
    });


    const pdfSize = pdfResponse.data?.length || 0;
    console.log(`📦 PDF generado (${pdfSize} bytes)`);

    return pdfResponse.data;
  } catch (error) {
   if (error.response) {
      console.error(`⛔ Error FacturaCity invoiceId=${datosCliente.invoiceId || 'N/A'} email=${datosCliente.email}`);
      console.error('🔢 Status:', error.response.status);
      console.error('📦 Data:', error.response.data);
    } else {
      console.error(`⛔ Error FacturaCity sin respuesta invoiceId=${datosCliente.invoiceId || 'N/A'} email=${datosCliente.email} → ${error.message}`);
    }

    // 📝 Registrar fallo en Sheets y GCS aunque no haya factura
    try {
      const { guardarEnGoogleSheets } = require('./googleSheets');
      const { subirFactura } = require('./gcs');
      const fakePdf = Buffer.from(`Factura NO generada. Error: ${error.message}`, 'utf-8');

      await guardarEnGoogleSheets({
        ...datosCliente,
        estadoFactura: 'ERROR',
        error: error.message
      });

      await subirFactura(`fallo-factura-${datosCliente.invoiceId || Date.now()}.txt`, fakePdf);
      console.warn('⚠️ Fallo de facturación registrado en Sheets y GCS');
    } catch (logErr) {
      console.error('⛔ No se pudo registrar el fallo en Sheets/GCS:', logErr.message);
    }

    throw new Error('Error al generar la factura');
  }
}

module.exports = { crearFacturaEnFacturaCity };
