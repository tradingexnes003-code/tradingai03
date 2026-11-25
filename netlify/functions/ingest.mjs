import { getStore } from '@netlify/blobs';
import core from '../lib/core.js';
const J = (o, c = 200) => new Response(JSON.stringify(o), { status: c, headers: { 'content-type': 'application/json' } });
export default async req => {
  const k = process.env.EA_KEY;
  if (!k || req.headers.get('x-ea-key') !== k) return J({ error: 'EA_KEY salah atau belum diisi di Netlify' }, 401);
  if (req.method !== 'POST') return J({ error: 'Gunakan POST' }, 405);
  try { return J(await core.ingest(getStore('tower'), await req.json().catch(() => null))); }
  catch (e) { return J({ error: e.message }, 400); }
};
