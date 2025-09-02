// utils/productos.js
// Catálogo único para resolver productos en el backend sin tocar otras rutas.
// Objetivo: que añadir un producto de pago único solo requiera añadir un bloque aquí.
// Mantiene compatibilidad con Club y Entradas sin modificar sus flujos existentes.

'use strict';

/**
 * Esquema de cada producto del catálogo:
 * - slug:              clave única, estable (sin espacios)
 * - nombre:            nombre público
 * - descripcion:       texto descriptivo del producto
 * - tipo:              'libro' | 'curso' | 'guia' | 'club' | 'entrada' | 'otro'
 * - es_recurrente:     boolean (los de este archivo, salvo club, serán false)
 * - activar_membresia: boolean (si tras pagar hay que activar algo en MemberPress)
 * - membership_id:     number | null (ID de MemberPress si aplica)
 * - price_id:          string | null (Price ID de Stripe para validación/fallback)
 * - imagen:            url de portada/imagen del producto
 * - precio_cents:      number | null (informativo; el importe real viene de Stripe)
 * - descripcion_factura: string (plantilla segura para FacturaCity)
 * - aliases:           string[] (palabras/frases que ayudan a normalizar búsquedas)
 * - meta:              objeto libre (p. ej. { gcs_folder, sheet_id, sheet_range })
 */

