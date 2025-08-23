// scripts/auditarClubSemanal.js
// Ejecuta manualmente: node scripts/auditarClubSemanal.js --mode=auto|weekly|monthly
// Un único cron diario (p.ej. 06,07,08 UTC). El script decide si toca enviar
// según Europe/Madrid: martes 09:00 → admin; día 1 09:00 → Ignacio.

const { google } = require('googleapis');
const admin = require('../firebase'); // inicialización Firebase Admin en tu proyecto
const firestore = admin.firestore();
// Lazy import para evitar warnings por dependencias circulares
// (no importamos hasta el momento de enviar)

// ───────────── Config ─────────────
const SHEET_COMPRAS_ID   = '1Mtffq42G7Q0y44ekzvy7IWPS8obvN4pNahA-08igdGk'; // Altas/Renovaciones (A:Nombre, B:Apellidos, C:DNI, D:Descripción, E:Importe, F:Fecha, G:Email)
const SHEET_BAJAS_ID     = '1qM9pM-qkPlR6yCeX7eC8i2wBWmAOI1WIDncf8I7pHMM'; // Bajas (A:Email, C:Fecha solicitud, D:Motivo, E:Fecha efectos, F:Prueba de desactivación)
const SHEET_TAB_DEFAULT  = 'Hoja 1';

const EMAIL_ADMIN   = 'laboroteca@gmail.com';
const EMAIL_IGNACIO = 'ignacio.solsona@icacs.com';

if (!process.env.GCP_CREDENTIALS_BASE64) throw new Error('❌ Falta GCP_CREDENTIALS_BASE64');
const credentials = JSON.parse(Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8'));
const sheetsAuth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });

// ───────────── Utilidades fecha/moneda ─────────────
const fmtEUR = (n) =>
  new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' })
    .format(Number(n || 0))
    .replace(/\u00A0/g, ' ');

function madridParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const Y = +parts.find(p => p.type === 'year').value;
  const M = +parts.find(p => p.type === 'month').value;
  const D = +parts.find(p => p.type === 'day').value;
  return { Y, M, D };
}
const ymd = (Y, M, D) => `${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
function dateFromYMD(Y, M, D) { return new Date(Date.UTC(Y, M - 1, D)); }
function ymdMadrid(date) { const { Y, M, D } = madridParts(date); return ymd(Y, M, D); }
function dmyMadrid(date) { const { Y, M, D } = madridParts(date); return `${String(D).padStart(2, '0')}/${String(M).padStart(2, '0')}/${Y}`; }

function previousMonSunRange() {
  const { Y, M, D } = madridParts(new Date());
  const todayUTC = dateFromYMD(Y, M, D);
  const dow = todayUTC.getUTCDay(); // 0=Dom..6=Sáb
  const mondayThisWeekUTC = new Date(todayUTC.getTime() - (((dow + 6) % 7) * 86400000));
  const mondayPrevUTC = new Date(mondayThisWeekUTC.getTime() - 7 * 86400000);
  const sundayPrevUTC = new Date(mondayPrevUTC.getTime() + 6 * 86400000);
  const sYMD = ymdMadrid(mondayPrevUTC);
  const eYMD = ymdMadrid(sundayPrevUTC);
  return { startYMD: sYMD, endYMD: eYMD, startDate: mondayPrevUTC, endDate: sundayPrevUTC };
}

function startOfMonthMadrid(d = new Date()) { const { Y, M } = madridParts(d); return dateFromYMD(Y, M, 1); }
function startOfYearMadrid(d = new Date()) { const { Y } = madridParts(d); return dateFromYMD(Y, 1, 1); }
function monthLabelESFrom(date = new Date()) {
  const { Y, M } = madridParts(date); const dd = dateFromYMD(Y, M, 1);
  return dd.toLocaleDateString('es-ES', { month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' });
}

// Parseo de fechas (ISO, dd/mm/yyyy, nº Excel, Timestamp Firestore)
function parseFechaCell(v) {
  if (!v) return null;
  if (typeof v === 'number') { const ms = Math.round(v * 86400000); return new Date(Date.UTC(1899, 11, 30) + ms); }
  if (typeof v === 'string') {
    const s = v.trim();
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m) { let Y = +m[3]; if (Y < 100) Y += 2000; return dateFromYMD(Y, +m[2], +m[1]); }
    const dISO = new Date(s); if (!isNaN(dISO)) return dISO;
    return null;
  }
  if (v && typeof v === 'object') {
    if (typeof v.toDate === 'function') return v.toDate(); // Firestore Timestamp
    if (v instanceof Date && !isNaN(v)) return v;
  }
  return null;
}
function inMadridWeekRange(d, startYMD, endYMD) { if (!d) return false; const s = ymdMadrid(d); return s >= startYMD && s <= endYMD; }
function inMadridRange(d, dStart, dEnd) {
  if (!d) return false;
  const s = parseInt(ymdMadrid(d).replace(/-/g, ''), 10);
  const a = parseInt(ymdMadrid(dStart).replace(/-/g, ''), 10);
  const b = parseInt(ymdMadrid(dEnd).replace(/-/g, ''), 10);
  return s >= a && s <= b;
}

// ───────────── Lectura SHEETS ─────────────
async function leerComprasSheet() {
  const client = await sheetsAuth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_COMPRAS_ID,
    range: `${SHEET_TAB_DEFAULT}!A2:K`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return (data.values || []).map(r => {
    const nombre = (r[0] || '').toString().trim(); // A
    const apellidos = (r[1] || '').toString().trim(); // B
    const desc = (r[3] || '').toString().trim();   // D
    const imp = r[4];                               // E
    const fec = r[5];                               // F
    const email = (r[6] || '').toString().trim().toLowerCase(); // G
    return { nombre, apellidos, email, desc, importe: numberFromImporte(imp), fecha: parseFechaCell(fec) };
  }).filter(x => x.desc && x.fecha);
}
async function leerBajasSheet() {
  const client = await sheetsAuth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_BAJAS_ID,
    range: `${SHEET_TAB_DEFAULT}!A2:F`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return (data.values || []).map(r => {
    const email = (r[0] || '').toString().trim().toLowerCase();
    const fechaSolicitud = parseFechaCell(r[2]); // C
    const motivo = (r[3] || '').toString().trim(); // D
    const fechaEfectos = parseFechaCell(r[4]);   // E
    const verificacion = (r[5] || '').toString().trim(); // F
    return { email, fechaSolicitud, motivo, fechaEfectos, verificacion };
  }).filter(x => x.email && x.fechaSolicitud);
}
function numberFromImporte(v) {
  if (typeof v === 'number') return v;
  if (!v) return 0;
  const n = Number(String(v).trim().replace(/[€\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

// ───────────── Lectura FIREBASE ─────────────
// usuariosClub: { email, nombre, apellidos, activo, fechaAlta, ultimaRenovacion, fechaBaja, ... }
async function leerUsuariosClub() {
  const snap = await firestore.collection('usuariosClub').get();
  const out = [];
  snap.forEach(doc => {
    const d = doc.data() || {};
    out.push({
      email: (d.email || doc.id || '').toString().trim().toLowerCase(),
      nombre: (d.nombre || '').toString().trim(),
      apellidos: (d.apellidos || '').toString().trim(),
      activo: typeof d.activo === 'boolean' ? d.activo : undefined,
      fechaAlta: parseFechaCell(d.fechaAlta),
      ultimaRenovacion: parseFechaCell(d.ultimaRenovacion),
      fechaBaja: parseFechaCell(d.fechaBaja),
    });
  });
  return out;
}
// bajasClubLog: detalle bajas
async function leerBajasClubLog() {
  const snap = await firestore.collection('bajasClubLog').get().catch(() => null);
  if (!snap) return [];
  const out = [];
  snap.forEach(doc => {
    const d = doc.data() || {};
    const email = (d.email || d.usuarioEmail || d.userEmail || '').toString().trim().toLowerCase();
    const fechaSolicitud = parseFechaCell(d.fechaSolicitud || d.fechaSolicitudISO || d.fechaSolicitudTS);
    const motivo = (d.motivo || d.reason || '').toString().trim();
    const fechaEfectos = parseFechaCell(d.fechaEfectos || d.fechaEfectosISO || d.fechaEfectosTS);
    const verificacion = (d.verificacion || d.status || '').toString().trim();
    if (email && fechaSolicitud) out.push({ email, fechaSolicitud, motivo, fechaEfectos, verificacion });
  });
  return out;
}
// facturas: para € de altas/renovaciones (ideal con email)
async function leerFacturasClub() {
  const snap = await firestore.collection('facturas').get();
  const out = [];
  snap.forEach(doc => {
    const d = doc.data() || {};
    const desc = (d.descripcionProducto || d.descripcion || '').toString().trim();
    if (!/Club Laboroteca/i.test(desc)) return; // solo club
    const fecha = parseFechaCell(d.fecha || d.fechaISO || d.fechaTexto || d.fechaTS);
    const importe = typeof d.importeTotalIVA === 'number' ? d.importeTotalIVA : numberFromImporte(d.importeTotalIVA);
    const email = (d.email || d.userEmail || d.correo || '').toString().trim().toLowerCase();
    out.push({ email, desc, fecha, importe });
  });
  return out;
}

// ───────────── Agregados ─────────────
const isAlta = (d) => /Alta y primera cuota Club Laboroteca/i.test(d || '');
const isRenov = (d) => /Renovación mensual Club Laboroteca/i.test(d || '');

function sumarSemanaCompras(rows, startYMD, endYMD, tipo) {
  const filtro = tipo === 'alta' ? (r) => isAlta(r.desc) : (r) => isRenov(r.desc);
  let count = 0, total = 0;
  for (const r of rows) {
    if (!filtro(r)) continue;
    if (inMadridWeekRange(r.fecha, startYMD, endYMD)) { count++; total += Number(r.importe || 0); }
  }
  return { count, total };
}
function sumarSemanaFacturas(facturas, startYMD, endYMD, tipo) {
  const filtro = tipo === 'alta' ? (f) => isAlta(f.desc) : (f) => isRenov(f.desc);
  let count = 0, total = 0;
  for (const f of facturas) {
    if (!filtro(f)) continue;
    if (inMadridWeekRange(f.fecha, startYMD, endYMD)) { count++; total += Number(f.importe || 0); }
  }
  return { count, total };
}
function bajasEnSemana(list, startYMD, endYMD) {
  return list.filter((b) => inMadridWeekRange(b.fechaSolicitud, startYMD, endYMD));
}
function totalesEnRango_Sheets(rowsCompras, rowsBajas, dStart, dEnd) {
  const a = rowsCompras.filter((r) => isAlta(r.desc) && inMadridRange(r.fecha, dStart, dEnd));
  const r = rowsCompras.filter((r) => isRenov(r.desc) && inMadridRange(r.fecha, dStart, dEnd));
  const b = rowsBajas.filter((x) => inMadridRange(x.fechaSolicitud, dStart, dEnd));
  return {
    altas: { count: a.length, total: a.reduce((s, x) => s + Number(x.importe || 0), 0) },
    renov: { count: r.length, total: r.reduce((s, x) => s + Number(x.importe || 0), 0) },
    bajas: { count: b.length },
  };
}
function totalesEnRango_Firebase(usuarios, facturas, bajasLog, dStart, dEnd) {
  const altas = facturas.filter((f) => isAlta(f.desc) && inMadridRange(f.fecha, dStart, dEnd));
  const renov = facturas.filter((f) => isRenov(f.desc) && inMadridRange(f.fecha, dStart, dEnd));
  const bajasBase = (bajasLog.length
    ? bajasLog
    : usuarios.map((u) => ({ fechaSolicitud: u.fechaBaja, email: u.email, motivo: '', fechaEfectos: null, verificacion: '' })));
  const bajas = bajasBase.filter((b) => inMadridRange(b.fechaSolicitud, dStart, dEnd));
  return {
    altas: { count: altas.length, total: altas.reduce((s, x) => s + Number(x.importe || 0), 0) },
    renov: { count: renov.length, total: renov.reduce((s, x) => s + Number(x.importe || 0), 0) },
    bajas: { count: bajas.length },
  };
}

// Activos a una fecha (DD/MM/AAAA)
function activosFirebase(usuarios, atDate) {
  return usuarios.filter((u) => {
    const altaOK = u.fechaAlta && u.fechaAlta <= atDate;
    const bajaOK = !u.fechaBaja || u.fechaBaja > atDate;
    const activeFlagOK = (typeof u.activo === 'boolean') ? u.activo : true;
    return altaOK && bajaOK && activeFlagOK;
  }).length;
}
function activosSheets(rowsCompras, rowsBajas, atDate) {
  const emailsConPago = new Set(
    rowsCompras
      .filter((r) => (isAlta(r.desc) || isRenov(r.desc)) && r.fecha && r.fecha <= atDate && r.email)
      .map((r) => r.email)
  );
  rowsBajas.forEach((b) => {
    const f = b.fechaEfectos || b.fechaSolicitud;
    if (f && f <= atDate) emailsConPago.delete((b.email || '').toLowerCase());
  });
  return emailsConPago.size;
}

// Miembros más antiguos (Top 10)
function miembrosAntiguosSheets(rowsCompras, atDate) {
  const mp = new Map(); // email -> {nombre, email, fechaAlta, renov, total}
  for (const r of rowsCompras) {
    if (!r.email) continue;
    if (!(isAlta(r.desc) || isRenov(r.desc))) continue;
    if (!r.fecha || r.fecha > atDate) continue;

    const it = mp.get(r.email) || { nombre: r.nombre || '', email: r.email, fechaAlta: null, renov: 0, total: 0 };
    if (isAlta(r.desc)) it.fechaAlta = it.fechaAlta ? (it.fechaAlta <= r.fecha ? it.fechaAlta : r.fecha) : r.fecha;
    if (isRenov(r.desc)) it.renov += 1;
    it.total += Number(r.importe || 0);
    mp.set(r.email, it);
  }
  return Array.from(mp.values())
    .filter((x) => x.fechaAlta)
    .sort((a, b) => a.fechaAlta - b.fechaAlta)
    .slice(0, 10);
}
function miembrosAntiguosFirebase(usuarios, facturas, atDate) {
  // index facturas por email
  const byEmail = new Map();
  for (const f of facturas) {
    if (!f.email) continue;
    if (!f.fecha || f.fecha > atDate) continue;
    const it = byEmail.get(f.email) || { renov: 0, total: 0 };
    if (isRenov(f.desc)) it.renov += 1;
    it.total += Number(f.importe || 0);
    byEmail.set(f.email, it);
  }
  const out = [];
  for (const u of usuarios) {
    if (!u.email || !u.fechaAlta || u.fechaAlta > atDate) continue;
    const agg = byEmail.get(u.email) || { renov: 0, total: 0 };
    out.push({
      nombre: `${u.nombre || ''} ${u.apellidos || ''}`.trim(),
      email: u.email,
      fechaAlta: u.fechaAlta,
      renov: agg.renov,
      total: agg.total,
    });
  }
  return out.sort((a, b) => a.fechaAlta - b.fechaAlta).slice(0, 10);
}

// Alta posterior a una baja
function anotarAltaPosteriorSheets(bajas, rowsCompras) {
  const byEmailAltas = new Map();
  for (const r of rowsCompras) {
    if (r.email && isAlta(r.desc)) {
      const arr = byEmailAltas.get(r.email) || [];
      arr.push(r.fecha);
      byEmailAltas.set(r.email, arr);
    }
  }
  return bajas.map((b) => {
    const fechas = byEmailAltas.get((b.email || '').toLowerCase()) || [];
    const corte = b.fechaEfectos || b.fechaSolicitud;
    const posterior = fechas.filter((f) => f && corte && f > corte).sort((a, bb) => a - bb)[0] || null;
    return { ...b, altaPosterior: posterior };
  });
}
function anotarAltaPosteriorFirebase(bajas, facturas) {
  const byEmailAltas = new Map();
  for (const f of facturas) {
    if (f.email && isAlta(f.desc)) {
      const arr = byEmailAltas.get(f.email) || [];
      arr.push(f.fecha);
      byEmailAltas.set(f.email, arr);
    }
  }
  return bajas.map((b) => {
    const fechas = byEmailAltas.get((b.email || '').toLowerCase()) || [];
    const corte = b.fechaEfectos || b.fechaSolicitud;
    const posterior = fechas.filter((f) => f && corte && f > corte).sort((a, bb) => a - bb)[0] || null;
    return { ...b, altaPosterior: posterior };
  });
}

// Serie semanal (últimos 12 meses ≈ 52 semanas)
function semanasDesde(n = 52) {
  const arr = [];
  const { startDate } = previousMonSunRange(); // lunes pasado
  let curStart = new Date(startDate.getTime());
  for (let i = 0; i < n; i++) {
    const s = new Date(curStart.getTime() - (i * 7 * 86400000));
    const e = new Date(s.getTime() + 6 * 86400000);
    arr.push({ start: s, end: e, startYMD: ymdMadrid(s), endYMD: ymdMadrid(e), label: `${dmyMadrid(s)}→${dmyMadrid(e)}` });
  }
  return arr.reverse();
}
function serieSemanalCounts(source, type) {
  const weeks = semanasDesde();
  return weeks.map((w) => {
    let a = 0, r = 0, b = 0;
    if (type === 'sheets') {
      const t = totalesEnRango_Sheets(source.rowsCompras, source.rowsBajas, w.start, w.end);
      a = t.altas.count; r = t.renov.count; b = t.bajas.count;
    } else {
      const t = totalesEnRango_Firebase(source.usuarios, source.facturas, source.bajasLog, w.start, w.end);
      a = t.altas.count; r = t.renov.count; b = t.bajas.count;
    }
    return { week: w, altas: a, renov: r, bajas: b };
  });
}

// ───────────── HTML helpers ─────────────
function htmlNote() {
  return `<p style="color:#c62828;font-weight:bold;margin:0 0 12px;">
    NOTA: Recuerda verificar la desactivación efectiva de las membresías, más abajo tienes el listado de bajas.
  </p>`;
}
function tableKV(rows) {
  if (!rows.length) return '<p>Sin datos.</p>';
  const tr = rows.map((r) => `<tr>
    <td style="padding:6px 8px;border:1px solid #ddd;">${r.k}</td>
    <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${r.v}</td>
  </tr>`).join('');
  return `<table role="table" cellpadding="0" cellspacing="0" style="border-collapse:collapse;min-width:420px;">
    <tbody>${tr}</tbody></table>`;
}
function tableBajas(list) {
  const head = `<tr>
    <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Email</th>
    <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Fecha solicitud</th>
    <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Motivo</th>
    <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Fecha efectos</th>
    <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Verificación</th>
    <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Alta posterior</th>
  </tr>`;
  const body = (list.length ? list : [{ email: '—', fechaSolicitud: null, motivo: '—', fechaEfectos: null, verificacion: '—', altaPosterior: null }])
    .map((b) => `<tr>
      <td style="padding:6px 8px;border:1px solid #ddd;">${b.email || '—'}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${b.fechaSolicitud ? dmyMadrid(b.fechaSolicitud) : '—'}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${b.motivo || '—'}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${b.fechaEfectos ? dmyMadrid(b.fechaEfectos) : '—'}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${b.verificacion || '—'}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${b.altaPosterior ? `Sí: ${dmyMadrid(b.altaPosterior)}` : 'No'}</td>
    </tr>`).join('');
  return `<table role="table" cellpadding="0" cellspacing="0" style="border-collapse:collapse;min-width:740px;">
    <thead>${head}</thead><tbody>${body}</tbody></table>`;
}
function barsHorizontal(items) {
  const max = Math.max(...items.map((i) => i.value), 1);
  const rows = items.map((i) => {
    const w = Math.round((i.value / max) * 100);
    return `<div style="display:flex;align-items:center;margin:6px 0;">
      <div style="flex:1;background:#e5e7eb;height:18px;position:relative;">
        <div title="${i.label}: ${i.value}" style="width:${w}%;height:100%;background:#4F46E5;"></div>
      </div>
      <div style="width:56px;text-align:right;margin-left:8px;">${i.value}</div>
      <div style="margin-left:8px;white-space:nowrap;">${i.label}</div>
    </div>`;
  }).join('');
  return `<div style="max-width:740px;">${rows}</div>`;
}
function lineChartWeekly(serie) {
  const H = 180, W = 740, P = 30;
  const xs = serie.map((_, i) => P + i * ((W - 2 * P) / Math.max(1, serie.length - 1)));
  const max = Math.max(...serie.flatMap((s) => [s.altas, s.renov, s.bajas]), 1);
  const y = (v) => H - P - (v / max) * (H - 2 * P);
  const poly = (arr) => arr.map((v, i) => `${xs[i]},${y(v)}`).join(' ');
  const grid = Array.from({ length: 5 }, (_, k) => {
    const yy = P + k * ((H - 2 * P) / 4);
    return `<line x1="${P}" y1="${yy}" x2="${W - P}" y2="${yy}" stroke="#eee"/>`;
  }).join('');
  const labels = xs.map((x, i) =>
    i % 6 === 0 ? `<text x="${x}" y="${H - 6}" font-size="10" text-anchor="middle">${dmyMadrid(serie[i].week.start)}</text>` : ''
  ).join('');
  return `
  <svg width="${W}" height="${H}">
    ${grid}
    <polyline fill="none" stroke="#1f77b4" stroke-width="2" points="${poly(serie.map((s) => s.altas))}"/>
    <polyline fill="none" stroke="#2ca02c" stroke-width="2" points="${poly(serie.map((s) => s.renov))}"/>
    <polyline fill="none" stroke="#d62728" stroke-width="2" points="${poly(serie.map((s) => s.bajas))}"/>
    ${labels}
  </svg>
  <div style="font-size:12px;margin-top:6px;">Altas=<span style="color:#1f77b4">━</span> · Renov=<span style="color:#2ca02c">━</span> · Bajas=<span style="color:#d62728">━</span></div>
  `;
}

// Tabla miembros antiguos
function tableAntiguos(rows, mostrarApellidos) {
  const head = `<tr>
    <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">${mostrarApellidos ? 'Nombre y apellidos' : 'Nombre'}</th>
    <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Email</th>
    <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Fecha de alta</th>
    <th style="text-align:right;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Renovaciones</th>
    <th style="text-align:right;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Total facturado</th>
  </tr>`;
  const body = (rows.length ? rows : [])
    .map((r) => `<tr>
      <td style="padding:6px 8px;border:1px solid #ddd;">${r.nombre || '—'}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${r.email || '—'}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${r.fechaAlta ? dmyMadrid(r.fechaAlta) : '—'}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${r.renov ?? 0}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${fmtEUR(r.total ?? 0)}</td>
    </tr>`).join('');
  return `<table role="table" cellpadding="0" cellspacing="0" style="border-collapse:collapse;min-width:740px;">
    <thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// Banner de activos
