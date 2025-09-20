const crypto = require('crypto');

(async () => {
  const u   = process.env.CRON_TARGET_URL;
  const key = process.env.MKT_CRON_KEY;
  const sec = process.env.MKT_CRON_HMAC_SECRET;

  if (!u || !key || !sec) {
    console.error('[cron] Missing env:',
      'CRON_TARGET_URL=' + (!!u),
      'MKT_CRON_KEY=' + (!!key),
      'MKT_CRON_HMAC_SECRET=' + (!!sec)
    );
    process.exit(2);
  }

  const body = '{}'; // JSON vacío
  const url = new URL(u);
  let path = url.pathname.replace(/\/{2,}/g,'/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0,-1);

  // ✅ usa segundos para evitar skew innecesario en el verificador
  const ts = Math.floor(Date.now()/1000);
  const bodySha = crypto.createHash('sha256').update(body).digest('hex');
  const baseV2 = [String(ts),'POST',path,bodySha].join('.');
  const sigV2  = crypto.createHmac('sha256', sec).update(baseV2).digest('hex');
  // 🛟 fallback legacy: ts.sha256(body)
  const baseV1 = [String(ts), bodySha].join('.');
  const sigV1  = crypto.createHmac('sha256', sec).update(baseV1).digest('hex');

  console.log('[cron] target=', u);
  console.log('[cron] path=', path);
  console.log('[cron] ts=', ts);
  console.log('[cron] sha256(body)=', bodySha.slice(0,12)+'…');
  console.log('[cron] sig.v2(hex)=', sigV2.slice(0,12)+'…');

  const doFetch = global.fetch ? global.fetch : (...a)=>import('node-fetch').then(m=>m.default(...a));
  async function send(sig, note){
    const r = await doFetch(u, {
      method: 'POST',
      headers: {
        'content-type':'application/json; charset=utf-8',
        'accept':'application/json',
        'user-agent':'LaborotecaCron/1.0 (+https://www.laboroteca.es)',
        'x-cron-key': key,
        'x-cron-ts' : String(ts),
        'x-cron-sig': sig
      },
      body
    });
    const text = await r.text();
    console.log('[cron] HTTP', r.status, note || 'v2', '-', text.slice(0,500));
    return { r, text };
  }

  // 1º intento: firma v2 (ts.POST.path.sha256(body))
  let { r, text } = await send(sigV2, 'v2');
  // Fallback si el backend contestara HMAC_INVALID
  if (r.status === 401 && /HMAC_INVALID/i.test(text)) {
    console.warn('[cron] ⚠️ fallback → v1 (legacy)');
    ({ r, text } = await send(sigV1, 'v1'));
  }
  if (!r.ok) process.exit(1);
})().catch(e => { console.error('[cron] Fatal:', e?.message||e); process.exit(3); });
