// scripts/auditarClubSemanal.js
// Ejecuta: node scripts/auditarClubSemanal.js
// Envía email con informe semanal del Club: FIREBASE (rojo) y GOOGLE SHEETS (verde)

const { google } = require('googleapis');
const admin = require('../firebase');                 // tu inicialización de Firebase Admin
const firestore = admin.firestore();
const { enviarEmailPersonalizado } = require('../services/email');

// ───────────── Config ─────────────
const SHEET_COMPRAS_ID   = '1Mtffq42G7Q0y44ekzvy7IWPS8obvN4pNahA-08igdGk'; // Altas/Renovaciones
const SHEET_BAJAS_ID     = '1qM9pM-qkPlR6yCeX7eC8i2wBWmAOI1WIDncf8I7pHMM'; // Bajas
const SHEET_TAB_DEFAULT  = 'Hoja 1';

const EMAIL_ADMIN   = 'laboroteca@gmail.com';
const EMAIL_IGNACIO = 'ignacio.solsona@icacs.com';

if (!process.env.GCP_CREDENTIALS_BASE64) throw new Error('❌ Falta GCP_CREDENTIALS_BASE64');
const credentials = JSON.parse(Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64').toString('utf8'));
const sheetsAuth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });

// ───────────── Utilidades de fecha/moneda ─────────────
const fmtEUR = n => new Intl.NumberFormat('es-ES', { style:'currency', currency:'EUR' })
  .format(Number(n||0)).replace(/\u00A0/g,' ');

function madridParts(d=new Date()) {
  const parts = new Intl.DateTimeFormat('es-ES',{ timeZone:'Europe/Madrid', year:'numeric', month:'2-digit', day:'2-digit', weekday:'short'}).formatToParts(d);
  const Y = +parts.find(p=>p.type==='year').value;
  const M = +parts.find(p=>p.type==='month').value;
  const D = +parts.find(p=>p.type==='day').value;
  return {Y,M,D};
}
const ymd = (Y,M,D)=>`${Y}-${String(M).padStart(2,'0')}-${String(D).padStart(2,'0')}`;

function dateFromYMD(Y,M,D){ return new Date(Date.UTC(Y, M-1, D)); }
function ymdMadrid(date){ const {Y,M,D} = madridParts(date); return ymd(Y,M,D); }

function previousMonSunRange() {
  const {Y,M,D} = madridParts(new Date());
  const todayUTC = dateFromYMD(Y,M,D);
  const dow = todayUTC.getUTCDay(); // 0=Dom..6=Sáb
  const mondayThisWeekUTC = new Date(todayUTC.getTime() - (((dow+6)%7)*86400000));
  const mondayPrevUTC = new Date(mondayThisWeekUTC.getTime() - 7*86400000);
  const sundayPrevUTC = new Date(mondayPrevUTC.getTime() + 6*86400000);
  const sYMD = ymdMadrid(mondayPrevUTC);
  const eYMD = ymdMadrid(sundayPrevUTC);
  return { startYMD:sYMD, endYMD:eYMD, startDate:mondayPrevUTC, endDate:sundayPrevUTC };
}

function startOfMonthMadrid(d=new Date()){
  const {Y,M} = madridParts(d); return dateFromYMD(Y,M,1);
}
function startOfYearMadrid(d=new Date()){
  const {Y} = madridParts(d); return dateFromYMD(Y,1,1);
}
function monthLabelESFrom(date){
  const {Y,M}=madridParts(date); const dd = dateFromYMD(Y,M,1);
  return dd.toLocaleDateString('es-ES',{month:'long',year:'numeric', timeZone:'Europe/Madrid'});
}

// Parseo robusto de fechas variadas (ISO, dd/mm/yyyy, número de Excel, Timestamp)
function parseFechaCell(v){
  if (!v) return null;
  if (typeof v==='number'){ // serial Excel
    const ms = Math.round(v*86400000); const date = new Date(Date.UTC(1899,11,30)+ms);
    return date;
  }
  if (typeof v==='string'){
    const s=v.trim();
    let m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (m){ let Y=+m[3]; if (Y<100) Y+=2000; return dateFromYMD(Y,+m[2],+m[1]); }
    const dISO = new Date(s); if(!isNaN(dISO)) return dISO;
    return null;
  }
  if (v && typeof v==='object'){
    if (typeof v.toDate==='function') return v.toDate();  // Firestore Timestamp
    if (v instanceof Date && !isNaN(v)) return v;
  }
  return null;
}
function inMadridWeekRange(d, startYMD, endYMD){
  if (!d) return false;
  const s = ymdMadrid(d);
  return (s>=startYMD && s<=endYMD);
}
function inMadridRange(d, dStart, dEnd){
  if (!d) return false;
  const s = parseInt(ymdMadrid(d).replace(/-/g,''),10);
  const a = parseInt(ymdMadrid(dStart).replace(/-/g,''),10);
  const b = parseInt(ymdMadrid(dEnd).replace(/-/g,''),10);
  return s>=a && s<=b;
}