function bannerActivos(textoFuenteColor, activos, fechaInformeDMY) {
  const [texto, color] = textoFuenteColor; // ['FIREBASE','#c62828'] o ['GOOGLE SHEETS','#188038']
  return `<div style="font-size:24px;font-weight:900;margin:8px 0 6px;letter-spacing:.4px;text-transform:uppercase;">
    ${activos} MIEMBROS ACTIVOS EN FECHA ${fechaInformeDMY}
  </div>
  <div style="font-size:16px;margin:10px 0 4px;">según <span style="color:${color};font-weight:bold;">${texto}</span></div>`;
}

// Sección por fuente
function seccionFuente({
  label, color, semanaLbl, weekStats, bajasDetalleSemana, barrasMes, barrasAnio, serie12m,
  listado6Semanas, activos, fechaInformeDMY, antiguos, mostrarApellidos
}) {
  const kv = [
    { k: `Semana ${semanaLbl} — Nuevas altas (cantidad / importe)`, v: `${weekStats.altas.count} / ${fmtEUR(weekStats.altas.total)}` },
    { k: `Semana ${semanaLbl} — Renovaciones (cantidad / importe)`, v: `${weekStats.renov.count} / ${fmtEUR(weekStats.renov.total)}` },
    { k: `Semana ${semanaLbl} — Bajas (cantidad)`, v: `${weekStats.bajas.count}` },
  ];
  return `
    ${bannerActivos([label, color], activos, fechaInformeDMY)}
    ${tableKV(kv)}
    <h3 style="margin:16px 0 6px;">Desglose de bajas de la semana</h3>
    ${tableBajas(bajasDetalleSemana)}
    <h3 style="margin:16px 0 6px;">Mes en curso — barras horizontales</h3>
    ${barsHorizontal(barrasMes)}
    <h3 style="margin:16px 0 6px;">Año ${madridParts().Y} — barras horizontales</h3>
    ${barsHorizontal(barrasAnio)}
    <h3 style="margin:16px 0 6px;">Evolución semanal — últimos 12 meses</h3>
    ${lineChartWeekly(serie12m)}
    <h3 style="margin:16px 0 6px;">Listado de bajas — últimas 6 semanas</h3>
    ${tableBajas(listado6Semanas)}
    <h3 style="margin:16px 0 6px;">Miembros más antiguos (Top 10)</h3>
    ${tableAntiguos(antiguos, mostrarApellidos)}
  `;
}

