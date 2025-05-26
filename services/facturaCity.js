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

    const precioTotalConIVA = parseFloat(datosCliente.importe);
    if (!precioTotalConIVA || isNaN(precioTotalConIVA)) {
      throw new Error(`❌ El importe recibido no es válido: "${datosCliente.importe}"`);
    }

    const precioBase = (precioTotalConIVA / 1.21).toFixed(2);
    console.log('💶 Precio base sin IVA:', precioBase, '→ Total con IVA:', precioTotalConIVA.toFixed(2));

    // 1. Crear cliente
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
      headers: {
        Token: FACTURACITY_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const codcliente = clienteResp.data?.data?.codcliente;
    if (!codcliente) throw new Error('❌ No se pudo obtener codcliente');
    console.log(`✅ Cliente creado: ${codcliente}`);

    // 2. Crear dirección de facturación vinculada
    let idcontactofact = null;
    try {
      const direccionFact = {
        codcliente,
        descripcion: 'Dirección de facturación',
        direccion: datosCliente.direccion || '',
        codpostal: datosCliente.cp || '',
        ciudad: datosCliente.ciudad || '',
        provincia: datosCliente.provincia || '',
        pais: 'España',
        nombre: datosCliente.nombre,
        apellidos: datosCliente.apellidos,
        email: datosCliente.email
      };

      const direccionResp = await axios.post(`${API_BASE}/direccionescliente`, qs.stringify(direccionFact), {
        headers: {
          Token: FACTURACITY_API_KEY,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      idcontactofact = direccionResp.data?.data?.idcontacto;
      if (idcontactofact) {
        console.log(`🏠 Dirección añadida con ID contacto: ${idcontactofact}`);
      } else {
        console.warn('⚠️ Dirección creada pero no se obtuvo idcontacto');
      }
    } catch (direccionErr) {
      console.warn('⚠️ No se pudo añadir la dirección de facturación:', direccionErr.message);
    }

    // 3. Crear factura
    const lineas = [{
      referencia: 'LIBRO001',
      descripcion: datosCliente.producto,
      cantidad: 1,
      pvpunitario: precioBase,
      codimpuesto: 'IVA21'
    }];

    const factura = {
      codcliente,
      lineas: JSON.stringify(lineas),
      pagada: 1,
      fecha: obtenerFechaHoy(),
      codserie: 'A',
      nombrecliente: `${datosCliente.nombre} ${datosCliente.apellidos}`,
      cifnif: datosCliente.dni,
      ...(idcontactofact ? { idcontactofact } : {})
    };

    const facturaResp = await axios.post(`${API_BASE}/crearFacturaCliente`, qs.stringify(factura), {
      headers: {
        Token: FACTURACITY_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    console.log('📩 Respuesta completa de crearFacturaCliente:', JSON.stringify(facturaResp.data, null, 2));

    const idfactura = facturaResp.data?.doc?.idfactura;
    if (!idfactura) throw new Error('❌ No se recibió idfactura');
    console.log(`🧾 Factura creada con ID ${idfactura}`);

    // 4. Descargar PDF
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

module.exports = {
  crearFacturaEnFacturaCity
};
