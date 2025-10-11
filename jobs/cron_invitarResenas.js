// jobs/cron_invitarResenas.js
'use strict';

if (process.env.NODE_ENV !== 'production') { require('dotenv').config(); }

const crypto = require('crypto');
const { google } = require('googleapis');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
dayjs.extend(utc); dayjs.extend(tz);

const admin = require('../firebase'); // Inicialización Firebase Admin
const firestore = admin.firestore();
const { alertAdminProxy: alertAdmin } = require('../utils/alertAdminProxy');

const { normalizarProducto, getProducto } = require('../utils/productos');
const { enviarInvitacionResena } = require('../services/enviarInvitacionResena');

// Auth centralizada de Google Sheets (como en registrarCanjeEnSheet.js)
const { auth } = require('../entradas/google/sheetsAuth');

// ───────────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────────
const TZ = 'Europe/Madrid';
const NOW = dayjs().tz(TZ);

const MIN_DAYS = Number(process.env.WINDOW_MIN_DAYS || 14); // >14
const MAX_DAYS = Number(process.env.WINDOW_MAX_DAYS || 22); // <22
const DRY_RUN  = String(process.env.DRY_RUN || '') === '1';

const SHEET_VENTAS_ID   = '1Mtffq42G7Q0y44ekzvy7IWPS8obvN4pNahA-08igdGk';
const SHEET_VENTAS_TAB  = process.env.SHEET_VENTAS_TAB || 'Hoja 1';
const SHEET_REGALOS_ID  = '1MjxXebR3oQIyu0bYeRWo83Xzj1sBFnDcx53HvRRBiGE';
const SHEET_REGALOS_TAB = process.env.SHEET_REGALOS_TAB || 'Hoja 1';