const PRODUCTOS = {
  // ─────────────────────────────────────────────────────────────────────────────
  // ✅ Pago único con activación de membresía (DE CARA A LA JUBILACIÓN)
  // ─────────────────────────────────────────────────────────────────────────────
  'de-cara-a-la-jubilacion': {
    slug: 'de-cara-a-la-jubilacion',
    nombre: 'Libro digital con acceso vitalicio. De cara a la jubilación',
    descripcion: 'Libro digital con acceso vitalicio. De cara a la jubilación',
    tipo: 'libro',
    es_recurrente: false,
    activar_membresia: true,
    membership_id: 7994, // ⚠️ Mantiene tu ID actual
    price_id: 'price_1RMG0mEe6Cd77jenTpudZVan',
    imagen: 'https://www.laboroteca.es/wp-content/uploads/2025/06/DE-CARA-A-LA-JUBILACION-IGNACIO-SOLSONA-ABOGADO-scaled.png',
    precio_cents: 2990, // informativo
    descripcion_factura: 'Libro digital (acceso vitalicio): "De cara a la jubilación".',
    aliases: [
      'de cara a la jubilacion',
      'libro jubilacion',
      'libro digital de cara a la jubilación'
    ],
    meta: {
      // Opcionales para registrar/archivar si quieres diferenciarlos
      gcs_folder: 'facturas/libros/de-cara-a-la-jubilacion'
      // sheet_id, sheet_range: por defecto usa tu hoja general
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // ✅ Nuevo: Libro "Adelanta tu jubilación" (pago único) con activación de membresía (11006)
  // ─────────────────────────────────────────────────────────────────────────────
  'adelanta-tu-jubilacion': {
    slug: 'adelanta-tu-jubilacion',
    nombre: 'Adelanta tu jubilación',
    descripcion: 'Libro digital con acceso vitalicio. Adelanta tu jubilación',
    tipo: 'libro',
    es_recurrente: false,
    activar_membresia: true,
    membership_id: 11006,
    price_id: 'price_1S2sReEe6Cd77jenmOhFqFuX',
    imagen: '',
    precio_cents: 3490, // informativo; el importe real se toma de Stripe
    descripcion_factura: 'Libro digital (acceso vitalicio): "Adelanta tu jubilación".',
    aliases: [
      'adelanta tu jubilacion',
      'libro adelanta tu jubilacion',
      'libro adelanta tu jubilación. edición digital. membresía vitalicia',
      'adelanta tu jubilación. libro digital con acceso vitalicio'
    ],
    meta: {
      gcs_folder: 'facturas/libros/adelanta-tu-jubilacion'
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // ♻️ Recurrente (Club) – se mantiene para compatibilidad (no es pago único)
  // ─────────────────────────────────────────────────────────────────────────────
  'el-club-laboroteca': {
    slug: 'el-club-laboroteca',
    nombre: 'Suscripción mensual a El Club Laboroteca. Acceso a contenido exclusivo.',
    descripcion: 'Suscripción mensual a El Club Laboroteca. Acceso a contenido exclusivo.',
    tipo: 'club',
    es_recurrente: true,
    activar_membresia: true,
    membership_id: 10663, // ⚠️ Mantiene tu ID actual
    price_id: 'price_1RmY1YEe6Cd77jenSc0mZxBi',
    imagen: 'https://www.laboroteca.es/wp-content/uploads/2025/07/Club-laboroteca-precio-suscripcion-mensual-2.webp',
    precio_cents: null,
    descripcion_factura: 'Suscripción mensual: El Club Laboroteca.',
    aliases: ['el club laboroteca', 'club laboroteca', 'club'],
    meta: {}
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // 🎫 Entradas – flujo específico fuera de pago único con membresía
  // ─────────────────────────────────────────────────────────────────────────────
  'entrada-evento': {
    slug: 'entrada-evento',
    nombre: 'Entrada evento',
    descripcion: 'Entrada para evento presencial',
    tipo: 'entrada',
    es_recurrente: false,
    activar_membresia: false,
    membership_id: null,
    price_id: null, // se resuelve por flujo de "entradas"
    imagen: 'https://www.laboroteca.es/wp-content/uploads/2025/08/logo-entradas-laboroteca-scaled.webp',
    precio_cents: null,
    descripcion_factura: 'Entrada para evento presencial Laboroteca.',
    aliases: ['entrada', 'ticket', 'evento', 'entrada evento'],
    meta: {}
  }
};

// ───────────────────────────────────────────────────────────────────────────────
// Índices auxiliares para resolución rápida
// ───────────────────────────────────────────────────────────────────────────────

/** Mapa price_id → slug (solo productos con price_id definido) */
const INDEX_BY_PRICE = Object.values(PRODUCTOS).reduce((acc, p) => {
  if (p.price_id) acc[p.price_id] = p.slug;
  return acc;
}, {});

/** Mapa de sinónimos/alias → slug, para normalización por texto */
const INDEX_BY_ALIAS = (() => {
  const map = {};
  for (const p of Object.values(PRODUCTOS)) {
    (p.aliases || []).forEach(a => {
      const k = (a || '').toString().trim().toLowerCase();
      if (k) map[k] = p.slug;
    });
    // También indexamos nombre y descripción como alias
    [p.nombre, p.descripcion].forEach(txt => {
      const k = (txt || '').toString().trim().toLowerCase();
      if (k) map[k] = p.slug;
    });
    // El propio slug también vale
    map[p.slug] = p.slug;
  }
  return map;
})();

// ───────────────────────────────────────────────────────────────────────────────
// Normalización y resolución
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Normaliza texto básico (quitar tildes suaves opcional, minúsculas y trim).
 * Aquí mantenemos simple: toLowerCase + trim.
 */
function _norm(s = '') {
  return (s || '').toString().trim().toLowerCase();
}

/**
 * Normaliza un nombre/tipo de producto a un slug conocido del catálogo.
 * Acepta combinaciones típicas que llegan desde metadata:
 * - tipoProducto / nombreProducto / descripcionProducto
 * - slugs/aliases/nombres amigables
 *
 * @param {string} nombreProducto
 * @param {string} [tipoProducto]
 * @returns {string|null} slug normalizado o null
 */
function normalizarProducto(nombreProducto = '', tipoProducto = '') {
  const tipo = _norm(tipoProducto);
  const nombre = _norm(nombreProducto);

  // Reglas rápidas
  if (tipo.includes('entrada')) return 'entrada-evento';
  if (tipo.includes('club')) return 'el-club-laboroteca';

  // Búsqueda por alias/slug/nombre directos
  if (INDEX_BY_ALIAS[nombre]) return INDEX_BY_ALIAS[nombre];

  // Heurísticas simples sobre el texto
  if (nombre.includes('entrada')) return 'entrada-evento';
  if (nombre.includes('de cara a la jubilacion')) return 'de-cara-a-la-jubilacion';
  if (nombre.includes('adelanta tu jubilacion')) return 'adelanta-tu-jubilacion';
  if (nombre.includes('el club laboroteca')) return 'el-club-laboroteca';

  return null;
}

/**
 * Resuelve un producto del catálogo a partir de metadata y/o line items.
 * Orden de preferencia:
 *   1) price_id (metadata o line items)
 *   2) slug/alias por nombreProducto + tipoProducto
 *   3) null si no hay match claro
 *
 * @param {object} meta { tipoProducto, nombreProducto, descripcionProducto, price_id }
 * @param {Array<object>} [lineItems] Items de Stripe (si están disponibles)
 * @returns {object|null} Producto del catálogo o null
 */
function resolverProducto(meta = {}, lineItems = []) {
  const metaPrice = _norm(meta.price_id);
  if (metaPrice && INDEX_BY_PRICE[metaPrice]) {
    return PRODUCTOS[INDEX_BY_PRICE[metaPrice]];
  }

  // Intento por line items (si Stripe nos los pasó)
  const liPrice = _norm(
    (lineItems[0] && (lineItems[0].price?.id || lineItems[0].price_id)) || ''
  );
  if (liPrice && INDEX_BY_PRICE[liPrice]) {
    return PRODUCTOS[INDEX_BY_PRICE[liPrice]];
  }

  // Intento por nombre/tipo
  const slug = normalizarProducto(meta.nombreProducto, meta.tipoProducto);
  if (slug && PRODUCTOS[slug]) return PRODUCTOS[slug];

  return null; // sin match inequívoco
}

// ───────────────────────────────────────────────────────────────────────────────
// IDs internos de MemberPress por clave normalizada (compatibilidad)
// ───────────────────────────────────────────────────────────────────────────────
const MEMBERPRESS_IDS = {
  'el-club-laboroteca': 10663,
  'de-cara-a-la-jubilacion': 7994,
  'adelanta-tu-jubilacion': 11006
};

// ───────────────────────────────────────────────────────────────────────────────
// Export
// ───────────────────────────────────────────────────────────────────────────────
module.exports = {
  PRODUCTOS,
  normalizarProducto,
  resolverProducto,
  MEMBERPRESS_IDS
};