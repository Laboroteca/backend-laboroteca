require('dotenv').config();
const procesarCompra = require('../services/procesarCompra');

module.exports = async function (req, res) {
  const tokenCliente = req.headers['authorization'];

  if (tokenCliente !== process.env.FLUENTFORM_TOKEN) {
    console.warn('🚫 Token inválido recibido en /fluentform');
    return res.status(403).json({ error: 'Token inválido' });
  }

  const datos = req.body;
  console.log('📦 Datos recibidos del formulario FluentForms:', datos);

  // Reorganizar los datos como si fueran una sesión de Stripe
  const session = {
    customer_details: {
      email: datos.email,
      name: `${datos.nombre || ''} ${datos.apellidos || ''}`.trim()
    },
    amount_total: Math.round(parseFloat(datos.importe || 0) * 100),
    metadata: {
      nombre: datos.nombre || '',
      apellidos: datos.apellidos || '',
      dni: datos.dni || '',
      direccion: datos.direccion || '',
      ciudad: datos.ciudad || '',
      provincia: datos.provincia || '',
      cp: datos.cp || '',
      tipoProducto: datos.tipoProducto || '',
      nombreProducto: datos.nombreProducto || '',
      email: datos.email || ''
    }
  };

  try {
    await procesarCompra(session);
    console.log('✅ Compra procesada correctamente desde /fluentform');
    res.status(200).json({ ok: true, mensaje: 'Compra procesada correctamente' });
  } catch (error) {
    console.error('❌ Error procesando la compra desde /fluentform:', error);
    res.status(500).json({ error: 'Error al procesar la compra' });
  }
};