const a1 = (tab, range) => {
  const t = String(tab || '').trim().replace(/'/g, "''");
  return /[^A-Za-z0-9_]/.test(t) ? `'${t}'!${range}` : `${t}!${range}`;
};

const maskEmail = (e = '') => {
  const [u, d] = String(e).split('@');
  if (!u || !d) return '***';
  return `${u.slice(0, 2)}***@***${d.slice(Math.max(0, d.length - 3))}`;
};

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────
function makeKey(email, slug) {
  const raw = `${String(email || '').toLowerCase().trim()}|${String(slug || '').trim()}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function inWindow(dateStr, source) {
  // source: 'ventas' | 'regalos' (formatos levemente distintos)
  let m;
  if (source === 'ventas') {
    // Ej.: "02/10/2025 - 13:43h" o "02/10/2025 – 13:43h"
    const cleaned = String(dateStr || '')
      .replace(/[–—]/g, '-')         // guiones raros → "-"
      .replace(/\s*-\s*/, ' ')       // " - " → " "
      .replace('h', '');             // quitar h
    m = dayjs.tz(cleaned, 'DD/MM/YYYY HH:mm', TZ);
  } else {
    // Regalos: "DD/MM/YYYY HH:mmh"
    const cleaned = String(dateStr || '').replace('h', '');
    m = dayjs.tz(cleaned, 'DD/MM/YYYY HH:mm', TZ);
  }
  if (!m.isValid()) return false;
  const diffDays = NOW.diff(m, 'day');
  return (diffDays > MIN_DAYS) && (diffDays < MAX_DAYS);
}

function shouldInvite(producto) {
  if (!producto) return false;
  if (producto.tipo === 'club') return false;       // excluir Club siempre
  if (producto.tipo === 'entrada') return false;    // excluir Entradas siempre
  if (producto.es_recurrente) return false;         // fuera renovaciones/recurrencia
  if (!producto.enlaceResenas) return false;        // sólo si hay enlace para reseñas
  return true;
}

// ───────────────────────────────────────────────────────────────────────────────
// Lectura de Google Sheets
// ───────────────────────────────────────────────────────────────────────────────
async function fetchRowsVentas(sheets) {
  // A:G → [Nombre, Apellidos, DNI, Descripción, Precio, FechaHora, Email, ...]
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_VENTAS_ID,
    range: a1(SHEET_VENTAS_TAB, 'A2:G'),
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  return (res.data.values || []).map((r, idx) => ({
    _row: idx + 2,
    nombre: (r[0] || '').toString().trim(),                // A
    desc:   (r[3] || '').toString().trim(),                // D
    fecha:  (r[5] || '').toString().trim(),                // F
    email:  (r[6] || '').toString().trim().toLowerCase()   // G
  })).filter(r => r.email && r.nombre && r.desc && r.fecha);
}

async function fetchRowsRegalos(sheets) {
  // A:G → [FechaHora, Nombre, Apellidos, Email, LibroSeleccionado, Codigo, Origen]
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_REGALOS_ID,
    range: a1(SHEET_REGALOS_TAB, 'A2:G'),
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  return (res.data.values || []).map((r, idx) => ({
    _row: idx + 2,
    fecha:  (r[0] || '').toString().trim(),                // A
    nombre: (r[1] || '').toString().trim(),                // B (solo nombre)
    email:  (r[3] || '').toString().trim().toLowerCase(),  // D
    libro:  (r[4] || '').toString().trim()                 // E (texto visible -> normalizarProducto)
  })).filter(r => r.email && r.nombre && r.libro && r.fecha);
}

// ───────────────────────────────────────────────────────────────────────────────
// Envío con dedupe atómico
// ───────────────────────────────────────────────────────────────────────────────
async function trySendOnce({ email, nombre, producto, slug, subject, variant, source, sheetRow }) {
  // Clave idempotente por usuario+producto
  const key = makeKey(email, slug);
  const docRef = firestore.collection('reviewInvites').doc(key);

  // 1) Marca PENDING atómica (create falla si ya existe)
  if (!DRY_RUN) {
    try {
      await docRef.create({
        email,
        nombre,
        slug,
        enlaceResenas: producto.enlaceResenas,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        source,
        sheetRow
      });
    } catch (e) {
      const code = e?.code || e?.status || e?.message || '';
      // Firestore Admin suele dar code '6' o 'already-exists'
      if (String(code).includes('already') || String(code) === '6') {
        // Ya invitado → abortar sin enviar
        return { sent: false, reason: 'duplicate' };
      }
      // Otro error al crear la marca
      throw e;
    }
  }

  // 2) Envío (o simulación)
  if (!DRY_RUN) {
    await enviarInvitacionResena({
      toEmail: email,
      subject,
      nombre,
      nombreProducto: producto.nombre,
      enlaceResenas: producto.enlaceResenas,
      variant
    });

    // 3) Confirmar estado SENT
    await docRef.set({
      status: 'sent',
      sentAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  return { sent: true };
}

// ───────────────────────────────────────────────────────────────────────────────
// Main
// ───────────────────────────────────────────────────────────────────────────────
(async () => {
  const stats = {
    ventas_checked: 0,
    regalos_checked: 0,
    enviados: 0,
    omitidos: 0,
    duplicados: 0,
    errores: 0,
    omapped: 0,
    unmapped: [] // ejemplos
  };

  try {
    const authClient = await auth();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const ventas = await fetchRowsVentas(sheets);
    const regalos = await fetchRowsRegalos(sheets);

    // ───── Procesar VENTAS
    for (const row of ventas) {
      try {
        stats.ventas_checked++;
        if (!inWindow(row.fecha, 'ventas')) { stats.omitidos++; continue; }

        const slug = normalizarProducto(row.desc, 'libro');
        const producto = slug ? getProducto(slug) : null;

        if (!producto) {
          stats.omapped++;
          if (stats.unmapped.length < 20) {
            stats.unmapped.push({ source: 'ventas', row: row._row, email: maskEmail(row.email), text: row.desc });
          }
          stats.omitidos++; continue;
        }

        if (!shouldInvite(producto)) { stats.omitidos++; continue; }

        const subject = `Escribe una reseña sobre tu compra (${producto.nombre})`;

        const result = await trySendOnce({
          email: row.email,
          nombre: row.nombre,
          producto,
          slug,
          subject,
          variant: 'compra',
          source: 'sheet-ventas',
          sheetRow: row._row
        });

        if (result.sent) stats.enviados++;
        else if (result.reason === 'duplicate') stats.duplicados++;
      } catch (err) {
        stats.errores++;
        console.error('[ventas] Error fila', row?._row, err?.message || err);
      }
    }

    // ───── Procesar REGALOS
    for (const row of regalos) {
      try {
        stats.regalos_checked++;
        if (!inWindow(row.fecha, 'regalos')) { stats.omitidos++; continue; }

        const slug = normalizarProducto(row.libro, 'libro');
        const producto = slug ? getProducto(slug) : null;

        if (!producto) {
          stats.omapped++;
          if (stats.unmapped.length < 20) {
            stats.unmapped.push({ source: 'regalos', row: row._row, email: maskEmail(row.email), text: row.libro });
          }
          stats.omitidos++; continue;
        }

        if (!shouldInvite(producto)) { stats.omitidos++; continue; }

        const subject = `Escribe una reseña sobre (${producto.nombre})`;

        const result = await trySendOnce({
          email: row.email,
          nombre: row.nombre, // solo nombre (sin apellidos)
          producto,
          slug,
          subject,
          variant: 'regalo',
          source: 'sheet-regalos',
          sheetRow: row._row
        });

        if (result.sent) stats.enviados++;
        else if (result.reason === 'duplicate') stats.duplicados++;
      } catch (err) {
        stats.errores++;
        console.error('[regalos] Error fila', row?._row, err?.message || err);
      }
    }

    // Informe final
    const message = [
      `📬 CRON reseñas completado (${NOW.format('YYYY-MM-DD HH:mm')} ${TZ})`,
      `• Ventas revisadas: ${stats.ventas_checked}`,
      `• Regalos revisados: ${stats.regalos_checked}`,
      `• Enviados: ${stats.enviados}`,
      `• Omitidos: ${stats.omitidos}`,
      `• Duplicados: ${stats.duplicados}`,
      `• Errores: ${stats.errores}`,
      stats.omapped ? `• No mapeados: ${stats.omapped}` : null,
      DRY_RUN ? '⚠️ DRY_RUN activo: no se envió ningún email.' : ''
    ].filter(Boolean).join('\n');

    console.log(message);
    try {
      await alertAdmin({
        area: 'reviews.cron.summary',
        meta: { ...stats, unmapped_examples: stats.unmapped },
        message
      });
    } catch (_) {}
  } catch (err) {
    console.error('❌ Error en cron_invitarResenas:', err?.message || err);
    try { await alertAdmin({ area: 'reviews.cron.error', err }); } catch (_) {}
    process.exitCode = 1;
  }
})();
