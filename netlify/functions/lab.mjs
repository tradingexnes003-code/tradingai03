import { getStore } from '@netlify/blobs';
import lab from '../lib/lab.js';
const J = (o, c = 200) => new Response(JSON.stringify(o), { status: c, headers: { 'content-type': 'application/json' } });
// M15 Lab: simulasi paper terpisah. Tidak menyentuh akun real. Pengunjung boleh melihat; hanya pemilik yang boleh mengubah/menjalankan/reset.
export default async req => {
  const pw = process.env.APP_PASSWORD, owner = !!pw && req.headers.get('x-app-key') === pw, pub = process.env.PUBLIC_VIEW !== 'false';
  if (!owner && !pub) return J({ error: 'Password salah. Klik tombol Password.' }, 401);
  if (!owner && req.method === 'POST') return J({ error: 'Hanya pemilik yang boleh mengubah pengaturan lab.' }, 401);
  try {
    const store = getStore('lab'), tstore = getStore('tower');
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      if (b.action === 'config') await lab.setConfig(store, b.config || {});
      if (b.action === 'reset') await lab.reset(store);
      if (b.action === 'run') await lab.runLab(store, tstore, getStore('mt5-trading'), true);
    }
    const hq = new URL(req.url).searchParams.get('h');
    if (hq && req.method === 'GET') return J({ role: owner ? 'owner' : 'viewer', history: await lab.history(store, hq) });
    return J({ role: owner ? 'owner' : 'viewer', ...(await lab.summary(store, tstore, getStore('mt5-trading'))) });
  } catch (e) { return J({ error: e.message }, 500); }
};