// ───────────── Lectura SHEETS ─────────────
async function leerComprasSheet() {
  const client = await sheetsAuth.getClient();
  const sheets = google.sheets({version:'v4', auth:client});
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_COMPRAS_ID,
    range: `${SHEET_TAB_DEFAULT}!A2:K`,
    valueRenderOption:'UNFORMATTED_VALUE',
  });
  return (data.values||[]).map(r=>{
    const desc = (r[3]||'').toString().trim();   // D
    const imp  = r[4];                           // E
    const fec  = r[5];                           // F
    return { desc, importe: numberFromImporte(imp), fecha: parseFechaCell(fec) };
  }).filter(x=>x.desc && x.fecha);
}
async function leerBajasSheet() {
  const client = await sheetsAuth.getClient();
  const sheets = google.sheets({version:'v4', auth:client});
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_BAJAS_ID,
    range: `${SHEET_TAB_DEFAULT}!A2:F`,
    valueRenderOption:'UNFORMATTED_VALUE',
  });
  return (data.values||[]).map(r=>{
    const email = (r[0]||'').toString().trim();
    const fechaSolicitud = parseFechaCell(r[2]); // C
    const motivo = (r[3]||'').toString().trim(); // D
    const fechaEfectos = parseFechaCell(r[4]);   // E
    const verificacion = (r[5]||'').toString().trim(); // F
    return { email, fechaSolicitud, motivo, fechaEfectos, verificacion };
  }).filter(x=>x.email && x.fechaSolicitud);
}
function numberFromImporte(v){
  if (typeof v==='number') return v;
  if (!v) return 0;
  const n = Number(String(v).trim().replace(/[€\s]/g,'').replace(/\.(?=\d{3}(\D|$))/g,'').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

// ───────────── Lectura FIREBASE ─────────────
// usuariosClub: { email, fechaAlta, ultimaRenovacion, fechaBaja, ... }
async function leerUsuariosClub(){
  const snap = await firestore.collection('usuariosClub').get();
  const out=[];
  snap.forEach(doc=>{
    const d=doc.data()||{};
    out.push({
      email: (d.email||doc.id||'').toString().trim().toLowerCase(),
      fechaAlta: parseFechaCell(d.fechaAlta),
      ultimaRenovacion: parseFechaCell(d.ultimaRenovacion),
      fechaBaja: parseFechaCell(d.fechaBaja),
    });
  });
  return out;
}
// bajasClubLog: detalle bajas
async function leerBajasClubLog(){
  const snap = await firestore.collection('bajasClubLog').get().catch(()=>null);
  if (!snap) return [];
  const out=[];
  snap.forEach(doc=>{
    const d=doc.data()||{};
    const email = (d.email || d.usuarioEmail || d.userEmail || '').toString().trim();
    const fechaSolicitud = parseFechaCell(d.fechaSolicitud || d.fechaSolicitudISO || d.fechaSolicitudTS);
    const motivo = (d.motivo || d.reason || '').toString().trim();
    const fechaEfectos = parseFechaCell(d.fechaEfectos || d.fechaEfectosISO || d.fechaEfectosTS);
    const verificacion = (d.verificacion || d.status || '').toString().trim();
    if (email && fechaSolicitud) out.push({ email, fechaSolicitud, motivo, fechaEfectos, verificacion });
  });
  return out;
}
// facturas: para € de altas/renovaciones
async function leerFacturasClub(){
  const snap = await firestore.collection('facturas').get();
  const out=[];
  snap.forEach(doc=>{
    const d=doc.data()||{};
    const desc = (d.descripcionProducto || d.descripcion || '').toString().trim();
    if (!/Club Laboroteca/i.test(desc)) return; // solo club
    const fecha = parseFechaCell(d.fecha || d.fechaISO || d.fechaTexto || d.fechaTS);
    const importe = typeof d.importeTotalIVA==='number' ? d.importeTotalIVA : numberFromImporte(d.importeTotalIVA);
    out.push({ desc, fecha, importe });
  });
  return out;
}

// ───────────── Agregados ─────────────
function sumarSemanaCompras(rows, startYMD, endYMD, tipo){
  const filtro = tipo==='alta'
    ? r=>/Alta y primera cuota Club Laboroteca/i.test(r.desc)
    : r=>/Renovación mensual Club Laboroteca/i.test(r.desc);
  let count=0, total=0;
  for (const r of rows){
    if (!filtro(r)) continue;
    if (inMadridWeekRange(r.fecha, startYMD, endYMD)){ count++; total+=Number(r.importe||0); }
  }
  return {count, total};
}
function contarSemanaUsuarios(usuarios, startYMD, endYMD, campoFecha){
  let count=0;
  for (const u of usuarios){
    if (u[campoFecha] && inMadridWeekRange(u[campoFecha], startYMD, endYMD)) count++;
  }
  return count;
}
function sumarSemanaFacturas(facturas, startYMD, endYMD, tipo){
  const filtro = tipo==='alta'
    ? f=>/Alta y primera cuota Club Laboroteca/i.test(f.desc)
    : f=>/Renovación mensual Club Laboroteca/i.test(f.desc);
  let count=0, total=0;
  for (const f of facturas){
    if (!filtro(f)) continue;
    if (inMadridWeekRange(f.fecha, startYMD, endYMD)){ count++; total+=Number(f.importe||0); }
  }
  return {count, total};
}
function bajasEnSemana(list, startYMD, endYMD){
  return list.filter(b=>inMadridWeekRange(b.fechaSolicitud, startYMD, endYMD));
}
function totalesEnRango_Sheets(rowsCompras, rowsBajas, dStart, dEnd){
  // devuelve {altas:{count,total}, renov:{count,total}, bajas:{count}}
  const a = rowsCompras.filter(r=>/Alta y primera cuota Club Laboroteca/i.test(r.desc) && inMadridRange(r.fecha, dStart, dEnd));
  const r = rowsCompras.filter(r=>/Renovación mensual Club Laboroteca/i.test(r.desc) && inMadridRange(r.fecha, dStart, dEnd));
  const b = rowsBajas.filter(x=>inMadridRange(x.fechaSolicitud, dStart, dEnd));
  return {
    altas: { count:a.length, total:a.reduce((s,x)=>s+Number(x.importe||0),0) },
    renov: { count:r.length, total:r.reduce((s,x)=>s+Number(x.importe||0),0) },
    bajas: { count:b.length }
  };
}
function totalesEnRango_Firebase(usuarios, facturas, bajasLog, dStart, dEnd){
  const altas = facturas.filter(f=>/Alta y primera cuota Club Laboroteca/i.test(f.desc) && inMadridRange(f.fecha, dStart, dEnd));
  const renov = facturas.filter(f=>/Renovación mensual Club Laboroteca/i.test(f.desc) && inMadridRange(f.fecha, dStart, dEnd));
  const bajas = (bajasLog.length? bajasLog : usuarios.map(u=>({fechaSolicitud:u.fechaBaja, email:u.email, motivo:'', fechaEfectos:null, verificacion:''})))
                 .filter(b=>inMadridRange(b.fechaSolicitud, dStart, dEnd));
  return {
    altas: { count:altas.length, total:altas.reduce((s,x)=>s+Number(x.importe||0),0) },
    renov: { count:renov.length, total:renov.reduce((s,x)=>s+Number(x.importe||0),0) },
    bajas: { count:bajas.length }
  };
}

// Serie semanal (últimos 12 meses ≈ 52 semanas)
function semanasDesde(hoy=new Date(), n=52){
  const arr=[]; // {startDate,endDate,label}
  const {startDate, endDate} = previousMonSunRange(); // semana pasada como referencia de cierre
  let curStart = new Date(startDate.getTime()); // lunes pasado
  for(let i=0;i<n;i++){
    const s = new Date(curStart.getTime() - (i*7*86400000));
    const e = new Date(s.getTime() + 6*86400000);
    arr.push({ start:s, end:e, startYMD: ymdMadrid(s), endYMD: ymdMadrid(e),
      label: `${ymdMadrid(s)}→${ymdMadrid(e)}` });
  }
  return arr.reverse();
}
function serieSemanalCounts(source, type){ // type: 'sheets' | 'firebase'
  // source = { rowsCompras, rowsBajas } o { usuarios, facturas, bajasLog }
  const weeks = semanasDesde();
  return weeks.map(w=>{
    let a=0,r=0,b=0;
    if (type==='sheets'){
      const t = totalesEnRango_Sheets(source.rowsCompras, source.rowsBajas, w.start, w.end);
      a=t.altas.count; r=t.renov.count; b=t.bajas.count;
    } else {
      const t = totalesEnRango_Firebase(source.usuarios, source.facturas, source.bajasLog, w.start, w.end);
      a=t.altas.count; r=t.renov.count; b=t.bajas.count;
    }
    return { week:w, altas:a, renov:r, bajas:b };
  });
}

// ───────────── HTML helpers ─────────────
function htmlNote() {
  return `<p style="color:#c62828;font-weight:bold;margin:0 0 12px;">
    NOTA: Recuerda verificar la desactivación efectiva de las membresías, más abajo tienes el listado de bajas.
  </p>`;
}
function tableKV(rows){
  if (!rows.length) return '<p>Sin datos.</p>';
  const tr = rows.map(r=>`<tr>
    <td style="padding:6px 8px;border:1px solid #ddd;">${r.k}</td>
    <td style="padding:6px 8px;border:1px solid #ddd;text-align:right;">${r.v}</td>
  </tr>`).join('');
  return `<table role="table" cellpadding="0" cellspacing="0" style="border-collapse:collapse;min-width:420px;">
    <tbody>${tr}</tbody></table>`;
}
function tableBajas(list){
  const head=`<tr>
    <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Email</th>
    <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Fecha solicitud</th>
    <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Motivo</th>
    <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Fecha efectos</th>
    <th style="text-align:left;padding:6px 8px;border:1px solid #ddd;background:#f7f7f7;">Verificación</th>
  </tr>`;
  const body = (list.length? list: [{email:'—',fechaSolicitud:null,motivo:'—',fechaEfectos:null,verificacion:'—'}])
    .map(b=>`<tr>
      <td style="padding:6px 8px;border:1px solid #ddd;">${b.email||'—'}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${b.fechaSolicitud? ymdMadrid(b.fechaSolicitud):'—'}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${b.motivo||'—'}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${b.fechaEfectos? ymdMadrid(b.fechaEfectos):'—'}</td>
      <td style="padding:6px 8px;border:1px solid #ddd;">${b.verificacion||'—'}</td>
    </tr>`).join('');
  return `<table role="table" cellpadding="0" cellspacing="0" style="border-collapse:collapse;min-width:580px;">
    <thead>${head}</thead><tbody>${body}</tbody></table>`;
}
// Barras horizontales (counts)
function barsHorizontal(items){ // [{label, value}]
  const max = Math.max(...items.map(i=>i.value), 1);
  const rows = items.map(i=>{
    const w = Math.round((i.value/max)*100);
    return `<div style="display:flex;align-items:center;margin:6px 0;">
      <div style="flex:1;background:#e5e7eb;height:18px;position:relative;">
        <div title="${i.label}: ${i.value}" style="width:${w}%;height:100%;background:#4F46E5;"></div>
      </div>
      <div style="width:56px;text-align:right;margin-left:8px;">${i.value}</div>
      <div style="margin-left:8px;white-space:nowrap;">${i.label}</div>
    </div>`;
  }).join('');
  return `<div style="max-width:640px;">${rows}</div>`;
}
// Línea semanal (3 series) con SVG
function lineChartWeekly(serie){ // [{week:{label}, altas, renov, bajas}]
  const H=180,W=680,P=30;
  const xs = serie.map((_,i)=>P + i*((W-2*P)/Math.max(1,serie.length-1)));
  const max = Math.max(...serie.flatMap(s=>[s.altas,s.renov,s.bajas]), 1);
  const y = v => H-P - (v/max)*(H-2*P);
  const poly = arr => arr.map((v,i)=>`${xs[i]},${y(v)}`).join(' ');
  const grid = Array.from({length:5},(_,k)=>{
    const yy = P + k*((H-2*P)/4);
    return `<line x1="${P}" y1="${yy}" x2="${W-P}" y2="${yy}" stroke="#eee"/>`;
  }).join('');
  const labels = xs.map((x,i)=> i%6===0 ? `<text x="${x}" y="${H-6}" font-size="10" text-anchor="middle">${serie[i].week.startYMD.slice(5)}</text>` : '').join('');
  return `
  <svg width="${W}" height="${H}">
    ${grid}
    <polyline fill="none" stroke="#1f77b4" stroke-width="2" points="${poly(serie.map(s=>s.altas))}"/>
    <polyline fill="none" stroke="#2ca02c" stroke-width="2" points="${poly(serie.map(s=>s.renov))}"/>
    <polyline fill="none" stroke="#d62728" stroke-width="2" points="${poly(serie.map(s=>s.bajas))}"/>
    ${labels}
  </svg>
  <div style="font-size:12px;margin-top:6px;">Altas=<span style="color:#1f77b4">━</span> · Renov=<span style="color:#2ca02c">━</span> · Bajas=<span style="color:#d62728">━</span></div>
  `;
}

// ───────────── Email builders ─────────────
function bloqueTitulo(colorHex, textoFuente){
  return `<h2 style="margin:18px 0 10px 0;font-size:20px;">
    Informe del Club — ${textoFuente}
  </h2>`;
}
function cabeceraFuente(label, color){ // “según FIREBASE”/“según GOOGLE SHEETS”
  return `<div style="font-size:16px;margin:12px 0 4px;">
    según <span style="color:${color};font-weight:bold;">${label}</span>
  </div>`;
}

function seccionFuente({label,color, semanaLbl, weekStats, bajasDetalleSemana, barrasMes, barrasAnio, serie12m, listado6Semanas}){
  const kv = [
    {k:`Semana ${semanaLbl} — Nuevas altas (cantidad / importe)`, v:`${weekStats.altas.count} / ${fmtEUR(weekStats.altas.total)}`},
    {k:`Semana ${semanaLbl} — Renovaciones (cantidad / importe)`, v:`${weekStats.renov.count} / ${fmtEUR(weekStats.renov.total)}`},
    {k:`Semana ${semanaLbl} — Bajas (cantidad)`, v:`${weekStats.bajas.count}`},
  ];
  const tablaBajasSemana = tableBajas(bajasDetalleSemana);
  const lista6 = tableBajas(listado6Semanas);

  return `
    ${cabeceraFuente(label, color)}
    ${tableKV(kv)}
    <h3 style="margin:16px 0 6px;">Desglose de bajas de la semana</h3>
    ${tablaBajasSemana}
    <h3 style="margin:16px 0 6px;">Mes en curso — barras horizontales</h3>
    ${barsHorizontal(barrasMes)}
    <h3 style="margin:16px 0 6px;">Año ${madridParts().Y} — barras horizontales</h3>
    ${barsHorizontal(barrasAnio)}
    <h3 style="margin:16px 0 6px;">Evolución semanal — últimos 12 meses</h3>
    ${lineChartWeekly(serie12m)}
    <h3 style="margin:16px 0 6px;">Listado de bajas — últimas 6 semanas</h3>
    ${lista6}
  `;
}

async function enviarInforme({html, subject}) {
  if (!process.env.SMTP2GO_API_KEY || !process.env.SMTP2GO_FROM_EMAIL) {
    console.log('ℹ️ SMTP2GO no configurado; no se envía email.');
    return;
  }
  // Siempre al admin
  await enviarEmailPersonalizado({ to: EMAIL_ADMIN, subject, html, text: 'Informe semanal del Club' });
  // También a Ignacio si hoy es día 1 en Madrid
  const {D} = madridParts(new Date());
  if (D===1) {
    await enviarEmailPersonalizado({ to: EMAIL_IGNACIO, subject, html, text: 'Informe semanal del Club' });
  }
}

// ───────────── Runner ─────────────
(async ()=>{
  try{
    console.log('🚀 Auditoría semanal Club — inicio');

    // Lecturas
    const [rowsCompras, rowsBajasSheet, usuarios, bajasLog, facturas] = await Promise.all([
      leerComprasSheet(),
      leerBajasSheet(),
      leerUsuariosClub(),
      leerBajasClubLog(),
      leerFacturasClub(),
    ]);

    // Semana objetivo (cerrada anterior)
    const { startYMD, endYMD, startDate, endDate } = previousMonSunRange();
    const semanaLbl = `${startYMD} → ${endYMD}`;

    // ── SHEETS: semana
    const shAlt = sumarSemanaCompras(rowsCompras, startYMD, endYMD, 'alta');
    const shRen = sumarSemanaCompras(rowsCompras, startYMD, endYMD, 'renov');
    const shBajasSemana = bajasEnSemana(rowsBajasSheet, startYMD, endYMD);
    const weekStatsSH = { altas:shAlt, renov:shRen, bajas:{count:shBajasSemana.length} };

    // ── FIREBASE: semana
    const fbAlt = sumarSemanaFacturas(facturas, startYMD, endYMD, 'alta');
    const fbRen = sumarSemanaFacturas(facturas, startYMD, endYMD, 'renov');
    const fbBajasSemana = (bajasLog.length? bajasLog : usuarios.map(u=>({email:u.email, fechaSolicitud:u.fechaBaja, motivo:'', fechaEfectos:null, verificacion:''})))
                          .filter(b=>inMadridWeekRange(b.fechaSolicitud, startYMD, endYMD));
    const weekStatsFB = { altas:fbAlt, renov:fbRen, bajas:{count:fbBajasSemana.length} };

    // Mes en curso
    const dStartMes = startOfMonthMadrid();
    const dEndMes   = new Date(); // hoy
    const barrasMesSH = (()=>{ const t=totalesEnRango_Sheets(rowsCompras, rowsBajasSheet, dStartMes, dEndMes);
      return [{label:'Nuevas altas', value:t.altas.count},{label:'Renovaciones', value:t.renov.count},{label:'Bajas', value:t.bajas.count}];})();
    const barrasMesFB = (()=>{ const t=totalesEnRango_Firebase(usuarios, facturas, bajasLog, dStartMes, dEndMes);
      return [{label:'Nuevas altas', value:t.altas.count},{label:'Renovaciones', value:t.renov.count},{label:'Bajas', value:t.bajas.count}];})();

    // Año en curso
    const dStartYear = startOfYearMadrid();
    const barrasAnioSH = (()=>{ const t=totalesEnRango_Sheets(rowsCompras, rowsBajasSheet, dStartYear, dEndMes);
      return [{label:'Nuevas altas', value:t.altas.count},{label:'Renovaciones', value:t.renov.count},{label:'Bajas', value:t.bajas.count}];})();
    const barrasAnioFB = (()=>{ const t=totalesEnRango_Firebase(usuarios, facturas, bajasLog, dStartYear, dEndMes);
      return [{label:'Nuevas altas', value:t.altas.count},{label:'Renovaciones', value:t.renov.count},{label:'Bajas', value:t.bajas.count}];})();

    // Serie semanal 12 últimos meses (≈52 semanas)
    const serieSH = serieSemanalCounts({ rowsCompras, rowsBajas: rowsBajasSheet }, 'sheets');
    const serieFB = serieSemanalCounts({ usuarios, facturas, bajasLog }, 'firebase');

    // Listado últimas 6 semanas (por fuente)
    const weeks = semanasDesde().slice(-6);
    const lista6SH = weeks.flatMap(w => bajasEnSemana(rowsBajasSheet, w.startYMD, w.endYMD));
    const lista6FB = weeks.flatMap(w => (bajasLog.length? bajasLog : usuarios.map(u=>({email:u.email, fechaSolicitud:u.fechaBaja, motivo:'', fechaEfectos:null, verificacion:''})))
                                                .filter(b=>inMadridWeekRange(b.fechaSolicitud, w.startYMD, w.endYMD)));

    // HTML final
    const monthLabel = monthLabelESFrom(new Date());
    const titulo = `📊 Informe semanal Club ${semanaLbl} — Mes ${monthLabel}`;
    const html =
`<div style="font-family:Arial, sans-serif; font-size:14px; color:#333;">
  ${htmlNote()}
  ${bloqueTitulo('#c62828', `según <span style="color:#c62828;font-weight:bold;">FIREBASE</span>`)}
  ${seccionFuente({
    label:'FIREBASE', color:'#c62828', semanaLbl,
    weekStats: weekStatsFB,
    bajasDetalleSemana: fbBajasSemana,
    barrasMes: barrasMesFB,
    barrasAnio: barrasAnioFB,
    serie12m: serieFB,
    listado6Semanas: lista6FB
  })}

  <hr style="margin:28px 0;border:none;border-top:1px solid #eee;">

  ${bloqueTitulo('#188038', `según <span style="color:#188038;font-weight:bold;">GOOGLE SHEETS</span>`)}
  ${seccionFuente({
    label:'GOOGLE SHEETS', color:'#188038', semanaLbl,
    weekStats: weekStatsSH,
    bajasDetalleSemana: shBajasSemana,
    barrasMes: barrasMesSH,
    barrasAnio: barrasAnioSH,
    serie12m: serieSH,
    listado6Semanas: lista6SH
  })}
</div>`;

    await enviarInforme({ html, subject: titulo });

    console.log('✅ Auditoría semanal Club — fin');
  }catch(e){
    console.error('❌ Error auditoría semanal Club:', e.stack||e.message||e);
    process.exit(1);
  }
})();