// ───────────── Lógica de envío (auto/weekly/monthly) ─────────────
function getMode() {
  const arg = process.argv.find((a) => a.startsWith('--mode='));
  return arg ? arg.split('=')[1] : 'auto';
}
function whatToSendNow() {
  const now = new Date();
  const hour = Number(new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', hour12: false }).format(now));
  const day = Number(new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', day: '2-digit' }).format(now));
  const weekday = new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long' }).format(now).toLowerCase();
  const isTuesday = weekday.startsWith('martes');
  return { weekly: hour === 9 && isTuesday, monthly: hour === 9 && day === 1 };
}
async function enviarInforme({ html, subject }) {
  if (!process.env.SMTP2GO_API_KEY || !process.env.SMTP2GO_FROM_EMAIL) {
    console.log('ℹ️ SMTP2GO no configurado; no se envía email.');
    return;
  }
  const mode = getMode();
  const send = whatToSendNow();
  if (mode === 'weekly' && !send.weekly) return console.log('⏱️ No toca (weekly).');
  if (mode === 'monthly' && !send.monthly) return console.log('⏱️ No toca (monthly).');
  if (mode === 'auto' && !send.weekly && !send.monthly) return console.log('⏱️ No toca (auto).');

  if (mode === 'weekly' || (mode === 'auto' && send.weekly)) {
    await enviarEmailPersonalizado({ to: EMAIL_ADMIN, subject, html, text: 'Informe semanal del Club' });
  }
  if (mode === 'monthly' || (mode === 'auto' && send.monthly)) {
    await enviarEmailPersonalizado({ to: EMAIL_IGNACIO, subject, html, text: 'Informe mensual del Club' });
  }
}

// ───────────── Runner ─────────────
(async () => {
  try {
    console.log('🚀 Auditoría semanal Club — inicio');
    console.log('   Modo:', getMode());

    // Lecturas
    const [rowsCompras, rowsBajasSheet, usuarios, bajasLog, facturas] = await Promise.all([
      leerComprasSheet(),
      leerBajasSheet(),
      leerUsuariosClub(),
      leerBajasClubLog(),
      leerFacturasClub(),
    ]);

    // Semana objetivo (cerrada anterior)
    const rng = previousMonSunRange();
    const { startYMD, endYMD, endDate } = { startYMD: rng.startYMD, endYMD: rng.endYMD, endDate: rng.endDate };
    const semanaLbl = `${dmyMadrid(dateFromYMD(...startYMD.split('-').map(Number)))} → ${dmyMadrid(dateFromYMD(...endYMD.split('-').map(Number)))}`;
    const fechaInformeDMY = dmyMadrid(endDate); // domingo de la semana cerrada

    // ── SHEETS: semana
    const shAlt = sumarSemanaCompras(rowsCompras, startYMD, endYMD, 'alta');
    const shRen = sumarSemanaCompras(rowsCompras, startYMD, endYMD, 'renov');
    let shBajasSemana = bajasEnSemana(rowsBajasSheet, startYMD, endYMD);
    shBajasSemana = anotarAltaPosteriorSheets(shBajasSemana, rowsCompras);
    const weekStatsSH = { altas: shAlt, renov: shRen, bajas: { count: shBajasSemana.length } };

    // ── FIREBASE: semana
    const fbAlt = sumarSemanaFacturas(facturas, startYMD, endYMD, 'alta');
    const fbRen = sumarSemanaFacturas(facturas, startYMD, endYMD, 'renov');
    const baseBajasFB = (bajasLog.length
      ? bajasLog
      : usuarios.map((u) => ({ email: u.email, fechaSolicitud: u.fechaBaja, motivo: '', fechaEfectos: null, verificacion: '' })));
    let fbBajasSemana = baseBajasFB.filter((b) => inMadridWeekRange(b.fechaSolicitud, startYMD, endYMD));
    fbBajasSemana = anotarAltaPosteriorFirebase(fbBajasSemana, facturas);
    const weekStatsFB = { altas: fbAlt, renov: fbRen, bajas: { count: fbBajasSemana.length } };

    // Activos a fecha de informe
    const activosSH = activosSheets(rowsCompras, rowsBajasSheet, endDate);
    const activosFB = activosFirebase(usuarios, endDate);

    // Mes en curso
    const dStartMes = startOfMonthMadrid();
    const dEndMes = new Date();
    const barrasMesSH = (() => { const t = totalesEnRango_Sheets(rowsCompras, rowsBajasSheet, dStartMes, dEndMes);
      return [{ label: 'Nuevas altas', value: t.altas.count }, { label: 'Renovaciones', value: t.renov.count }, { label: 'Bajas', value: t.bajas.count }];})();
    const barrasMesFB = (() => { const t = totalesEnRango_Firebase(usuarios, facturas, baseBajasFB, dStartMes, dEndMes);
      return [{ label: 'Nuevas altas', value: t.altas.count }, { label: 'Renovaciones', value: t.renov.count }, { label: 'Bajas', value: t.bajas.count }];})();

    // Año en curso
    const dStartYear = startOfYearMadrid();
    const barrasAnioSH = (() => { const t = totalesEnRango_Sheets(rowsCompras, rowsBajasSheet, dStartYear, dEndMes);
      return [{ label: 'Nuevas altas', value: t.altas.count }, { label: 'Renovaciones', value: t.renov.count }, { label: 'Bajas', value: t.bajas.count }];})();
    const barrasAnioFB = (() => { const t = totalesEnRango_Firebase(usuarios, facturas, baseBajasFB, dStartYear, dEndMes);
      return [{ label: 'Nuevas altas', value: t.altas.count }, { label: 'Renovaciones', value: t.renov.count }, { label: 'Bajas', value: t.bajas.count }];})();

    // Serie semanal 12 últimos meses (≈52 semanas)
    const serieSH = serieSemanalCounts({ rowsCompras, rowsBajas: rowsBajasSheet }, 'sheets');
    const serieFB = serieSemanalCounts({ usuarios, facturas, bajasLog: baseBajasFB }, 'firebase');

    // Listado últimas 6 semanas (por fuente) + “Alta posterior”
    const last6Weeks = semanasDesde().slice(-6);
    const lista6SH = last6Weeks.flatMap((w) => {
      const sem = bajasEnSemana(rowsBajasSheet, w.startYMD, w.endYMD);
      return anotarAltaPosteriorSheets(sem, rowsCompras);
    });
    const lista6FB = last6Weeks.flatMap((w) => {
      const sem = baseBajasFB.filter((b) => inMadridWeekRange(b.fechaSolicitud, w.startYMD, w.endYMD));
      return anotarAltaPosteriorFirebase(sem, facturas);
    });

    // Miembros antiguos (Top 10)
    const antiguosSH = miembrosAntiguosSheets(rowsCompras, endDate).map((x) => ({ ...x, nombre: x.nombre || '—' }));
    const antiguosFB = miembrosAntiguosFirebase(usuarios, facturas, endDate);

    // HTML final
    const monthLabel = monthLabelESFrom(new Date());
    const titulo = `📊 Informe semanal Club ${dmyMadrid(dateFromYMD(...startYMD.split('-').map(Number)))} → ${dmyMadrid(dateFromYMD(...endYMD.split('-').map(Number)))} — Mes ${monthLabel}`;
    const html =
`<div style="font-family:Arial, sans-serif; font-size:14px; color:#333;">
  ${htmlNote()}

  <h2 style="margin:18px 0 10px 0;font-size:20px;">Informe del Club — según <span style="color:#c62828;font-weight:bold;">FIREBASE</span></h2>
  ${seccionFuente({
    label: 'FIREBASE', color: '#c62828', semanaLbl,
    weekStats: weekStatsFB,
    bajasDetalleSemana: fbBajasSemana,
    barrasMes: barrasMesFB,
    barrasAnio: barrasAnioFB,
    serie12m: serieFB,
    listado6Semanas: lista6FB,
    activos: activosFB,
    fechaInformeDMY,
    antiguos: antiguosFB.map((a) => ({ ...a, nombre: a.nombre })), // nombre+apellidos ya combinados
    mostrarApellidos: true
  })}

  <hr style="margin:28px 0;border:none;border-top:1px solid #eee;">

  <h2 style="margin:18px 0 10px 0;font-size:20px;">Informe del Club — según <span style="color:#188038;font-weight:bold;">GOOGLE SHEETS</span></h2>
  ${seccionFuente({
    label: 'GOOGLE SHEETS', color: '#188038', semanaLbl,
    weekStats: weekStatsSH,
    bajasDetalleSemana: shBajasSemana,
    barrasMes: barrasMesSH,
    barrasAnio: barrasAnioSH,
    serie12m: serieSH,
    listado6Semanas: lista6SH,
    activos: activosSH,
    fechaInformeDMY,
    antiguos: antiguosSH, // solo nombre (columna A)
    mostrarApellidos: false
  })}
</div>`;

    await enviarInforme({ html, subject: titulo });

    console.log('✅ Auditoría semanal Club — fin');
  } catch (e) {
    console.error('❌ Error auditoría semanal Club:', e.stack || e.message || e);
    process.exit(1);
  }
})();
