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

  const body = '{}';
  const url = new URL(u);
  let path = url.pathname.replace(/\/{2,}/g,'/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0,-1);

  const ts = Date.now();
  const bodySha = crypto.createHash('sha256').update(body).digest('hex');
  const base = [String(ts),'POST',path,bodySha].join('.');
  const sig  = crypto.createHmac('sha256', sec).update(base).digest('hex');

  console.log('[cron] target=', u);
  console.log('[cron] path=', path);
  console.log('[cron] ts=', ts);
  console.log('[cron] sha256(body)=', bodySha.slice(0,12)+'…');
  console.log('[cron] sig(hex)=', sig.slice(0,12)+'…');

  const doFetch = global.fetch ? global.fetch : (...a)=>import('node-fetch').then(m=>m.default(...a));
  const res = await doFetch(u, {
    method: 'POST',
    headers: {
      'content-type':'application/json',
      'x-cron-key': key,
      'x-cron-ts' : String(ts),
      'x-cron-sig': sig
    },
    body
  });
  const text = await res.text();
  console.log('[cron] HTTP', res.status, '-', text.slice(0,500));
  if (!res.ok) process.exit(1);
})().catch(e => { console.error('[cron] Fatal:', e?.message||e); process.exit(3); });
