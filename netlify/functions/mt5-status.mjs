import { getStore } from '@netlify/blobs';
const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
export default async req=>{
 const p=process.env.APP_PASSWORD;
 if(!p || req.headers.get('x-app-key')!==p) return J({error:'Password aplikasi salah atau belum dikonfigurasi'},401);
 const st=getStore('mt5-trading');
 const [account,command,lastAck]=await Promise.all(['account_report','command_current','last_ack'].map(k=>st.get(k,{type:'json'}).catch(()=>null)));
 return J({account,command,lastAck,ordersEnabled:process.env.MT5_ORDERS_ENABLED==='true',liveEnabled:process.env.MT5_ALLOW_LIVE==='true'});
};
