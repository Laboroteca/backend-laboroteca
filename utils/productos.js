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
 * - memberpressId:     number | null (ID de MemberPress si aplica)   ← canónico
 * - membership_id:     number | null (compatibilidad legacy)
 * - priceId:           string | null (Price de Stripe)               ← canónico
 * - price_id:          string | null (compatibilidad legacy)
 * - imagen:            url de portada/imagen del producto
 * - precio:            number | null (euros, p.ej. 29.90)            ← canónico
 * - precio_cents:      number | null (centimos, compatibilidad)
 * - descripcion_factura: string (plantilla segura para FacturaCity)
 * - aliases:           string[] (palabras/frases que ayudan a normalizar búsquedas)
 * - caducidadDias:     number | null (por defecto vitalicio si no se define)
      gcs_folder: 'facturas/libros/de-cara-a-la-jubilacion'
      // mp_api_url: 'https://www.laboroteca.es/wp-json/laboroteca/v1/libro-membership'
 */

const PRODUCTOS = {
  // ─────────────────────────────────────────────────────────────────────────────
  // ✅ Pago único con activación de membresía (DE CARA A LA JUBILACIÓN)
  // ─────────────────────────────────────────────────────────────────────────────
  'de-cara-a-la-jubilacion': {
    slug: 'de-cara-a-la-jubilacion',
    nombre: 'Libro digital. De cara a la jubilación.',
    descripcion: 'De cara a la jubilación. Libro digital con acceso vitalicio.',
    tipo: 'libro',
    es_recurrente: false,
    activar_membresia: true,
    // Canónicos
    memberpressId: 7994,
    priceId: 'price_1RLX9QEe6Cd77jen9erw5BYb',
    precio: 29.90,
    // Compat legacy
    membership_id: 7994,
    price_id: 'price_1RLX9QEe6Cd77jen9erw5BYb',
    imagen: 'https://www.laboroteca.es/wp-content/uploads/2025/06/DE-CARA-A-LA-JUBILACION-IGNACIO-SOLSONA-ABOGADO-scaled.png',
    precio_cents: 2990, // informativo/compat
    descripcion_factura: 'Libro digital (acceso vitalicio): "De cara a la jubilación".',
    aliases: [
      'de cara a la jubilacion',
      'libro jubilacion',
      'libro digital de cara a la jubilación',
      // Alias tal como aparece en los Sheets (compras/regalos), añade aquí cualquier variante nueva
      'libro digital (acceso vitalicio): "de cara a la jubilación".',
      'libro digital. de cara a la jubilación'
    ],
    caducidadDias: null, // vitalicio por defecto
    meta: {
      // Opcionales para registrar/archivar si quieres diferenciarlos
      gcs_folder: 'facturas/libros/de-cara-a-la-jubilacion'
      // sheet_id, sheet_range: por defecto usa tu hoja general
    },
    // ⬇️ Nuevo: solo se invitan a reseñas los productos de pago único que tengan este enlace definido
    enlaceResenas: 'https://www.laboroteca.es/comprar-de-cara-a-la-jubilacion-libro-digital/'
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // ✅ Nuevo: Libro "Adelanta tu jubilación" (pago único) con activación de membresía (11006)
  // ─────────────────────────────────────────────────────────────────────────────
  'adelanta-tu-jubilacion': {
    slug: 'adelanta-tu-jubilacion',
    nombre: 'Libro digital. Adelanta tu jubilación',
    descripcion: 'Libro digital con acceso vitalicio. Adelanta tu jubilación',
    tipo: 'libro',
    es_recurrente: false,
    activar_membresia: true,
    // Canónicos
    memberpressId: 11006,
    priceId: 'price_1SUF4xEe6Cd77jenj0NdQNSo',
    precio: 34.90,
    // Compat legacy
    membership_id: 11006,
    price_id: 'price_1SUF4xEe6Cd77jenj0NdQNSo',
    imagen: 'https://www.laboroteca.es/wp-content/uploads/2025/11/portada-libro-adelanta-tu-jubilacion-ignacio-solsona-scaled.webp',
    precio_cents: 3490, // informativo/compat
    descripcion_factura: 'Libro digital (acceso vitalicio): "Adelanta tu jubilación".',
    aliases: [
      'adelanta tu jubilacion',
      'libro adelanta tu jubilacion',
      'libro adelanta tu jubilación. edición digital. membresía vitalicia',
      'adelanta tu jubilación. libro digital con acceso vitalicio'
    ],
    caducidadDias: null, // vitalicio por defecto
    meta: {
      gcs_folder: 'facturas/libros/adelanta-tu-jubilacion'
      // mp_api_url: 'https://www.laboroteca.es/wp-json/laboroteca/v1/libro-membership'
    },
    // Enlace para reseñas (habilita envío del cron)
    enlaceResenas: 'https://www.laboroteca.es/comprar-libro-adelanta-tu-jubilacion-ignacio-solsona/'
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // ✅ Nuevo: Libro "Subsidio mayores de 52" (pago único) con activación de membresía
  // ─────────────────────────────────────────────────────────────────────────────
  'libro-subsidio-mayores-de-52': {
    slug: 'libro-subsidio-mayores-de-52',
    nombre: 'Libro digital. Subsidio mayores de 52',
    descripcion: 'Libro digital con acceso vitalicio. Subsidio mayores de 52.',
    tipo: 'libro',
    es_recurrente: false,
    activar_membresia: true,
    // Canónicos
    memberpressId: 14763,
    priceId: 'price_1TEDZFEe6Cd77jenoK3RwehV',
    precio: 34.90,
    // Compat legacy
    membership_id: 14763,
    price_id: 'price_1TEDZFEe6Cd77jenoK3RwehV',
    imagen: 'https://www.laboroteca.es/wp-content/uploads/2026/03/libro-subsidio-ignacio-solsona-laboroteca-scaled.webp',
    precio_cents: 3490,
    descripcion_factura: 'Libro digital (acceso vitalicio): "Subsidio mayores de 52".',
    aliases: [
      'subsidio mayores de 52',
      'subsidio mayor de 52',
      'subsidio + 52',
      'subsidio 52',
      'libro subsidio mayores de 52',
      'libro subsidio + 52',
      'libro subsidio 52',
      'libro digital subsidio mayores de 52',
      'libro digital. subsidio mayores de 52',
      'subsidio mayores de 52. libro digital con acceso vitalicio',
      'subsidio + 52. libro digital con acceso vitalicio'
    ],
    caducidadDias: null,
    meta: {
      gcs_folder: 'facturas/libros/subsidio-mayores-de-52'
    },
    enlaceResenas: 'https://www.laboroteca.es/comprar-libro-subsidio-mayores-52-ignacio-solsona/'
  },


  // ─────────────────────────────────────────────────────────────────────────────
  // ✅ Nuevo: Libro "Conoce y protege tus derechos laborales" (pago único)
  //     * URL WP: /register/libro-conoce-y-protege-tus-derechos-laborales/
  //     * Nota: el slug sigue la URL ("protege") para coherencia con WP.
  // ─────────────────────────────────────────────────────────────────────────────
  'libro-conoce-y-protege-tus-derechos-laborales': {
    slug: 'libro-conoce-y-protege-tus-derechos-laborales',
    nombre: 'Libro digital. Conoce y protege tus derechos laborales',
    descripcion: 'Conoce y protege tus derechos laborales. Edición digital con acceso vitalicio.',
   tipo: 'libro',
    es_recurrente: false,
    activar_membresia: true,
    // Canónicos
    memberpressId: 11418,
    priceId: 'price_1S3jNSEe6Cd77jenZ52iQd7D',
    precio: 29.95,
    // Compat legacy
    membership_id: 11418,
    price_id: 'price_1S3jNSEe6Cd77jenZ52iQd7D',
    imagen: 'https://www.laboroteca.es/wp-content/uploads/2025/04/CONSULTAS-IGNACIO-SOLSONA-scaled.webp',
    precio_cents: 2995, // informativo/compat
    descripcion_factura: 'Libro digital (acceso vitalicio): "Conoce y protege tus derechos laborales".',
    aliases: [
      'conoce y defiende tus derechos laborales',
      'conocer y defender tus derechos laborales',
      'conoce y protege tus derechos laborales',
      'libro conoce y defiende tus derechos laborales',
      'libro conoce y protege tus derechos laborales',
      'tus derechos laborales',
      'manual de defensa del trabajador'
    ],
    caducidadDias: null, // vitalicio por defecto
    meta: {
      gcs_folder: 'facturas/libros/conoce-y-defiende-tus-derechos-laborales',
      url: 'https://www.laboroteca.es/register/libro-conoce-y-protege-tus-derechos-laborales/',
      stripeProductId: 'prod_SzipTefoA7CzRu'
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
    // Canónicos
    memberpressId: 10663,
    priceId: 'price_1SD83dEe6Cd77jenstXE9xPO',
    // Compat legacy
    membership_id: 10663,
    price_id: 'price_1SD83dEe6Cd77jenstXE9xPO',
    imagen: 'https://www.laboroteca.es/wp-content/uploads/2025/07/Club-laboroteca-precio-suscripcion-mensual-2.webp',
    precio_cents: null,
    precio: null, // suscripción → no aplica aquí
    descripcion_factura: 'Suscripción mensual: El Club Laboroteca.',
    aliases: ['el club laboroteca', 'club laboroteca', 'club'],
    meta: {}
    // ⚠️ No definir "enlaceResenas" aquí: se excluye explícitamente del cron
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
    // Canónicos
    memberpressId: null,
    priceId: null,
    // Compat legacy
    membership_id: null,
    price_id: null, // se resuelve por flujo de "entradas"
    imagen: 'https://www.laboroteca.es/wp-content/uploads/2025/08/logo-entradas-laboroteca-scaled.webp',
    precio_cents: null,
    precio: null,
    descripcion_factura: 'Entrada para evento presencial Laboroteca.',
    aliases: ['entrada', 'ticket', 'evento', 'entrada evento'],
    meta: {}
    // ⚠️ No definir "enlaceResenas" aquí: se excluye explícitamente del cron
  }
};

// ───────────────────────────────────────────────────────────────────────────────
// Índices auxiliares para resolución rápida
// ───────────────────────────────────────────────────────────────────────────────

/** Mapa price → slug (acepta price_id o priceId) */
const INDEX_BY_PRICE = Object.values(PRODUCTOS).reduce((acc, p) => {
  if (p.price_id) acc[String(p.price_id).toLowerCase()] = p.slug;
  if (p.priceId)  acc[String(p.priceId).toLowerCase()] = p.slug; // canónico
  return acc;
}, {});

/** Mapa de sinónimos/alias → slug, para normalización por texto */
const INDEX_BY_ALIAS = (() => {
  const map = {};
  for (const p of Object.values(PRODUCTOS)) {
    (p.aliases || []).forEach(a => {
      const k = normalizeKey(a);
      if (k) map[k] = p.slug;
    });
    // También indexamos nombre y descripción como alias
    [p.nombre, p.descripcion].forEach(txt => {
      const k = normalizeKey(txt);
      if (k) map[k] = p.slug;
    });
    // El propio slug también vale
    map[normalizeKey(p.slug)] = p.slug;
  }
  return map;
})();

// ───────────────────────────────────────────────────────────────────────────────
// Normalización y resolución
// ───────────────────────────────────────────────────────────────────────────────

// Fallback de imagen por defecto para productos sin portada definida
const DEFAULT_IMAGE = 'https://www.laboroteca.es/wp-content/uploads/2025/04/NUEVO-LOGO-LABOROTECA-2.webp';

// 🔧 Normalizador robusto: minúsculas, sin tildes, sin puntuación y espacios colapsados
function normalizeKey(s = '') {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')      // quita acentos
    .replace(/[\.\,\;\:\!\?\«\»"“”'’\(\)\[\]\{\}]/g, ' ') // quita puntuación común
    .replace(/\s+/g, ' ')                                  // colapsa espacios
    .trim();
}


/**
 * Normaliza texto básico (quitar tildes suaves opcional, minúsculas y trim).
 * Aquí mantenemos simple: toLowerCase + trim.
 */
function _norm(s = '') { return normalizeKey(s); }

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
  if (nombre.includes('conoce y defiende tus derechos laborales')) return 'libro-conoce-y-protege-tus-derechos-laborales';
  if (nombre.includes('conoce y protege tus derechos laborales')) return 'libro-conoce-y-protege-tus-derechos-laborales';
  if (nombre.includes('tus derechos laborales')) return 'libro-conoce-y-protege-tus-derechos-laborales';
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
  const metaPrice = (meta.price_id || meta.priceId || '').toString().trim().toLowerCase();
  if (metaPrice && INDEX_BY_PRICE[metaPrice]) {
    return PRODUCTOS[INDEX_BY_PRICE[metaPrice]];
  }

  // Intento por line items (si Stripe nos los pasó)
  const liPrice = ((lineItems[0] && (lineItems[0].price?.id || lineItems[0].price_id)) || '').toLowerCase();
  if (liPrice && INDEX_BY_PRICE[liPrice]) {
    return PRODUCTOS[INDEX_BY_PRICE[liPrice]];
  }

  // Intento por nombre/tipo
  const slug = normalizarProducto(meta.nombreProducto, meta.tipoProducto);
  if (slug && PRODUCTOS[slug]) return PRODUCTOS[slug];

  return null; // sin match inequívoco
}

/**
 * Devuelve la URL de imagen del producto, o el fallback si no está definida.
 */
function getImagenProducto(slug) {
  const p = PRODUCTOS[slug];
  if (!p) return DEFAULT_IMAGE;
  return p.imagen || DEFAULT_IMAGE;
}

// ——————————————————————————————————————————————
// Helpers canónicos (no rompedores)
// ——————————————————————————————————————————————
function getProducto(slug) {
  const p = PRODUCTOS[slug];
  if (!p) return null;
  // Normalización de compatibilidad: devolvemos claves canónicas siempre
  return {
    ...p,
    memberpressId: p.memberpressId ?? p.membership_id ?? null,
    priceId: p.priceId ?? p.price_id ?? null,
    precio: typeof p.precio === 'number'
      ? p.precio
      : (Number.isFinite(p.precio_cents) ? p.precio_cents / 100 : null),
    precio_cents: Number.isFinite(p.precio_cents)
      ? p.precio_cents
      : (typeof p.precio === 'number' ? Math.round(p.precio * 100) : null)
  };
}

function getMemberpressId(slug) {
  const p = PRODUCTOS[slug];
  return p ? (p.memberpressId ?? p.membership_id ?? null) : null;
}

function getPriceInfo(slug) {
  const p = PRODUCTOS[slug];
  if (!p) return { priceId: null, amount_cents: null, amount_eur: null };
  const priceId = p.priceId ?? p.price_id ?? null;
  const amount_cents = Number.isFinite(p.precio_cents)
    ? p.precio_cents
    : (typeof p.precio === 'number' ? Math.round(p.precio * 100) : null);
  const amount_eur = typeof p.precio === 'number'
    ? p.precio
    : (Number.isFinite(p.precio_cents) ? p.precio_cents / 100 : null);
  return { priceId, amount_cents, amount_eur };
}

// ───────────────────────────────────────────────────────────────────────────────
// IDs internos de MemberPress por clave normalizada (compatibilidad)
// ───────────────────────────────────────────────────────────────────────────────
const MEMBERPRESS_IDS = {
  'el-club-laboroteca': 10663,
  'de-cara-a-la-jubilacion': 7994,
  'adelanta-tu-jubilacion': 11006,
  'libro-subsidio-mayores-de-52': 14763,
  'libro-conoce-y-protege-tus-derechos-laborales': 11418
};

// ───────────────────────────────────────────────────────────────────────────────
// Export
// ───────────────────────────────────────────────────────────────────────────────
module.exports = {
  PRODUCTOS,
  normalizarProducto,
  resolverProducto,
  MEMBERPRESS_IDS,
  getImagenProducto,
  DEFAULT_IMAGE,
  // nuevos helpers canónicos
  getProducto,
  getMemberpressId,
  getPriceInfo
};