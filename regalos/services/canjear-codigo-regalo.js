'use strict';

/**
 * Servicio: canjear-codigo-regalo
 *  - Rutas que lo invocan: POST /regalos/canjear-codigo  y  /regalos/canjear-codigo-regalo
 *  - El router ya valida HMAC y normaliza campos. Aquí hacemos:
 *      • Validación de origen (REG-/PRE-)
 *      • Idempotencia fuerte (Firestore.create con captura de ALREADY_EXISTS)
 *      • Registro opcional en Sheets (no bloqueante)
 *      • Activación en MemberPress
 *      • Envío de email (no bloqueante)
 */

const crypto = require('crypto');
const dayjs = require('dayjs');
const { google } = require('googleapis');

const admin = require('../../firebase'); // Firebase Admin ya inicializado
const firestore = admin.firestore();

const { auth } = require('../../entradas/google/sheetsAuth');

const marcarCodigoComoCanjeado = require('./marcarCodigoComoCanjeado');
const registrarCanjeEnSheet   = require('./registrarCanjeEnSheet');
const { activarMembresiaEnMemberPress } = require('./memberpress');
const { enviarEmailCanjeLibro } = require('./enviarEmailCanjeLibro');
const { alertAdminProxy: alertAdmin } = require('../../utils/alertAdminProxy');

// ✅ Catálogo unificado: resolvemos libros y su MemberPress ID desde aquí
const {
  resolverProducto,
  normalizarProducto,
  getMemberpressId,
  PRODUCTOS
  } = require('../../utils/productos');

// Google Sheets (IDs/pestañas)
const SHEET_ID_REGALOS   = process.env.SHEET_ID_CANJES
  || '1MjxXebR3oQIyu0bYeRWo83Xzj1sBFnDcx53HvRRBiGE'; // Libros GRATIS (ID correcto)
const SHEET_NAME_REGALOS = 'Hoja 1';
const SHEET_ID_CONTROL   = '1DFZuhJtuQ0y8EHXOkUUifR_mCVfGyxgkCHXRvBoiwfo'; // Códigos REG- activos
const SHEET_NAME_CONTROL = 'CODIGOS REGALO';

/* ──────────────────────────────
 * Logs (compactos y útiles)
 * ────────────────────────────── */
function rid() {
  const a = crypto.randomBytes(3).toString('hex').slice(0, 6).toUpperCase();
  const b = Date.now().toString(16).slice(-4).toUpperCase();
  return `${a}-${b}`;
}
function L(id, msg, meta) { console.log(`[CANJEAR ${id}] ${msg}${meta ? ' :: ' + JSON.stringify(meta) : ''}`); }
function W(id, msg, meta) { console.warn(`[CANJEAR ${id}] ${msg}${meta ? ' :: ' + JSON.stringify(meta) : ''}`); }
function E(id, msg, err) {
  // Log sin PII/stack verboso
  console.error(`[CANJEAR ${id}] ERROR ${msg} :: ${String(err?.message || err)}`);
}

// RGPD helpers
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e||''));
const maskEmail = (e='') => {
  const s = String(e||''); const i = s.indexOf('@'); if (i<1) return s ? '***' : '';
  const u=s.slice(0,i), d=s.slice(i+1);
  const um = u.length<=2 ? (u[0]||'*') : (u.slice(0,2)+'***'+u.slice(-1));
  const dm = d.length<=3 ? '***' : ('***'+d.slice(-3));
  return `${um}@${dm}`;
};
const maskCode = (c='') => String(c||'').replace(/.(?=.{3}$)/g,'•'); // deja 3 últimos

// Backoff simple con reintentos
async function withRetries(reqId, label, fn, { tries = 5, baseMs = 120 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(i); }
    catch (e) { lastErr = e; if (i < tries) await new Promise(r => setTimeout(r, baseMs * Math.pow(2, i - 1))); }
  }
  E(reqId, `Fallo tras reintentos en ${label}`, lastErr);
  throw lastErr;
}

// Cliente Sheets
async function getSheets() {
  const authClient = await auth();
  return google.sheets({ version: 'v4', auth: authClient });
}

