import { getStore } from '@netlify/blobs';
import tower from '../lib/tower.js';
import core from '../lib/core.js';
import lab from '../lib/lab.js';
const J = (o, c = 200) => new Response(JSON.stringify(o), { status: c, headers: { 'content-type': 'application/json' } });
export default async req => {
  const pw = process.env.APP_PASSWORD, owner = !!pw && req.headers.get('x-app-key') === pw, pub = process.env.PUBLIC_VIEW !== 'false';
  if (!owner && !pub) return J({ error: 'Password salah. Klik tombol Password.' }, 401);
  const wantRun = new URL(req.url).searchParams.get('run') === '1';
  if (!owner && (req.method === 'POST' || wantRun)) return J({ error: pw ? 'Hanya pemilik (password) yang boleh mengubah pengaturan, menjalankan AI, atau menyentuh akun real.' : 'APP_PASSWORD belum dikonfigurasi di Netlify; kontrol dinonaktifkan.' }, 401);
  try {
    const store = getStore('tower');
    if (wantRun) { await tower.runOnce(store, false, getStore('mt5-trading')); try { await lab.runLab(getStore('lab'), store, getStore('mt5-trading'), false); } catch (e) { /* lab terpisah */ } }
    if (req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      if (b.action === 'config' && b.config) {
        const c = b.config, cur = await tower.getCfg(store), nx = { ...cur };
        for (const k of ['enabled', 'aiOpen', 'emailH', 'emailM', 'emailMn', 'emailPos', 'm15Go']) if (typeof c[k] === 'boolean') nx[k] = c[k];
        if (isFinite(c.modal) && c.modal >= 1000 && c.modal <= 1e10) nx.modal = Math.round(c.modal);
        if (typeof c.paperMirror === 'boolean') {
          nx.paperMirror = c.paperMirror;
          if (c.paperMirror && !cur.paperMirror && !(isFinite(c.modal) && Math.round(c.modal) !== cur.modal)) { const ac = await getStore('mt5-trading').get('account_report', { type: 'json' }).catch(() => null); if (ac && ac.equity > 0) nx.modal = Math.round(ac.equity); } // saldo simulasi mulai dari ekuitas MT5
        }
        if (isFinite(c.riskPct) && c.riskPct >= 0.1 && c.riskPct <= 10) nx.riskPct = +c.riskPct;
        if (['1h', '2h', '4h', '1day'].includes(c.htf)) nx.htf = c.htf;
        if (['5min', '15min', '30min'].includes(c.ltf)) nx.ltf = c.ltf;
        if (isFinite(c.rr) && c.rr >= 1 && c.rr <= 10) nx.rr = +c.rr;
        if (['h1', 'm15', 'konfirm'].includes(c.paperMode)) nx.paperMode = c.paperMode;
        if (['pct', 'sl'].includes(c.paperRiskMode)) nx.paperRiskMode = c.paperRiskMode;
        if (isFinite(c.paperMaxSlCostPct) && c.paperMaxSlCostPct >= 1 && c.paperMaxSlCostPct <= 50) nx.paperMaxSlCostPct = +c.paperMaxSlCostPct;
        if (isFinite(c.m15Min) && c.m15Min >= 3 && c.m15Min <= 7) nx.m15Min = Math.round(c.m15Min);
        if (Array.isArray(c.symbols)) { const seen = new Set(); nx.symbols = c.symbols.filter(x => x && x.s).map(x => ({ s: String(x.s).trim().replace(/[^A-Za-z0-9._/#-]/g, '').slice(0, 20), a: ['forex', 'saham', 'crypto'].includes(x.a) ? x.a : 'forex' })).filter(x => { const k = x.s.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (!k || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6); }
        if (c.auto && typeof c.auto === 'object') {
          const x = c.auto, au = nx.auto = { ...(nx.auto || {}) };
          for (const k of ['enabled', 'dryRun', 'brain', 'judgeGate', 'revise', 'brainFailOpen']) if (typeof x[k] === 'boolean') au[k] = x[k];
          if (isFinite(x.riskPct) && x.riskPct >= 0.05 && x.riskPct <= 10) au.riskPct = +x.riskPct;
          if (isFinite(x.maxDailyLossPct) && x.maxDailyLossPct >= 0.5 && x.maxDailyLossPct <= 25) au.maxDailyLossPct = +x.maxDailyLossPct;
          if (isFinite(x.maxOpen) && x.maxOpen >= 1 && x.maxOpen <= 3) au.maxOpen = Math.round(x.maxOpen);
          if (isFinite(x.cooldownMin) && x.cooldownMin >= 0 && x.cooldownMin <= 1440) au.cooldownMin = Math.round(x.cooldownMin);
          if (['near', 'plan', 'konfirm'].includes(x.mode)) au.mode = x.mode;
          if (['pct', 'sl'].includes(x.riskMode)) au.riskMode = x.riskMode;
          if (isFinite(x.maxSlCostPct) && x.maxSlCostPct >= 1 && x.maxSlCostPct <= 50) au.maxSlCostPct = +x.maxSlCostPct;
          if (['low', 'medium', 'high', 'score'].includes(x.cls)) au.cls = x.cls;
          if (isFinite(x.minSkor) && x.minSkor >= 40 && x.minSkor <= 100) au.minSkor = Math.round(x.minSkor);
          if (typeof x.kill === 'boolean') { au.kill = x.kill; await getStore('mt5-trading').setJSON('auto_kill', { on: x.kill, at: Date.now() }); if (x.kill === true) await tower.cancelReal(store, getStore('mt5-trading'), '*', 'kill switch').catch(() => null); }
        }
        await store.setJSON('config', nx);
        if (nx.modal !== cur.modal) await tower.applyModal(store, cur, nx.modal);
      }
      if (b.action === 'run') await tower.runOnce(store, true, getStore('mt5-trading'));
      if (b.action === 'realCancel' && b.sym) await tower.cancelReal(store, getStore('mt5-trading'), String(b.sym).slice(0, 24), 'dibatalkan manual dari dashboard');
      if (b.action === 'reset') await store.setJSON('state', tower.fresh());
      if (b.action === 'testmail') return J(await tower.testMail());
    }
    const config = await tower.getCfg(store), state = await tower.getState(store, config);
    if (!owner) { // PENGUNJUNG: simulasi saja. Semua yang berkaitan dengan akun real, pengaturan eksekusi, dan perintah MT5 dibuang.
      const REAL = /real|auto|mt5|\bEA\b|ekuitas|akun|dry-?run|kill/i, { auto, ...pubCfg } = config;
      const pubState = { ...state, real: {}, realWhy: {}, go: {}, goWhy: {}, retrig: {}, log: (state.log || []).filter(l => !REAL.test(l.m || '')) };
      return J({ role: 'viewer', config: pubCfg, state: pubState, mail: false, ai: false, gates: { orders: false, live: false, auto: false }, judge: tower.judge(state, {}), acct: null, kill: false, day: null });
    }
    const m5 = getStore('mt5-trading'), acc = await m5.get('account_report', { type: 'json' }).catch(() => null), kill = await m5.get('auto_kill', { type: 'json' }).catch(() => null), day = await m5.get('auto_day', { type: 'json' }).catch(() => null);
    return J({ role: 'owner', config, state, mail: !!(process.env.RESEND_KEY && process.env.EMAIL_TO), ai: !!(process.env.GEMINI_KEY || process.env.ANTHROPIC_KEY),
      gates: { orders: process.env.MT5_ORDERS_ENABLED === 'true', live: process.env.MT5_ALLOW_LIVE === 'true', auto: process.env.AUTO_TRADE_ENABLED === 'true' },
      judge: tower.judge(state, config.auto || {}),
      acct: acc ? { specs: (() => { const o = {}; for (const it of config.symbols || []) { const nm = core.exName(it.s), sp = (acc.specs || []).find(x => x.s === nm); if (sp) o[it.s] = sp; } return o; })(), mode: acc.tradeMode, currency: acc.currency, balance: acc.balance, equity: acc.equity, active: acc.active || 0, age: Math.round((Date.now() - acc.receivedAt) / 1000) } : null, kill: !!(kill && kill.on), day });
  } catch (e) { return J({ error: e.message }, 500); }
};
