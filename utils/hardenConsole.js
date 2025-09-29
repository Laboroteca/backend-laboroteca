// 📂 utils/hardenConsole.js
'use strict';

/**
 * HardenConsole: redacción automática de PII en todos los console.*
 * Aplica a: console.log / info / warn / error
 * Afecta solo a LOGS. No toca datos en BD, Stripe, FacturaCity, etc.
 * 
 * Para desactivar enmascarado en desarrollo:
 *    LAB_LOG_PII=1 node index.js
 */

// ============================
// Helpers de enmascarado
// ============================

const maskEmail = (e = '') => {
  const s = String(e).trim();
  const at = s.indexOf('@');
  if (at < 1) return '***@***';
  const u = s.slice(0, at);
  const d = s.slice(at + 1);
  return `${u.slice(0, 2)}***@***${d.slice(Math.max(0, d.length - 3))}`;
};

const maskDNI = (v = '') => {
  const s = String(v).trim();
  if (!/[A-Z]?\d{7,8}[A-Z]?/i.test(s)) return '******';
  return `******${s.slice(-3)}`;
};

const maskAddress = (v = '') => {
  const s = String(v).trim();
  if (!s) return '';
  return s
    .replace(/\b(\d{1,4})([A-Z]?)\b/g, '***') // números de portal
    .replace(/([A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{3})[A-Za-zÁÉÍÓÚÜÑáéíóúüñ-]*/g, '$1***');
};

// Lista de claves sensibles (mapa básico)
const piiKeys = new Set([
  'email','email_autorrelleno','correo',
  'email_autorelleno',
  'dni','nif','nie','cif',
  'direccion','address','calle',
  'cp','codigopostal',
  'telefono','phone',
  'ciudad','provincia',
  'nombre','apellidos','first_name','last_name',
  'nombrecompleto','full_name','display_name',
  'zip','postal_code'
]);

// ============================
// Sanitización recursiva
// ============================

function redactKV(key, val) {
  const k = String(key || '').toLowerCase();
  if (k.includes('email')) return maskEmail(val);
  if (['dni','nif','nie','cif'].includes(k)) return maskDNI(val);
  if (k.includes('direccion') || k === 'address' || k === 'calle') return maskAddress(val);
  if (k === 'cp' || k.includes('codigopostal')) return '*****';
  if (k.includes('telefono') || k === 'phone') return '*********';
  if (piiKeys.has(k)) return '***';
  return val;
}

function sanitizeDeep(input, depth = 0, seen = new WeakSet()) {
  if (input === null || typeof input !== 'object') return input;
  if (seen.has(input) || depth > 6) return '[...]';
  seen.add(input);

  if (Array.isArray(input)) return input.map(v => sanitizeDeep(v, depth + 1, seen));

  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const vv = sanitizeDeep(v, depth + 1, seen);
    out[k] = redactKV(k, vv);
  }
  return out;
}

// ============================
// Patch global de consola
// ============================

module.exports = function hardenConsole() {
  // Si LAB_LOG_PII=1 → no redacta (modo desarrollo/debug)
  if (process.env.LAB_LOG_PII === '1') return;

  ['log','info','warn','error'].forEach((lvl) => {
    const base = console[lvl].bind(console);
    console[lvl] = (...args) => {
      try {
        const safeArgs = args.map(a => {
          if (a && typeof a === 'object') return sanitizeDeep(a);
          if (typeof a === 'string') {
            // Redacción básica en cadenas planas
            return a
              // ↙️ usar el match m, NO toda la cadena a
              .replace(/([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})/gi, (m) => maskEmail(m))
              .replace(/\b[XYZ]?\d{7,8}[A-Z]\b/gi, (m) => maskDNI(m))
              // dirección: limitar el reemplazo al segmento encontrado
              .replace(/\b(Calle|Avda\.?|Avenida|Plaza|Ctra\.?|Carretera|Camino)\b[^,\n]*/gi, (m) => maskAddress(m));
          }
          return a;
        });
        base(...safeArgs);
      } catch {
        base(...args);
      }
    };
  });
};
