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

async function crearFacturaEnFacturaCity(datosCliente) {
  try {
    console.log('🔐 API KEY utilizada:', `"${FACTURACITY_API_KEY}"`);
    console.log('🌐 API URL utilizada:', API_BASE);
    console.log('🧾 Datos del cliente recibidos para facturar:', JSON.stringify(datosCliente, null, 2));

    // ⛔ NUNCA dividir entre 1,21. Trabajamos con PVP CON IVA.
    const totalConIVA = Number.parseFloat(String(datosCliente.importe).replace(',', '.'));
    if (!totalConIVA || Number.isNaN(totalConIVA)) {
      throw new Error(`❌ El importe recibido no es válido: "${datosCliente.importe}"`);
    }

    // Cliente
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
    console.log(`✅ Cliente creado: ${codcliente}`);

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
      console.log('🏠 Dirección fiscal registrada correctamente');
    } catch (err) {
      console.warn('⚠️ No se pudo añadir dirección fiscal:', err.message);
    }

    // Referencia/Descripción
    const descripcion = datosCliente.descripcionProducto || datosCliente.descripcion || datosCliente.producto;
    let referencia = 'OTRO001';
    if (datosCliente.nombreProducto === 'el-club-laboroteca') referencia = 'CLUB001';
    else if ((datosCliente.tipoProducto || '').toLowerCase() === 'libro') referencia = 'LIBRO001';
    else if ((datosCliente.tipoProducto || '').toLowerCase() === 'curso') referencia = 'CURSO001';
    else if ((datosCliente.tipoProducto || '').toLowerCase() === 'guia')  referencia = 'GUIA001';

    // Cantidad y precio unitario CON IVA
    const esEntrada = (datosCliente.tipoProducto || '').toLowerCase() === 'entrada';
    const cantidad = esEntrada ? parseInt(datosCliente.totalAsistentes || '1', 10) : 1;

    // Precio unitario con IVA con 2 decimales exactos
    const pvpUnitarioConIVA = (totalConIVA / cantidad);
    const pvpunitario = pvpUnitarioConIVA.toFixed(2); // ← 22.90

    // 🔑 Línea con precio que INCLUYE IVA: evita recalcular 21 %
    const lineas = [
    {
      referencia,
      descripcion,
      cantidad,
      pvpunitario: totalConIVA.toFixed(2), // 22.90
      codimpuesto: 'IVA21',
      incluyeiva: 1
    }
  ];


    // Cabecera factura
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
      // No enviamos bases ni totales para que NO recalculen nada distinto
    };

    const facturaResp = await axios.post(`${API_BASE}/crearFacturaCliente`, qs.stringify(factura), {
      headers: { Token: FACTURACITY_API_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    console.log('📩 Respuesta completa de crearFacturaCliente:', JSON.stringify(facturaResp.data, null, 2));

    const idfactura = facturaResp.data?.doc?.idfactura;
    if (!idfactura) throw new Error('❌ No se recibió idfactura');
    console.log(`🧾 Factura creada con ID ${idfactura}`);

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
      console.error('❌ Error al crear factura en FacturaCity:');
      console.error('🔢 Status:', error.response.status);
      console.error('📦 Data:', error.response.data);
    } else {
      console.error('❌ Error sin respuesta del servidor:', error.message);
    }
    throw new Error('Error al generar la factura');
  }
}

module.exports = { crearFacturaEnFacturaCity };
