import { getStore } from '@netlify/blobs';
const text = (s,status=200) => new Response(s,{status,headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store'}});
const json = (o,status=200) => new Response(JSON.stringify(o),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export default async req => {
  const key=process.env.EA_KEY;
  if(!key || req.headers.get('x-ea-key')!==key) return text('UNAUTHORIZED',401);
  const store=getStore('mt5-trading');
  if(req.method==='GET') {
    const c=await store.get('command_current',{type:'json'}).catch(()=>null);
    if(!c || c.status!=='PENDING' || Date.now()>c.expiresAt) return text('NONE');
    const kl=await store.get('auto_kill',{type:'json'}).catch(()=>null);
    const isCancel=c.side==='CANCEL'||c.side==='CLOSE'; // pembatalan selalu boleh walau kill switch aktif (hanya mengurangi risiko)
    if(kl && kl.on && !isCancel){ c.status='BLOCKED'; c.message='Kill switch aktif'; await store.setJSON('command_current',c); return text('NONE'); }
    const account=await store.get('account_report',{type:'json'}).catch(()=>null);
    if(!account || Date.now()-account.receivedAt>60000 || account.connected!==true) { c.status='BLOCKED'; c.message='MT5 tidak terhubung atau laporan akun tidak segar'; await store.setJSON('command_current',c); return text('NONE'); }
    if(!isCancel && account.tradeMode!=='DEMO' && process.env.MT5_ALLOW_LIVE!=='true') { c.status='BLOCKED'; c.message='Akun bukan DEMO; server live gate tertutup'; await store.setJSON('command_current',c); return text('NONE'); }
    // Pipe-delimited protocol keeps the MQL5 bridge dependency-free.
    if(isCancel) return text([c.id,c.symbol,c.side,c.ticket||0,0,0,0,c.side==='CLOSE'?'X':'C'].join('|'));
    return text([c.id,c.symbol,c.side,c.entry,c.sl,c.tp,c.riskPct,(c.mode==='market'?'M':c.mode==='plan'?'P':'N')+(c.slMode?'S':'')].join('|'));
  }
  if(req.method==='POST') {
    try {
      const b=await req.json();
      if(b.action==='ack') {
        const c=await store.get('command_current',{type:'json'}).catch(()=>null);
        if(!c || c.id!==b.id) return json({error:'ID perintah tidak cocok'},409);
        c.status=String(b.status||'UNKNOWN').slice(0,24); c.ackAt=Date.now(); c.ticket=String(b.ticket||'').slice(0,40); c.message=String(b.message||'').slice(0,240);
        await store.setJSON('command_current',c);
        await store.setJSON('last_ack',c);
        return json({ok:true});
      }
      if(b.action==='report') {
        const report={receivedAt:Date.now(),account:String(b.account||'').slice(0,80),server:String(b.server||'').slice(0,80),currency:String(b.currency||'').slice(0,12),balance:Number(b.balance)||0,equity:Number(b.equity)||0,margin:Number(b.margin)||0,tradeMode:String(b.tradeMode||'UNKNOWN'),connected:!!b.connected,active:Math.max(0,Math.round(Number(b.active)||0)),positions:Array.isArray(b.positions)?b.positions.slice(0,30):[],orders:Array.isArray(b.orders)?b.orders.slice(0,30):[],specs:Array.isArray(b.specs)?b.specs.slice(0,40).map(x=>({s:String((x&&x.s)||'').slice(0,24),vmin:+x.vmin||0,vstep:+x.vstep||0,pu:+x.pu||0,spr:+x.spr||0,cap:+x.cap||0})).filter(x=>x.s&&x.vmin>0&&x.pu>0):[]};
        await store.setJSON('account_report',report);
        const dd=new Date().toISOString().slice(0,10), ds=await store.get('auto_day',{type:'json'}).catch(()=>null);
        if(!ds || ds.d!==dd) await store.setJSON('auto_day',{d:dd,equity:report.equity});
        return json({ok:true});
      }
      return json({error:'Aksi tidak dikenal'},400);
    } catch(e) { return json({error:e.message},400); }
  }
  return text('METHOD_NOT_ALLOWED',405);
};
