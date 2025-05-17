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

  try {
    await procesarCompra(datos);
    console.log('✅ Compra procesada correctamente desde /fluentform');
    res.status(200).json({ ok: true, mensaje: 'Compra procesada correctamente' });
  } catch (error) {
    console.error('❌ Error procesando la compra desde /fluentform:', error);
    res.status(500).json({ error: 'Error al procesar la compra' });
  }
};
