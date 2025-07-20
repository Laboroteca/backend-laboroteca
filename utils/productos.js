// utils/productos.js

const PRODUCTOS = {
  'libro digital con acceso vitalicio. de cara a la jubilacion': {
    nombre: 'Libro digital con acceso vitalicio. De cara a la jubilación',
    slug: 'de-cara-a-la-jubilacion',
    descripcion: 'Libro digital con acceso vitalicio. De cara a la jubilación',
    price_id: 'price_1RMG0mEe6Cd77jenTpudZVan',
    imagen: 'https://www.laboroteca.es/wp-content/uploads/2025/06/DE-CARA-A-LA-JUBILACION-IGNACIO-SOLSONA-ABOGADO-scaled.png',
    precio_cents: 2990
  },
  'alta y primera cuota mensual el club laboroteca. acceso a contenido exclusivo.': {
    nombre: 'Suscripción mensual a El Club Laboroteca. Acceso a contenido exclusivo.',
    slug: 'el-club-laboroteca',
    descripcion: 'Suscripción mensual a El Club Laboroteca. Acceso a contenido exclusivo.',
    price_id: 'price_1RmY1YEe6Cd77jenSc0mZxBi',
    imagen: 'https://www.laboroteca.es/wp-content/uploads/2025/07/Club-laboroteca-precio-suscripcion-mensual-2.webp'
  }
};

/**
 * Normaliza un nombre de producto largo o decorado a una clave simple.
 * Se usa para vincular con MemberPress.
 * @param {string} nombreProducto
 * @returns {string|null} clave normalizada
 */
function normalizarProducto(nombreProducto = '') {
  const clave = nombreProducto.trim().toLowerCase();

  if (clave.includes('de cara a la jubilacion')) return 'de-cara-a-la-jubilacion';
  if (clave.includes('el club laboroteca')) return 'el-club-laboroteca';

  return null;
}

// IDs internos de MemberPress por clave normalizada
const MEMBERPRESS_IDS = {
  'el-club-laboroteca': 10663
  // Añade más si incorporas otros productos en el futuro
};

module.exports = {
  ...PRODUCTOS,
  normalizarProducto,
  MEMBERPRESS_IDS
};