// ✅ Buscar código de forma robusta en rango A:F priorizando D (3), luego C (2) y E (4)
async function findRowByCode({ sheets, spreadsheetId, range = 'A:F', codigo }) {
  const read = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const filas = read.data.values || [];
  const targets = [3, 2, 4]; // D, C, E

  for (let i = 1; i < filas.length; i++) { // i=0 suele ser cabecera
    const row = filas[i] || [];
    for (const col of targets) {
      const c = String(row[col] || '').trim().toUpperCase();
      if (c === codigo) return { row1: i + 1, row0: i, matchedCol: col };
    }
  }
  return null;
}

/* ──────────────────────────────
 * Servicio principal
 * ────────────────────────────── */
module.exports = async function canjearCodigoRegalo({
  nombre,
  apellidos,
  email,
  libro_elegido,
  codigo_regalo,
  membershipId: membershipIdOverride,
  // tolerancias
  libro,
  codigo
}) {
  const reqId = rid();
  const t0 = Date.now();

  // Normalización
  const codigoNorm = String(codigo_regalo || codigo || '').trim().toUpperCase();
  const emailNorm  = String(email || '').trim().toLowerCase();
  const libroNorm  = String(libro_elegido || libro || '').trim();
  const tsHuman    = dayjs().format('YYYY-MM-DD HH:mm:ss');

  L(reqId, 'START', { email: maskEmail(emailNorm), libro: libroNorm, codigo: maskCode(codigoNorm) });

  if (!nombre || !emailNorm || !libroNorm || !codigoNorm || !isEmail(emailNorm)) {
    throw new Error('Faltan datos obligatorios.');
  }

  const esRegalo  = codigoNorm.startsWith('REG-');
  const esEntrada = codigoNorm.startsWith('PRE-');
  if (!esRegalo && !esEntrada) throw new Error('prefijo desconocido');

  // Idempotencia (pre-check)
  const canjeRef = firestore.collection('regalos_canjeados').doc(codigoNorm);
  const ya = await canjeRef.get();
  if (ya.exists) {
    throw new Error('Este código ya ha sido utilizado.');
  }

  /* 1) Validación de origen */
  if (esRegalo) {
    try {
      const sheets = await getSheets();
      const control = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID_CONTROL,
        range: `'${SHEET_NAME_CONTROL}'!A2:E`
      });
      const filas = control.data.values || [];
      const fila = filas.find(f => String(f[2] || '').trim().toUpperCase() === codigoNorm);
      if (!fila) throw new Error('El código introducido no es válido.');
      const emailAsignado = String(fila[1] || '').trim().toLowerCase();
      if (emailAsignado && emailAsignado !== emailNorm) {
        throw new Error('Este código regalo no corresponde con tu email.');
      }
      L(reqId, 'REG validado');
    } catch (e) {
      if (e.message && (
        e.message.includes('válido') ||
        e.message.includes('corresponde')
      )) throw e;
      E(reqId, 'Validación REG falló', e);
      try {
        await alertAdmin({
          area: 'regalos.canje.validacion_reg_error',
          email: emailNorm,
          err: e,
          meta: { reqId, email: emailNorm, codigo: codigoNorm }
        });
      } catch (_) {}
      throw new Error('El código introducido no es válido.');
    }
  } else {
    // PRE-
    try {
      const docEntrada = await firestore.collection('entradasValidadas').doc(codigoNorm).get();
      const ent = docEntrada.exists ? (docEntrada.data() || {}) : null;
      if (!docEntrada.exists || ent.validado !== true) {
        throw new Error('Esta entrada no está validada y no puede canjearse.');
      }

      // Marcar visual en hoja del evento (no bloqueante)
      (async () => {
        try {
          const sheets = await getSheets();
          const MAP = {
            'evento-1': '1W-0N5kBYxNk_DoSNWDBK7AwkM66mcQIpDHQnPooDW6s',
            'evento-2': '1PbhRFdm1b1bR0g5wz5nz0ZWAcgsbkakJVEh0dz34lCM',
            'evento-3': '1EVcNTwE4nRNp4J_rZjiMGmojNO2F5TLZiwKY0AREmZE',
            'evento-4': '1IUZ2_bQXxEVC_RLxNAzPBql9huu34cpE7_MF4Mg6eTM',
            'evento-5': '1LGLEsQ_mGj-Hmkj1vjrRQpmSvIADZ1eMaTJoh3QBmQc'
          };
          const ids = ent.slugEvento && MAP[ent.slugEvento] ? [MAP[ent.slugEvento]] : Object.values(MAP);

          for (const spreadsheetId of ids) {
            const found = await findRowByCode({ sheets, spreadsheetId, codigo: codigoNorm });
            if (!found) continue;

            // ⬇️⬇️ ÚNICO CAMBIO EFECTIVO DE ESCRITURA: F (no E)
            await sheets.spreadsheets.values.update({
              spreadsheetId,
              range: `F${found.row1}`,
              valueInputOption: 'USER_ENTERED',
              requestBody: { values: [['SÍ']] }
            });
            console.log(`[CANJ PRE] Marcado F${found.row1} → "SÍ" en hoja ${spreadsheetId} (colMatch=${found.matchedCol})`);
            break;
          }
        } catch (e2) { W(reqId, 'No se pudo marcar PRE en hoja (se continúa)', { msg: e2?.message }); }
      })();

      L(reqId, 'PRE validado');
    } catch (e) {
      if (e.message && e.message.includes('no está validada')) throw e;
      E(reqId, 'Validación PRE falló', e);
      try {
        await alertAdmin({
          area: 'regalos.canje.validacion_pre_error',
          email: emailNorm,
          err: e,
          meta: { reqId, email: emailNorm, codigo: codigoNorm }
        });
      } catch (_) {}
      throw new Error('Esta entrada no está validada y no puede canjearse.');
    }
  }

  // Resolver producto a partir de slug/alias → para nombre público y MP ID
  let prodResolved = PRODUCTOS[libroNorm] || resolverProducto({
    tipoProducto: 'libro',
    nombreProducto: libroNorm,
    descripcionProducto: libroNorm
  });
  const libroDisplay =
    (prodResolved && prodResolved.nombre) ||
    libroNorm.replace(/^libro[-_]/i, '').replace(/[-_]+/g, ' ').trim();

  /* 2) Bloqueo (idempotencia real) */
  await withRetries(reqId, 'canjeRef.create', async () => {
    try {
      await canjeRef.create({
        nombre,
        apellidos,
        email: emailNorm,
        libro: libroDisplay,          // nombre legible
        libro_slug: prodResolved?.slug || libroNorm, // guardamos también el slug
        motivo: esRegalo ? 'REGALO' : 'ENTRADA',
        fecha: tsHuman,
        activado: false
      });
    } catch (e) {
      // Firestore: ALREADY_EXISTS -> tratar como ya canjeado
      if (e?.code === 6 || /already\s*exists/i.test(e?.message || '')) {
        throw new Error('Este código ya ha sido utilizado.');
      }
      try {
        await alertAdmin({
          area: 'regalos.canje.firestore_create_error',
          email: emailNorm,
          err: e,
          meta: { reqId, email: emailNorm, codigo: codigoNorm }
        });
      } catch (_) {}
      throw e;
    }
  }, { tries: 4, baseMs: 150 });
  L(reqId, 'Bloqueado en Firestore');

  /* 3) Registro en "Libros GRATIS" (no bloquea si falla) */
  (async () => {
    try {
      const sheets = await getSheets();
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID_REGALOS,
        range: `'${SHEET_NAME_REGALOS}'!A2:G`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[ nombre, apellidos, emailNorm, tsHuman, libroDisplay, esRegalo ? 'REGALO' : 'ENTRADA', codigoNorm ]] }
      });
    } catch (e) {
      W(reqId, 'Registro en "Libros GRATIS" falló', { msg: e?.message });
      try {
        await alertAdmin({
          area: 'regalos.canje.sheets_append_error',
          email: emailNorm,
          err: e,
          meta: { reqId, email: emailNorm, codigo: codigoNorm, libro: libroNorm, sheetId: SHEET_ID_REGALOS, sheetName: SHEET_NAME_REGALOS }
        });
      } catch (_) {}
    }
  })();

  /* 4) Activación MemberPress */
  try {
    let membershipId = null;
    let slugResuelto = null;

    // 1) Si viene override explícito, gana
    if (membershipIdOverride) {
      membershipId = Number(membershipIdOverride) || null;
    } else {
      // 2) Catálogo: intenta resolución completa por alias/nombre
      const prod = prodResolved || resolverProducto({
        tipoProducto: 'libro',
        nombreProducto: libroNorm,
        descripcionProducto: libroNorm
      });
      if (prod) {
        prodResolved = prod;
        slugResuelto = prod.slug;
        membershipId = Number(prod.memberpressId ?? prod.membership_id) || null;
      }
      // 3) Segundo intento: normalizador directo → slug → memberpressId
      if (!membershipId) {
        const slugGuess = normalizarProducto(libroNorm, 'libro');
        if (slugGuess) {
          slugResuelto = slugGuess;
          membershipId = Number(getMemberpressId(slugGuess)) || null;
        }
      }
      // 4) Último fallback: reglas legacy (backcompat)
      if (!membershipId) { // legacy
        const t = libroNorm.toLowerCase();
        if (t.includes('de cara a la jubilación')) membershipId = 7994;
        else if (t.includes('adelanta tu jubilación')) membershipId = 11006;
      }
    }

    if (!membershipId) throw new Error(`No se reconoce el libro para activar membresía: ${libroNorm}`);

    await activarMembresiaEnMemberPress(emailNorm, membershipId);
    await canjeRef.update({ activado: true, membershipId, slug: slugResuelto || null });
    L(reqId, 'MemberPress activado', { membershipId, slug: slugResuelto || undefined });
  } catch (err) {
    // No tiramos el canje: queda bloqueado y podremos activar manualmente
    E(reqId, 'Activación MP falló (canje bloqueado)', err);
    try {
      await alertAdmin({
        area: 'regalos.canje.memberpress_error',
        email: emailNorm,
        err,
        meta: { reqId, email: emailNorm, codigo: codigoNorm, libro: libroNorm }
      });
    } catch (_) {}
  }

  /* 5) Auxiliares (no bloqueantes) */
  (async () => {
    try { await registrarCanjeEnSheet({ nombre, apellidos, email: emailNorm, codigo: codigoNorm, libro: libroDisplay }); }
    catch (e) { W(reqId, 'Registro auxiliar en hoja falló', { msg: e?.message });
      try {
        await alertAdmin({
          area: 'regalos.canje.sheets_aux_error',
          email: emailNorm,
          err: e,
          meta: { reqId, email: emailNorm, codigo: codigoNorm, libro: libroDisplay }
        });
      } catch (_) {}
    }
  })();

  if (esRegalo) {
    (async () => {
      try { await marcarCodigoComoCanjeado(codigoNorm); }
      catch (e) { W(reqId, 'Marcar REG- como canjeado falló', { msg: e?.message });
        try {
          await alertAdmin({
            area: 'regalos.canje.marcar_reg_error',
            email: emailNorm,
            err: e,
            meta: { reqId, codigo: codigoNorm, email: emailNorm }
          });
        } catch (_) {}
      }
    })();
  }

  /* 6) Email (no bloquea) */
  (async () => {
    try {
      const r = await enviarEmailCanjeLibro({ toEmail: emailNorm, nombre, apellidos, libroElegido: libroDisplay });
      if (!r?.ok) W(reqId, 'Email de confirmación falló', { detalle: r?.error || '(sin detalle)' });
    } catch (e) { W(reqId, 'Excepción enviando email', { msg: e?.message }); }
  })();

  L(reqId, 'FIN', { ms: Date.now() - t0, codigo: maskCode(codigoNorm), email: maskEmail(emailNorm) });
  return { ok: true, reqId };
};
