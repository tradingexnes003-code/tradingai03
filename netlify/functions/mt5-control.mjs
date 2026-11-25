import { getStore } from '@netlify/blobs';
const json = (o, status=200) => new Response(JSON.stringify(o), { status, headers: { 'content-type':'application/json', 'cache-control':'no-store' } });
const appOk = req => !!process.env.APP_PASSWORD && req.headers.get('x-app-key') === process.env.APP_PASSWORD;
const validNum = (x,min,max) => Number.isFinite(Number(x)) && Number(x)>=min && Number(x)<=max;
export default async req => {
  if (req.method !== 'POST') return json({error:'Gunakan POST'},405);
  if (!appOk(req)) return json({error:'Password aplikasi salah atau APP_PASSWORD belum dikonfigurasi'},401);
  if (process.env.MT5_ORDERS_ENABLED !== 'true') return json({error:'Eksekusi MT5 terkunci. Aktifkan MT5_ORDERS_ENABLED=true setelah pengujian demo dan pemeriksaan EA.'},403);
  try {
    const b = await req.json();
    if (b.action !== 'queue') return json({error:'Aksi tidak dikenal'},400);
    const symbol = String(b.symbol||'').trim().replace(/[^A-Za-z0-9._#-]/g,'').slice(0,24);
    const side = String(b.side||'').toUpperCase();
    const entry = Number(b.entry), sl = Number(b.sl), tp = Number(b.tp), riskPct = Number(b.riskPct);
    if (!symbol || !['BUY','SELL'].includes(side) || !validNum(entry,0.000001,1e9) || !validNum(sl,0.000001,1e9) || !validNum(tp,0.000001,1e9) || !validNum(riskPct,0.05,10)) return json({error:'Parameter tidak valid. Risiko dibatasi 0,05%–10%.'},400);
    const store = getStore('mt5-trading');
    const account = await store.get('account_report',{type:'json'}).catch(()=>null);
    if (!account || Date.now()-account.receivedAt>60000 || account.connected!==true) return json({error:'MT5 belum terhubung atau laporan akun sudah basi. Pastikan terminal dan EA aktif.'},409);
    if (account.tradeMode!=='DEMO' && process.env.MT5_ALLOW_LIVE!=='true') return json({error:'Server menolak antrean: akun bukan DEMO dan MT5_ALLOW_LIVE tidak diaktifkan.'},403);
    const current = await store.get('command_current',{type:'json'}).catch(()=>null);
    if (current && current.status === 'PENDING' && Date.now()-current.createdAt < 120000) return json({error:'Masih ada perintah MT5 yang belum diakui EA. Tunggu atau periksa koneksi MT5.'},409);
    if ((side==='BUY' && !(sl<entry && entry<tp)) || (side==='SELL' && !(tp<entry && entry<sl))) return json({error:'Urutan entry, SL, dan TP tidak sesuai arah.'},400);
    const id = crypto.randomUUID();
    const command = {id,symbol,side,entry,sl,tp,riskPct,status:'PENDING',createdAt:Date.now(),expiresAt:Date.now()+60000,source:'dashboard-ai-review',preflight:'ea-live-quote-required'};
    await store.setJSON('command_current',command);
    return json({ok:true,id,command, note:'Perintah antre. EA harus aktif, eksekusi di EA harus diizinkan, dan akun demo akan diwajibkan secara default.'});
  } catch(e) { return json({error:e.message||'Kesalahan server'},500); }
};
