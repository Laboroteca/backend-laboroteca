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

    console.log('🔐 API KEY utilizada:', `"${FACTURACITY_API_KEY}"`);
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
      headers: { Token: FACTURACITY_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }
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
        headers: { Token: FACTURACITY_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      console.log(`🏠 Dirección fiscal añadida para codcliente=${codcliente} email=${datosCliente.email}`);
    } catch (err) {
      console.warn('⚠️ No se pudo añadir dirección fiscal:', err.message);
    }

    // ===== Referencia/Descripción =====
    const descripcion = datosCliente.descripcionProducto || datosCliente.descripcion || datosCliente.producto;
    let referencia = 'OTRO001';
    const tp = (datosCliente.tipoProducto || '').toLowerCase();
    if (datosCliente.nombreProducto === 'el-club-laboroteca') referencia = 'CLUB001';
    else if (tp === 'libro') referencia = 'LIBRO001';
    else if (tp === 'curso') referencia = 'CURSO001';
    else if (tp === 'guia') referencia = 'GUIA001';

    // ===== Cantidad y PRECIO UNITARIO BASE (sin IVA) =====
    const esEntrada = tp === 'entrada';
    const cantidad = esEntrada ? parseInt(datosCliente.totalAsistentes || '1', 10) : 1;

    // Base unitario = baseTotal / cantidad, TRUNCADO a 4 decimales (no redondear)
    const pvpUnitarioBase = trunc4(baseTotal / cantidad).toFixed(4);

    // === Línea SIN incluyeiva (0) para que FacturaCity calcule total exacto desde la base truncada ===
    const lineas = [
      {
        referencia,
        descripcion,
        cantidad,
        pvpunitario: pvpUnitarioBase, // BASE imponible por unidad
        codimpuesto: 'IVA21',
        incluyeiva: '0'               // 👈 Indicamos que el pvpunitario NO incluye IVA
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
      headers: { Token: FACTURACITY_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    console.log('📩 Respuesta completa de crearFacturaCliente:', JSON.stringify(facturaResp.data, null, 2));

    const idfactura = facturaResp.data?.doc?.idfactura;
    if (!idfactura) throw new Error('❌ No se recibió idfactura');
    console.log(`✅ Factura emitida idfactura=${idfactura} invoiceId=${datosCliente.invoiceId || 'N/A'} email=${datosCliente.email}`);

    const pdfUrl = `${API_BASE}/exportarFacturaCliente/${idfactura}?lang=es_ES`;
    const pdfResponse = await axios.get(pdfUrl, {
      headers: { Token: FACTURACITY_API_KEY },
      responseType: 'arraybuffer'
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

    throw new Error('Error al generar la factura');
  }
}

module.exports = { crearFacturaEnFacturaCity };
