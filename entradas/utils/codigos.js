// /entradas/utils/codigos.js

/**
 * Genera un código único con formato personalizado para una entrada.
 * Ejemplo: JUB-XY123
 * @param {string} slugEvento - slug del evento (ej. "jub-2025")
 * @returns {string} Código de entrada
 */
function generarCodigoEntrada(slugEvento = '') {
  const letras = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const random = () =>
    letras[Math.floor(Math.random() * letras.length)] +
    letras[Math.floor(Math.random() * letras.length)] +
    Math.floor(100 + Math.random() * 900); // 100-999

  const prefijo = slugEvento.toUpperCase().slice(0, 3).replace(/[^A-Z0-9]/g, '');
  return `${prefijo}-${random()}`;
}

/**
 * Normaliza un texto para usarlo como slug: quita tildes, pasa a minúsculas,
 * elimina símbolos raros y convierte espacios en guiones.
 * @param {string} texto
 * @returns {string}
 */
function normalizar(texto) {
  return (texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-]/g, '');
}

module.exports = {
  generarCodigoEntrada,
  normalizar
};
