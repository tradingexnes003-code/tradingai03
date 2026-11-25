// Control Tower: pemantauan terjadwal, posisi PAPER (simulasi), riwayat winrate, email. Tidak ada order ke broker.
const core = require('./core');
const DEF = { enabled: false, symbols: [], htf: '1h', ltf: '15min', rr: 3, aiOpen: true, emailH: true, emailM: true, emailMn: true, emailPos: true, maxOpen: 6, paperPlan: true, paperCls: 'low', paperMode: 'h1', m15Min: 6, m15Go: false, paperRiskMode: 'pct', paperMaxSlCostPct: 50, paperMirror: false, modal: 2000000, riskPct: 1, auto: { enabled: false, dryRun: true, brain: true, judgeGate: true, judgeN: 30, costR: 0.1, riskPct: 0.25, maxDailyLossPct: 3, maxOpen: 1, cooldownMin: 30, kill: false, mode: 'near', cls: 'high', minSkor: 70 } };
const idr = n => (n < 0 ? '-' : '') + 'Rp' + String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const fresh = () => ({ positions: [], pending: [], used: {}, locks: {}, go: {}, goWhy: {}, real: {}, realWhy: {}, retrig: {}, history: [], last: {}, log: [], counts: { SCN: 0, ANA: 0, BRN: 0, EXE: 0, RSK: 0 }, emails: 0, lastRun: null });
const ttlOf = iv => ({ '1h': 600000, '2h': 900000, '4h': 1800000, '1day': 3600000 })[iv] || 600000;
const getCfg = async store => ({ ...DEF, ...((await store.get('config', { type: 'json' }).catch(() => null)) || {}) });
// Paper mode "biaya SL": sama dengan real. Lot minimum dari spesifikasi EA; biaya SL = jarak SL x nilai per poin x lot min; boleh masuk bila <= plafon % saldo simulasi.
// Penjelasan bila spesifikasi simbol tidak ada: sebut simbol yang dicari dan apa yang sebenarnya dilaporkan EA.
const specMiss = (specs, symbol, rep) => {
  const have = (specs || []).map(x => x.s);
  const age = rep && rep.receivedAt ? Math.round((Date.now() - rep.receivedAt) / 60000) : null;
  return `spesifikasi ${symbol} tidak ada di laporan EA (EA melaporkan: ${have.length ? have.join(', ') : 'tidak ada simbol'}${age != null && age >= 2 ? `; laporan terakhir ${age} menit lalu, cek EA masih berjalan` : ''}). Pasang EA v1.71 (melaporkan semua simbol Market Watch) atau tambahkan ${symbol} ke input SpecSymbols`;
};
const slCostOf = (specs, sym, dist, eq, plafPct) => {
  const symbol = core.exName(sym).replace(/[^A-Za-z0-9._#-]/g, '').slice(0, 24), sp = (specs || []).find(x => x.s === symbol);
  if (!sp || !(sp.pu > 0) || !(sp.vmin > 0)) return { ok: false, msg: 'biaya SL tidak bisa dihitung: ' + specMiss(specs, symbol) };
  const plaf = Math.min(50, Math.max(1, +plafPct || 50)), cost = dist * sp.pu * sp.vmin, pct = cost / eq * 100, need = cost / (plaf / 100);
  return pct > plaf ? { ok: false, cost, pct, msg: `biaya SL ${idr(cost)} (${pct.toFixed(0)}% saldo simulasi) melebihi plafon ${plaf}%; kurang ${idr(need - eq)}` } : { ok: true, cost, pct };
};
// Paper "samakan dengan real": mode order, kelas syarat, skor, mode risiko, plafon, risiko %, maks posisi diambil dari pengaturan eksekusi real.
const effCfg = c => {
  if (!c.paperMirror) return c;
  const A = { ...AUTO, ...(c.auto || {}) };
  return { ...c, paperMode: A.mode === 'near' ? 'm15' : A.mode === 'plan' ? 'h1' : 'konfirm', paperCls: A.cls, paperMinSkor: A.minSkor, paperRiskMode: A.riskMode, paperMaxSlCostPct: A.maxSlCostPct, riskPct: A.riskPct, maxOpen: A.maxOpen };
};
// Risiko per trade paper. Non-mirror + % : lama (risiko = % saldo). Mode biaya SL atau mirror: aturan lot/biaya/spread yang sama dengan EA.
const PAPER_MAX_SPREAD_PCT = 15;
const paperRisk = (cfg, specs, sym, dist, eq) => {
  if (cfg.paperRiskMode !== 'sl' && !cfg.paperMirror) return { ok: true, cost: Math.round(eq * cfg.riskPct / 100) };
  const symbol = core.exName(sym).replace(/[^A-Za-z0-9._#-]/g, '').slice(0, 24), sp = (specs || []).find(x => x.s === symbol);
  if (sp && sp.spr > 0 && dist > 0 && sp.spr / dist * 100 > PAPER_MAX_SPREAD_PCT) return { ok: false, msg: `spread ${(sp.spr / dist * 100).toFixed(0)}% dari SL melebihi batas ${PAPER_MAX_SPREAD_PCT}% (ditolak juga oleh EA real)` };
  if (cfg.paperRiskMode === 'sl') return slCostOf(specs, sym, dist, eq, cfg.paperMaxSlCostPct);
  if (!sp || !(sp.pu > 0) || !(sp.vmin > 0)) return { ok: false, msg: specMiss(specs, symbol) };
  const perLot = dist * sp.pu, budget = eq * cfg.riskPct / 100, step = sp.vstep > 0 ? sp.vstep : sp.vmin, lot = Math.floor(budget / perLot / step + 1e-9) * step;
  if (lot >= sp.vmin) return { ok: true, cost: Math.round(lot * perLot), pct: lot * perLot / eq * 100 };
  const minCost = sp.vmin * perLot, minPct = minCost / eq * 100;
  if (sp.cap > 0 && minPct <= sp.cap) return { ok: true, cost: Math.round(minCost), pct: minPct };
  return { ok: false, cost: minCost, pct: minPct, msg: `lot minimum ${sp.vmin} berisiko ${minPct.toFixed(1)}% saldo simulasi (anggaran ${cfg.riskPct}%); butuh saldo sekitar ${idr(minCost / ((sp.cap > 0 ? sp.cap : cfg.riskPct) / 100))}` };
};
const getState = async (store, cfg = DEF) => {
  const s = { ...fresh(), ...((await store.get('state', { type: 'json' }).catch(() => null)) || {}) };
  if (typeof s.balance !== 'number') {
    const rk = Math.round(cfg.modal * cfg.riskPct / 100);
    s.history.forEach(h => { if (h.pnl === undefined) { h.riskRp = rk; h.pnl = Math.round(h.R * rk); } });
    s.positions.forEach(p => { if (p.riskRp === undefined) p.riskRp = rk; });
    s.balance = Math.round(cfg.modal + s.history.reduce((q, h) => q + h.pnl, 0));
  }
  return s;
};
async function applyModal(store, cur, modal) {
  const st = await getState(store, cur);
  st.balance = Math.round(modal + st.history.reduce((q, h) => q + (h.pnl || 0), 0));
  await store.setJSON('state', st);
}

// Kelas syarat: rendah/sedang/tinggi = minimal syarat H1 (dari 8) dan M15 (dari 7); 'score' = skor minimal.
// Di mode plan LIMIT dipasang sebelum harga masuk zona, jadi hanya H1 yang dinilai (skor = H1 ok/8 x 100).
const CLS = { low: { h: 5, m: 4 }, medium: { h: 6, m: 5 }, high: { h: 7, m: 6 } };
function classPass(g, a, h1Only) {
  const c = a.cls || 'high';
  if (c === 'score') return (h1Only ? g.h.ok / 8 * 100 : (g.skor || 0)) >= (+a.minSkor || 70);
  const t = CLS[c] || CLS.high;
  return g.h.ok >= t.h && (h1Only || g.m.ok >= t.m);
}
const hPass = (g, a) => (a.cls || 'high') === 'score' ? (g.skor || 0) >= (+a.minSkor || 70) : g.h.ok >= (CLS[a.cls || 'high'] || CLS.high).h;
// Entry M15 hanya saat syarat M15 terpenuhi minimal cfg.m15Min dari 7 (default 6) dan entry presisi aktif; harga entry dikunci saat itu.
const nearReady = (g, a, cfg) => hPass(g, a) && g.m.ok >= (+cfg.m15Min || 6) && g.m.entry != null && (g.m.rr || 0) >= (g.minRR != null ? g.minRR : cfg.rr);
const planReady = (g, a, cfg) => ['MENUNGGU', 'DEKAT ENTRY', 'BELUM LAYAK'].includes(g.status) && g.entry != null && g.sl != null && g.tp1 != null && (g.rr || 0) >= cfg.rr && classPass(g, a, true);
// Dashboard hanya punya tab Forex dan Saham, jadi aset kripto sering tersimpan sebagai 'forex' dan dianggap tutup saat akhir pekan. Kenali kripto dari nama simbolnya.
const CRYPTO_RE = /^(BTC|ETH|BNB|SOL|XRP|ADA|DOGE|LTC|AVAX|TRX|BCH|XLM)(USD|USDT|EUR|JPY|IDR)?$/;
function assetOf(sym, a) { return CRYPTO_RE.test(String(sym).toUpperCase().replace(/[^A-Z]/g, '')) ? 'crypto' : a; }
function marketOpen(asset, d = new Date()) {
  const day = d.getUTCDay(), h = d.getUTCHours() + d.getUTCMinutes() / 60;
  if (asset === 'crypto') return true;
  if (asset === 'saham') return day >= 1 && day <= 5 && h >= 13.5 && h < 21;
  if (day === 6) return false; if (day === 0) return h >= 22; if (day === 5) return h < 22; return true;
}
async function htfData(store, sym, htf, src) {
  const k = 'h_' + sym.replace(/\W/g, '') + '_' + htf + '_' + src, c = await store.get(k, { type: 'json' }).catch(() => null);
  if (c && Date.now() - c.t < ttlOf(htf) * 0.9) return c.v;
  const v = await core.candles(sym, htf, 200, ttlOf(htf), src);
  await store.setJSON(k, { t: Date.now(), v }).catch(() => {});
  return v;
}
// Email lewat Resend. EMAIL_TO boleh berisi beberapa alamat (pisah koma/titik koma/spasi); tiap alamat dikirim terpisah supaya satu alamat yang ditolak tidak menggagalkan yang lain.
const mailDetail = { err: '' };
async function mailSend(subject, rows) {
  const k = (process.env.RESEND_KEY || '').trim(), raw = process.env.EMAIL_TO || '', to = raw.split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
  if (!k) return { ok: false, err: 'RESEND_KEY belum terbaca oleh server (cek nama variabel, scope Functions, lalu deploy ulang)' };
  if (!to.length) return { ok: false, err: 'EMAIL_TO belum terbaca oleh server (cek nama variabel dan deploy ulang)' };
  const from = (process.env.EMAIL_FROM || '').trim() || 'Trading AI <onboarding@resend.dev>';
  const html = `<div style="font-family:system-ui,sans-serif"><h3>${subject}</h3><table cellpadding="4">${rows.map(r => `<tr><td style="color:#667">${r[0]}</td><td><b>${r[1]}</b></td></tr>`).join('')}</table><p style="color:#889;font-size:12px">Paper trading (simulasi), bukan saran keuangan.</p></div>`;
  let okN = 0; const errs = [];
  for (const addr of to) {
    try {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + k, 'content-type': 'application/json' }, body: JSON.stringify({ from, to: [addr], subject, html }) });
      if (r.ok) okN++;
      else { let m = ''; try { const j = await r.json(); m = j.message || j.error || JSON.stringify(j); } catch (e) { m = await r.text().catch(() => ''); } errs.push(`${addr}: HTTP ${r.status} ${String(m).slice(0, 160)}`); }
    } catch (e) { errs.push(`${addr}: ${e.message}`); }
  }
  let err = errs.join(' | ');
  if (errs.some(x => /only send testing emails|verify a domain|domain is not verified/i.test(x))) err += ' || Pengirim bawaan Resend (onboarding@resend.dev) hanya boleh mengirim ke email pemilik akun Resend. Untuk alamat lain, verifikasi domain di resend.com/domains lalu isi EMAIL_FROM, misalnya "Trading AI <alert@domain-anda.com>".';
  return { ok: okN > 0, sent: okN, total: to.length, err };
}
async function mail(st, cfg, kind, subject, rows) {
  if (!cfg['email' + kind]) return false;
  const r = await mailSend(subject, rows);
  if (r.ok) { st.emails++; return true; }
  if (r.err && st.log && Date.now() - (st.mailErrAt || 0) > 1800000) { st.mailErrAt = Date.now(); ev(st, 'ANA', '-', 'email gagal: ' + r.err.slice(0, 220)); }
  return false;
}
const testMail = () => mailSend('Tes email Trading AI', [['Status', 'Email berfungsi']]);
const ev = (st, a, s, m) => { st.log.unshift({ t: Date.now(), a, s, m }); if (st.log.length > 80) st.log.length = 80; st.counts[a] = (st.counts[a] || 0) + 1; };

async function llm(prompt) {
  // Gangguan sementara dari penyedia AI (429/500/502/503/504, "high demand") dicoba ulang dengan jeda; total waktu dibatasi agar fungsi tidak kena timeout.
  const fail = (r, j) => { const e = new Error('HTTP ' + r.status + ' ' + String((j && j.error && (j.error.message || j.error.status || j.error)) || '').slice(0, 90)); e.status = r.status; return e; };
  const once = async (model, ms) => {
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), ms);
    try {
      if (process.env.ANTHROPIC_KEY) {
        const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-haiku-5-5', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }) });
        const j = await r.json().catch(() => null); if (!r.ok) throw fail(r, j);
        const t = j && j.content && j.content[0] && j.content[0].text; if (!t) throw new Error('jawaban kosong'); return t;
      }
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }) });
      const j = await r.json().catch(() => null); if (!r.ok) throw fail(r, j);
      const t = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
      if (!t) throw new Error('jawaban kosong'); return t;
    } catch (e) { throw e && e.name === 'AbortError' ? Object.assign(new Error('timeout ' + Math.round(ms / 1000) + ' detik'), { status: 504 }) : e; }
    finally { clearTimeout(tm); }
  };
  const main = process.env.GEMINI_MODEL || 'gemini-3.8-flash', alt = process.env.GEMINI_FALLBACK_MODEL, t0 = Date.now(), delays = [1200, 2500];
  let last;
  for (let k = 0; k < 3; k++) {
    const model = k === 2 && alt && !process.env.ANTHROPIC_KEY ? alt : main; // percobaan terakhir pakai model cadangan bila diisi (GEMINI_FALLBACK_MODEL)
    try { return await once(model, 8000); }
    catch (e) {
      last = e;
      const transient = [429, 500, 502, 503, 504].includes(e && e.status);
      if (!transient || k === 2 || Date.now() - t0 > 14000) break;
      await new Promise(r => setTimeout(r, delays[k]));
    }
  }
  throw last;
}
const aiWhy = e => String((e && e.message) || e || 'tidak diketahui').slice(0, 110);
const aiJson = t => { const i = t.indexOf('{'), k = t.lastIndexOf('}'); if (i < 0 || k < i) throw new Error('balasan bukan JSON'); return JSON.parse(t.slice(i, k + 1)); };
async function brain(sym, g) {
  if (!process.env.ANTHROPIC_KEY && !process.env.GEMINI_KEY) return { ok: true, note: 'tanpa AI, ikut aturan' };
  const prompt = `Anda manajer risiko. Putuskan apakah posisi PAPER ini layak dibuka. ${sym} ${g.dir}. Acuan ${g.htf}: ${g.h.ok}/8 (layak ${g.h.layak}), entry ${g.ltf}: ${g.m.ok}/7 (inti ${g.m.core}${g.m15Min ? '; ATURAN PEMILIK: entry M15 sah bila syarat M15 >= ' + g.m15Min + '/7, jadi nilai inti false atau zona H1 tidak tersentuh BUKAN alasan menolak' : ''}). Entry ${g.m.entry} SL ${g.m.sl} TP1 ${g.m.tp != null ? g.m.tp : g.tp1} R:R 1:${g.m.rr}. Supply ${g.supply || '-'} demand ${g.demand || '-'}. Tren ${g.htf} ${g.trend}. Tolak jika R:R jelek, SL rawan tersapu, atau setup meragukan. Balas HANYA JSON {"buka":true,"alasan":"satu kalimat Indonesia"}.`;
  try {
    const j = aiJson(await llm(prompt));
    return { ok: !!j.buka, note: String(j.alasan || '').slice(0, 140) };
  } catch (e) { return { ok: true, failed: true, note: 'AI gagal (' + aiWhy(e) + '), ikut aturan' }; }
}

// Judge: gerbang berbasis bukti. Order LIVE hanya boleh jika rekam jejak paper (aturan dan Brain yang sama) lolos semua uji setelah biaya.
function judge(st, a = {}) {
  const N = a.judgeN || 30, cost = a.costR == null ? 0.1 : a.costR, H = (st.history || []).slice().reverse();
  const net = H.map(x => (+x.R || 0) - cost), n = net.length, sum = v => v.reduce((q, x) => q + x, 0);
  const avg = n ? sum(net) / n : 0, gp = sum(net.filter(x => x > 0)), gl = -sum(net.filter(x => x < 0)), pf = gl > 0 ? gp / gl : (gp > 0 ? 99 : 0);
  let cum = 0, pk = 0, dd = 0; net.forEach(x => { cum += x; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); });
  const best = n ? Math.max(...net) : 0, avgEx = n > 1 ? (sum(net) - best) / (n - 1) : 0, wins = H.filter(x => x.res === 'TP' || (x.res === 'G62' && x.R > 0)).length, dn = H.filter(x => x.res === 'TP' || x.res === 'SL' || x.res === 'G62').length;
  const props = [
    { k: 'data', label: `Cukup trade teruji (${n}/${N})`, pass: n >= N },
    { k: 'exp', label: `Ekspektasi positif setelah biaya (${avg.toFixed(2)}R per trade)`, pass: n > 0 && avg > 0 },
    { k: 'pf', label: `Profit factor minimal 1,2 (${pf.toFixed(2)})`, pass: pf >= 1.2 },
    { k: 'dd', label: `Drawdown maksimal 8R (${dd.toFixed(1)}R)`, pass: n > 0 && dd <= 8 },
    { k: 'rob', label: `Bukan karena satu trade beruntung (${avgEx.toFixed(2)}R tanpa trade terbaik)`, pass: n > 1 && avgEx > 0 },
  ];
  return { n, N, cost, avg: +avg.toFixed(3), pf: +pf.toFixed(2), dd: +dd.toFixed(2), winrate: dn ? Math.round(wins / dn * 100) : null, props, open: props.every(p => p.pass) };
}
const AUTO = { riskMode: 'pct', maxSlCostPct: 50, enabled: false, dryRun: true, brain: true, riskPct: 0.25, maxDailyLossPct: 3, maxOpen: 1, cooldownMin: 30, kill: false, mode: 'near', cls: 'high', minSkor: 70, revise: true, brainFailOpen: true };
// Antrean order otomatis ke MT5. Berlapis: gerbang server (env), saklar dashboard, kill switch, batas rugi harian, batas posisi aktif, jeda per simbol, dry-run.
// Brain untuk eksekusi otomatis: hanya boleh MENAHAN order yang sudah lolos aturan, tidak pernah membuka order sendiri. Gagal = ditahan.
async function brainAuto(sym, g, cmd, lossPct, real) {
  if (!process.env.ANTHROPIC_KEY && !process.env.GEMINI_KEY) return { ok: true, failed: true, note: 'kunci AI belum diisi, ikut aturan' };
  const rr = (Math.abs(cmd.tp - cmd.entry) / (Math.abs(cmd.entry - cmd.sl) || 1)).toFixed(2);
  const prompt = `Anda manajer risiko untuk akun ${real ? 'REAL' : 'demo'} berukuran kecil. Putuskan apakah order ${cmd.mode === 'market' ? 'MARKET (langsung masuk)' : 'LIMIT'} otomatis ini boleh dikirim. Utamakan menjaga modal: tolak jika ragu. ${sym} ${cmd.side} ${cmd.mode === 'market' ? 'MARKET' : 'LIMIT'} entry ${cmd.entry} SL ${cmd.sl} TP ${cmd.tp}, R:R 1:${rr}, ${cmd.slMode ? `MODE BIAYA-SL (dipilih sadar oleh pemilik akun): lot minimum, kerugian jika SL kena ${cmd.riskPct}% ekuitas. Jangan menolak hanya karena besarnya biaya SL; nilai kualitas setup saja` : 'risiko ' + cmd.riskPct + '% ekuitas'}. Skor ${g.skor}/100, acuan ${g.htf} ${g.h.ok}/8 (layak ${g.h.layak}), entry ${g.ltf} ${g.m.ok}/7 (inti ${g.m.core}${g.m15Min ? '; ATURAN PEMILIK: entry M15 sah bila syarat M15 >= ' + g.m15Min + '/7, jadi nilai inti false atau zona H1 tidak tersentuh BUKAN alasan menolak' : ''}), tren ${g.htf} ${g.trend}, supply ${g.supply || '-'}, demand ${g.demand || '-'}. Rugi hari ini ${lossPct.toFixed(1)}%. Tolak jika SL rawan tersapu, target terhalang zona lawan yang dekat, atau setup melawan tren. Balas HANYA JSON {"buka":true,"alasan":"satu kalimat Indonesia"}.`;
  try {
    const j = aiJson(await llm(prompt));
    return { ok: j.buka === true, note: String(j.alasan || '').slice(0, 140) };
  } catch (e) { return { ok: true, failed: true, note: 'AI gagal (' + aiWhy(e) + '), lanjut sesuai aturan' }; }
}
async function autoQueue(mt5, cfg, g, sym, price, st) {
  const a = { ...AUTO, ...(cfg.auto || {}) };
  if (!a.enabled) return { silent: true };
  const exo = st && st.real && st.real[sym];
  if (exo && !exo.dry) return { msg: `dilewati: order real ${sym} masih aktif/diproses (${exo.status}); Analyst akan merevisi bila plan berubah` };
  if (process.env.AUTO_TRADE_ENABLED !== 'true' || process.env.MT5_ORDERS_ENABLED !== 'true') return { msg: 'dilewati: gerbang server tertutup (AUTO_TRADE_ENABLED dan MT5_ORDERS_ENABLED harus true)' };
  const kill = await mt5.get('auto_kill', { type: 'json' }).catch(() => null);
  if (a.kill || (kill && kill.on)) return { msg: 'dilewati: kill switch aktif' };
  const acc = await mt5.get('account_report', { type: 'json' }).catch(() => null);
  if (!acc || acc.connected !== true || Date.now() - acc.receivedAt > 60000) return { msg: 'dilewati: MT5 tidak terhubung atau laporan akun basi' };
  const real = acc.tradeMode !== 'DEMO';
  if (real && process.env.MT5_ALLOW_LIVE !== 'true') return { msg: 'dilewati: akun real belum diizinkan server (MT5_ALLOW_LIVE)' };
  const today = new Date().toISOString().slice(0, 10), day = await mt5.get('auto_day', { type: 'json' }).catch(() => null);
  const d0 = day && day.d === today ? day.equity : acc.equity, lossPct = d0 > 0 ? (d0 - acc.equity) / d0 * 100 : 0;
  if (lossPct >= a.maxDailyLossPct) {
    const hl = await mt5.get('auto_halt', { type: 'json' }).catch(() => null), first = !(hl && hl.d === today);
    if (first) await mt5.setJSON('auto_halt', { d: today });
    return { msg: `dilewati: batas rugi harian tercapai (${lossPct.toFixed(1)}% dari batas ${a.maxDailyLossPct}%)`, notify: first ? 'halt' : null, lossPct };
  }
  if ((acc.active || 0) >= a.maxOpen) return { msg: `dilewati: sudah ada ${acc.active} posisi/order aktif milik EA` };
  const cur = await mt5.get('command_current', { type: 'json' }).catch(() => null);
  if (cur && cur.status === 'PENDING' && Date.now() - cur.createdAt < 120000) return { msg: 'dilewati: masih ada perintah yang belum diakui EA' };
  const lk = 'auto_last_' + sym.replace(/\W/g, ''), last = await mt5.get(lk, { type: 'json' }).catch(() => null);
  const goMkt = !!cfg.m15Go, planMode = a.mode === 'plan' && !goMkt, konf = a.mode === 'konfirm' && !goMkt; // m15Go: M15 siap -> order MARKET langsung
  const d = price > 100 ? 2 : 5, buy = g.dir === 'BUY', at = +g.m.atr || 0;
  const entry = goMkt ? +(+price).toFixed(d) : planMode ? +g.entry : +(buy ? price - 0.1 * at : price + 0.1 * at).toFixed(d), sl = (planMode || konf) ? +g.sl : +g.m.sl, tp = (planMode || konf) ? +g.tp1 : +(g.m.tp != null ? g.m.tp : g.tp1);
  if (![entry, sl, tp].every(Number.isFinite) || !(buy ? sl < entry && entry < tp : tp < entry && entry < sl)) return { msg: 'dilewati: urutan entry, SL, dan TP tidak valid' };
  if (konf && Math.abs(tp - entry) / (Math.abs(entry - sl) || 1e-9) < cfg.rr) return { msg: 'dilewati: R:R plan H1 dari harga sekarang di bawah minimum' };
  if (planMode && (buy ? !(entry < price) : !(entry > price))) return { msg: 'dilewati: harga sudah melewati entry plan H1, LIMIT tidak valid' };
  const symbol = core.exName(sym).replace(/[^A-Za-z0-9._#-]/g, '').slice(0, 24), riskPct = Math.min(10, Math.max(0.05, +a.riskPct || 0.25));
  // MODE BIAYA-SL: lot minimum broker; order boleh masuk selama kerugian jika SL kena (lot min x jarak SL) tidak melebihi plafon % ekuitas. Tanpa pembulatan risiko ke anggaran %.
  let slInfo = null, riskSend = riskPct;
  const mny = n => String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' ' + (acc.currency || '');
  if (a.riskMode === 'sl') {
    const sp = (acc.specs || []).find(x => x.s === symbol), dist = Math.abs(entry - sl), eq = +acc.equity || 0, plaf = Math.min(50, Math.max(1, +a.maxSlCostPct || 50));
    if (!sp || !(sp.pu > 0) || !(sp.vmin > 0) || eq <= 0) return { msg: 'dilewati: mode biaya-SL: ' + (eq <= 0 ? 'ekuitas akun belum terbaca dari EA' : specMiss(acc.specs, symbol, acc)) };
    const cost = dist * sp.pu * sp.vmin, pct = cost / eq * 100, need = cost / (plaf / 100);
    if (pct > plaf) return { msg: `dilewati: biaya SL ${mny(cost)} (${pct.toFixed(0)}% ekuitas) melebihi plafon ${plaf}%; kurang ${mny(need - eq)}, butuh ekuitas ${mny(need)}` };
    slInfo = { cost, pct: +pct.toFixed(1) }; riskSend = Math.max(0.05, slInfo.pct);
  }
  const cmd = { symbol, side: g.dir, entry, sl, tp, riskPct: riskSend, slMode: !!slInfo, mode: goMkt ? 'market' : planMode ? 'plan' : 'near' };
  const info = `${goMkt ? '[M15 SIAP → MARKET] ' : planMode ? '[PLAN H1] ' : konf ? '[M15 konfirm → SL/TP H1] ' : ''}${g.dir} ${goMkt ? 'MARKET' : 'LIMIT'} ${symbol} @${entry} SL ${sl} TP ${tp} ${slInfo ? 'biaya SL ' + mny(slInfo.cost) + ' (' + slInfo.pct + '% ekuitas, lot min)' : 'risiko ' + riskPct + '%'} (${real ? 'AKUN REAL' : 'demo'})`;
  // Mode plan: satu plan (arah|entry|SL|TP) hanya dievaluasi sekali per status dry-run, agar Brain tidak dipanggil berulang dan order tidak dobel.
  const sig = [g.dir, entry, sl, tp].join('|'), pk = 'auto_plan_' + sym.replace(/\W/g, ''), dry = a.dryRun !== false;
  if (planMode) { const pl = await mt5.get(pk, { type: 'json' }).catch(() => null); if (pl && pl.sig === sig && !!pl.dry === dry) return { silent: true }; }
  const markPlan = () => planMode ? mt5.setJSON(pk, { sig, dry, t: Date.now() }) : null;
  // Jeda per simbol (0 = nonaktif). Dicek SETELAH dedupe plan, jadi plan yang sudah pernah dikirim tidak lagi memenuhi log dengan pesan jeda.
  const cd = Math.max(0, +a.cooldownMin || 0);
  if (cd > 0 && last && Date.now() - last.t < cd * 60000) return { msg: `dilewati: jeda ${cd} menit per simbol belum lewat (sisa ${Math.ceil((cd * 60000 - (Date.now() - last.t)) / 60000)} menit)` };
  if (a.dryRun === false && a.judgeGate !== false) {
    const j = judge(st || { history: [] }, a);
    if (!j.open) return { msg: `Judge menutup gerbang live (${j.n}/${j.N} trade teruji): ${j.props.filter(p => !p.pass).map(p => p.label).join('; ')} | ${info}`, judge: j };
  }
  let bn = null;
  if (a.brain !== false && !cfg.m15Go) { // mode M15 siap -> langsung masuk: ambang N/7 adalah aturan pemilik, Brain tidak ikut memveto
    bn = await brainAuto(sym, { ...g, m15Min: cfg.m15Min }, cmd, lossPct, real);
    if (!bn.ok) { if (!bn.failed) await markPlan(); return { msg: `Brain MENAHAN order (${bn.failed ? 'AI tidak tersedia atau gagal, ditahan demi keamanan' : 'menolak'}): ${bn.note} | ${info}`, brain: bn }; }
  }
  const track = (id, d) => { if (st) (st.real = st.real || {})[sym] = { id, dry: d, status: d ? 'VIRTUAL' : 'QUEUED', side: g.dir, symbol, entry, sl, tp, riskPct: riskSend, mode: goMkt ? 'market' : a.mode, h1time: g.h1time, ref: { dir: g.dir, entry: g.entry, sl: g.sl, tp1: g.tp1 }, t: Date.now() }; };
  if (bn && bn.failed && !dry && a.brainFailOpen === false) return { msg: `Brain AI tidak tersedia (${bn.note}); order live ditahan demi keamanan, dicoba lagi di scan berikutnya | ${info}`, brain: bn };
  if (dry) { await markPlan(); track('dry-' + Date.now().toString(36), true); return { msg: 'DRY-RUN, tidak dikirim: ' + info, cmd, brain: bn }; }
  const id = require('crypto').randomUUID();
  await mt5.setJSON('command_current', { id, ...cmd, status: 'PENDING', createdAt: Date.now(), expiresAt: Date.now() + 120000, source: 'auto-tower', preflight: 'ea-live-quote-required' });
  await mt5.setJSON(lk, { t: Date.now() });
  await markPlan(); track(id, false);
  return { msg: 'order diantrekan ke MT5: ' + info, notify: 'sent', cmd, brain: bn };
}
async function autoReport(st, cfg, au, g, sym) {
  if (au.silent) return;
  (st.realWhy = st.realWhy || {})[sym] = { t: Date.now(), msg: String(au.msg || '').slice(0, 260) };
  // Pesan "dilewati" yang sama untuk simbol yang sama hanya dicatat sekali sampai alasannya berubah; kirim order/halt selalu dicatat.
  st.exeKey = st.exeKey || {};
  const key = au.notify ? '' : sym + '|' + String(au.msg || '').replace(/\(sisa[^)]*\)/, '').replace(/\d+(\.\d+)?%/g, '%') + '|' + (au.brain ? au.brain.note : '');
  if (key && st.exeKey[sym] === key) return;
  st.exeKey[sym] = key;
    if (au.brain) ev(st, 'BRN', sym, 'auto: ' + (au.brain.failed ? 'AI tidak tersedia, ' : au.brain.ok ? 'setuju, ' : 'menahan, ') + au.brain.note);
  ev(st, 'EXE', sym, 'AUTO ' + au.msg);
  if (au.notify === 'sent') await mail(st, cfg, 'Pos', `🤖 AUTO ORDER ${au.cmd.side} LIMIT ${au.cmd.symbol}`, [['Simbol', au.cmd.symbol], ['Order', au.cmd.side + ' LIMIT'], ['Entry', au.cmd.entry], ['SL', au.cmd.sl], ['TP', au.cmd.tp], ['Risiko', au.cmd.riskPct + '% ekuitas'], ['Skor', g.skor], ['Brain', au.brain ? au.brain.note : 'nonaktif']]);
  if (au.notify === 'halt') await mail(st, cfg, 'Pos', '⛔ Batas rugi harian tercapai: eksekusi otomatis berhenti hari ini', [['Rugi hari ini', au.lossPct.toFixed(1) + '%']]);
}
// Kirim perintah batal pending order ke EA (hanya order pending, posisi terisi tidak disentuh). Mengembalikan { ok, msg }.
async function sendCancel(mt5, o, why) {
  if (process.env.MT5_ORDERS_ENABLED !== 'true') return { ok: false, msg: 'MT5_ORDERS_ENABLED belum true' };
  const acc = await mt5.get('account_report', { type: 'json' }).catch(() => null);
  if (!acc || acc.connected !== true || Date.now() - acc.receivedAt > 60000) return { ok: false, msg: 'MT5 tidak terhubung / laporan basi' };
  const cur = await mt5.get('command_current', { type: 'json' }).catch(() => null);
  if (cur && cur.status === 'PENDING' && Date.now() - cur.createdAt < 120000) return { ok: false, msg: 'masih ada perintah belum diakui EA' };
  const id = require('crypto').randomUUID();
  await mt5.setJSON('command_current', { id, symbol: o.symbol, side: 'CANCEL', ticket: o.ticket || 0, status: 'PENDING', createdAt: Date.now(), expiresAt: Date.now() + 120000, source: 'analyst-real', reason: String(why).slice(0, 120) });
  return { ok: true, id };
}
// Kirim perintah TUTUP posisi terbuka milik EA untuk satu simbol (sinyal God 62 berbalik). Hanya mengurangi risiko.
async function sendClose(mt5, o, why) {
  if (process.env.MT5_ORDERS_ENABLED !== 'true') return { ok: false, msg: 'MT5_ORDERS_ENABLED belum true' };
  const acc = await mt5.get('account_report', { type: 'json' }).catch(() => null);
  if (!acc || acc.connected !== true || Date.now() - acc.receivedAt > 60000) return { ok: false, msg: 'MT5 tidak terhubung / laporan basi' };
  const cur = await mt5.get('command_current', { type: 'json' }).catch(() => null);
  if (cur && cur.status === 'PENDING' && Date.now() - cur.createdAt < 120000) return { ok: false, msg: 'masih ada perintah belum diakui EA' };
  const id = require('crypto').randomUUID();
  await mt5.setJSON('command_current', { id, symbol: o.symbol, side: 'CLOSE', ticket: o.ticket || 0, status: 'PENDING', createdAt: Date.now(), expiresAt: Date.now() + 120000, source: 'god62-exit', reason: String(why).slice(0, 120) });
  return { ok: true, id };
}
// ANALYST REAL: mencocokkan order real/virtual dengan plan terbaru. Plan berubah -> batalkan order lama, lalu plan baru dipasang otomatis oleh jalur eksekusi biasa.
async function realAnalyst(mt5, st, cfg, g, sym, price) {
  const a = { ...AUTO, ...(cfg.auto || {}) };
  st.real = st.real || {}; st.retrig = st.retrig || {};
  const o = st.real[sym]; if (!o) return;
  const drop = (m, retrig) => { ev(st, 'ANA', sym, '[REAL] ' + m); delete st.real[sym]; if (retrig) st.retrig[sym] = true; };
  if (!o.dry && mt5) {
    const acc = await mt5.get('account_report', { type: 'json' }).catch(() => null), ack = await mt5.get('last_ack', { type: 'json' }).catch(() => null);
    if (ack && ack.id === o.id && o.status === 'QUEUED') {
      if (ack.ticket) o.ticket = ack.ticket;
      if (ack.status === 'EXECUTED') { o.status = 'PENDING_MT5'; ev(st, 'EXE', sym, `[REAL] pending LIMIT diterima broker, tiket ${o.ticket || '-'}`); }
      else if (['BLOCKED', 'REJECTED', 'FAILED', 'DUPLICATE'].includes(ack.status)) { drop(`order ditolak EA (${ack.status}): ${ack.message || ''}`, false); return; }
      else if (ack.status === 'DRYRUN') { drop('EA masih DryRun: order tidak dikirim ke broker', false); return; }
    }
    if (o.cancelId && ack && ack.id === o.cancelId) {
      if (['CANCELLED', 'DRYRUN'].includes(ack.status)) { drop(`order lama dibatalkan di MT5 (${ack.message || ack.status})`, true); return; }
      ev(st, 'ANA', sym, `[REAL] pembatalan gagal (${ack.status}): ${ack.message || ''}; dicoba lagi`); o.cancelId = null; o.status = 'PENDING_MT5';
    }
    if (o.closeId && ack && ack.id === o.closeId) {
      if (ack.status === 'CLOSED') ev(st, 'EXE', sym, `[REAL] EA menutup posisi (${ack.message || ack.status})`);
      else if (ack.status === 'DRYRUN') ev(st, 'ANA', sym, `[REAL] EA masih DryRun: posisi TIDAK ditutup (${ack.message || ''})`);
      else ev(st, 'ANA', sym, `[REAL] penutupan posisi gagal (${ack.status}): ${ack.message || ''}; dicoba lagi`);
      o.closeId = null;
    }
    const accOk = acc && Date.now() - acc.receivedAt < 60000 && Array.isArray(acc.orders);
    if (accOk && ['PENDING_MT5', 'TERISI'].includes(o.status)) {
      const hasOrd = acc.orders.some(x => o.ticket ? String(x.tk) === String(o.ticket) : (x.s === o.symbol && x.side === o.side)), pos = (acc.positions || []).find(x => x.s === o.symbol);
      if (hasOrd) { o.status = 'PENDING_MT5'; }
      else if (pos) { if (o.status !== 'TERISI') { o.status = 'TERISI'; ev(st, 'EXE', sym, `[REAL] order terisi → posisi berjalan @${pos.px} (P/L ${pos.pr})`); } }
      else { if (o.status === 'TERISI') { if (st.go) delete st.go[sym + '|real']; if (st.locks) delete st.locks[sym]; } drop(o.status === 'TERISI' ? 'posisi real selesai (TP/SL/ditutup)' : 'pending order hilang di MT5 (kedaluwarsa/dihapus manual)', false); return; }
    }
    if (o.status === 'QUEUED' && Date.now() - o.t > 180000) { drop('tidak ada konfirmasi EA >3 menit; order dianggap tidak terkirim', false); return; }
    if (o.status === 'CANCEL_QUEUED') { if (Date.now() - (o.cancelAt || 0) > 180000) { o.status = 'PENDING_MT5'; o.cancelId = null; ev(st, 'ANA', sym, '[REAL] tidak ada konfirmasi pembatalan dari EA; akan dicoba lagi'); } else return; }
  }
  // Posisi sudah terisi: keluar saat sinyal God 62 berlawanan dengan arah posisi (diulang tiap 10 menit bila belum tertutup).
  if (o.status === 'TERISI' && EXIT_G62() && !o.dry && mt5 && g.dir !== o.side) {
    if (!o.closeAt || Date.now() - o.closeAt > 600000) {
      const r = await sendClose(mt5, o, `sinyal God 62 berbalik ${o.side}→${g.dir}`);
      if (r.ok) { o.closeId = r.id; o.closeAt = Date.now(); ev(st, 'ANA', sym, `[REAL] sinyal God 62 berbalik ${o.side}→${g.dir}: perintah TUTUP posisi dikirim ke MT5`); }
      else if (o.lastWhy !== r.msg) { o.lastWhy = r.msg; ev(st, 'ANA', sym, `[REAL] sinyal God 62 berbalik tapi penutupan tertunda: ${r.msg}`); }
    }
    return;
  }
  if (o.status === 'TERISI') return;
  if (a.revise === false) return;
  // alasan pembatalan: arah/level plan H1 berubah, atau status plan tidak lagi layak
  const ref = o.ref || {}, why = [];
  if (g.dir !== o.side) why.push(`arah berubah ${o.side}→${g.dir}`);
  if (g.entry !== ref.entry || g.sl !== ref.sl || g.tp1 !== ref.tp1) why.push(`level plan H1 berubah (entry ${ref.entry}→${g.entry}, SL ${ref.sl}→${g.sl}, TP ${ref.tp1}→${g.tp1})`);
  if (['BATAL', 'TERLEWAT', 'PASAR SEPI'].includes(g.status)) why.push('status plan ' + g.status);
  if (o.mode === 'plan' && !why.length && !planReady(g, { ...a }, cfg) && !['DI ZONA', 'SIAP ENTRY'].includes(g.status)) why.push('plan H1 tidak lagi memenuhi syarat (' + g.status + ')');
  if (!why.length) return;
  const txt = why.join('; ');
  if (o.dry) { drop(`[DRY] order virtual ${o.side} @${o.entry} dibatalkan: ${txt} → plan baru akan dihitung ulang`, true); return; }
  const r = await sendCancel(mt5, o, txt);
  if (r.ok) { o.status = 'CANCEL_QUEUED'; o.cancelId = r.id; o.cancelAt = Date.now(); ev(st, 'ANA', sym, `[REAL] plan berubah → perintah batal ${o.side} @${o.entry} dikirim ke MT5: ${txt}`); }
  else if (o.lastWhy !== r.msg) { o.lastWhy = r.msg; ev(st, 'ANA', sym, `[REAL] plan berubah (${txt}) tapi pembatalan tertunda: ${r.msg}`); }
}
// Pembatalan manual dari dashboard (satu simbol) atau semua (kill switch).
async function cancelReal(store, mt5, sym, why = 'dibatalkan manual') {
  const cfg = await getCfg(store), st = await getState(store, cfg), out = [];
  const list = sym === '*' ? Object.keys(st.real || {}) : [sym];
  for (const k of list) {
    const o = (st.real || {})[k]; if (!o) { out.push(`${k}: tidak ada order tercatat`); continue; }
    if (o.status === 'TERISI') { out.push(`${k}: sudah terisi menjadi posisi (tidak dibatalkan; kelola di MT5)`); continue; }
    if (o.dry) { delete st.real[k]; ev(st, 'ANA', k, `[REAL][DRY] order virtual dibatalkan (${why})`); out.push(`${k}: order virtual dihapus`); continue; }
    const r = await sendCancel(mt5, o, why);
    if (r.ok) { o.status = 'CANCEL_QUEUED'; o.cancelId = r.id; o.cancelAt = Date.now(); ev(st, 'ANA', k, `[REAL] perintah batal dikirim (${why})`); out.push(`${k}: perintah batal dikirim`); }
    else out.push(`${k}: ${r.msg}`);
  }
  await store.setJSON('state', st);
  return out;
}
// Satu proses Control Tower pada satu waktu: dua proses yang tumpang tindih (jadwal + tombol manual) bisa saling menimpa state dan mengirim order yang sama dua kali.
async function runOnce(store, manual, mt5) {
  const lk = await store.get('run_lock', { type: 'json' }).catch(() => null);
  if (lk && Date.now() - lk.t < 100000) return { skipped: true };
  await store.setJSON('run_lock', { t: Date.now() }).catch(() => null);
  try { return await runOnceInner(store, manual, mt5); } finally { await store.setJSON('run_lock', { t: 0 }).catch(() => null); }
}
const EXIT_G62 = () => process.env.EXIT_G62 !== 'false'; // posisi ditutup saat sinyal God 62 berlawanan (stop-and-reverse)
async function runOnceInner(store, manual, mt5) {
  core.setStore(store);
  const cfg = effCfg(await getCfg(store)), st = await getState(store, cfg);
  if (!cfg.enabled && !manual) return { skipped: 'nonaktif' };
  const runSymbols = (Array.isArray(cfg.symbols) ? cfg.symbols : []).filter((it, i, a) => it && it.s && a.findIndex(x => x && String(x.s).toUpperCase().replace(/[^A-Z0-9]/g, '') === String(it.s).toUpperCase().replace(/[^A-Z0-9]/g, '')) === i).slice(0, 6);
  for (const it of runSymbols) {
    const sym = it.s, prev = st.last[sym] || {};
    const asset = assetOf(sym, it.a);
    if (!marketOpen(asset)) { if (!prev.closed) ev(st, 'SCN', sym, 'pasar tutup, dilewati'); st.last[sym] = { ...prev, closed: true }; continue; }
    try {
      const src = await core.pickSource(sym, [cfg.ltf, cfg.htf]), v = (await core.candles(sym, cfg.ltf, 100, 50000, src)).slice(0, -1), vh = await htfData(store, sym, cfg.htf, src);
      if (prev.src && prev.src !== src) ev(st, 'SCN', sym, 'sumber data beralih ke ' + (src === 'exness' ? 'Exness' : 'Twelve Data'));
      const g = core.god(vh, v, cfg.rr, { h: cfg.htf, l: cfg.ltf, m15Min: cfg.m15Min }), price = v[v.length - 1].c, lastT = v[v.length - 1].t;
      const pNeed = cfg.paperRiskMode === 'sl' || !!cfg.paperMirror, pSpecs = pNeed && mt5 ? ((await mt5.get('account_report', { type: 'json' }).catch(() => null)) || {}).specs : null;
      // PLAN H1 (paper): pending LIMIT mengikuti plan dashboard. Terisi saat harga menyentuh entry, lalu dipantau SL/TP seperti posisi biasa.
      st.pending = st.pending || [];
      for (const q of st.pending.filter(x => x.s === sym)) {
        let fillT = null, why = null, prevT = q.lastT;
        for (const x of v.filter(c => c.t > q.lastT)) {
          q.bars++;
          if (q.dir === 'BUY' ? x.l <= q.entry : x.h >= q.entry) { fillT = x.t; break; }
          if (q.dir === 'BUY' ? x.h >= q.tp1 : x.l <= q.tp1) { why = 'target tercapai sebelum entry tersentuh'; break; }
          prevT = x.t;
        }
        if (!fillT && !why && q.bars >= (q.kind === 'M15' ? 64 : 192)) why = q.kind === 'M15' ? 'kedaluwarsa (16 jam)' : 'kedaluwarsa (48 jam)';
        if (fillT && (st.balance <= 0 || st.positions.length >= cfg.maxOpen)) { why = 'slot posisi penuh'; fillT = null; }
        let pRisk = Math.round(st.balance * cfg.riskPct / 100);
        if (fillT && pNeed) { const c = paperRisk(cfg, pSpecs, sym, Math.abs(q.entry - q.sl), st.balance); if (!c.ok) { why = c.msg; fillT = null; } else pRisk = Math.round(c.cost); }
        if (fillT) {
          const pos = { id: q.id, kind: q.kind || 'H1', s: sym, a: asset, dir: q.dir, entry: q.entry, sl: q.sl, tp1: q.tp1, tp2: q.tp2, rr: q.rr, tOpen: Date.now(), lastT: prevT, bars: 0, riskRp: pRisk, grade: q.grade, hOk: q.hOk, mOk: 0, why: 'plan ' + (q.kind || 'H1') + ' terisi', src: 'plan' };
          st.positions.push(pos); st.pending = st.pending.filter(x => x !== q); (st.used = st.used || {})[sym + '|' + q.kind] = q.ukey;
          ev(st, 'EXE', sym, `[${q.kind}] ${q.dir} LIMIT plan terisi @${q.entry} SL ${q.sl} TP ${q.tp1} · risiko ${idr(pos.riskRp)}`);
          await mail(st, cfg, 'Pos', `🚀 Plan ${q.kind} terisi (paper): ${sym} ${q.dir}`, [['Simbol', sym], ['Arah', q.dir], ['Entry', q.entry], ['SL', q.sl], ['TP1', q.tp1], ['R:R', '1:' + q.rr], ['Risiko', idr(pos.riskRp)], ['Potensi TP1', idr(pos.riskRp * q.rr)], ['Saldo', idr(st.balance)]]);
        } else if (why) { st.pending = st.pending.filter(x => x !== q); ev(st, 'EXE', sym, `plan [${q.kind}] ${q.dir} @${q.entry} dibatalkan: ${why}`); }
        else q.lastT = lastT;
      }
      // RSK: periksa posisi terbuka
      for (const p of st.positions.filter(x => x.s === sym)) {
        let res = null;
        for (const x of v.filter(c => c.t > p.lastT)) {
          p.bars++;
          if (p.dir === 'BUY') { if (x.l <= p.sl) { res = 'SL'; break; } if (x.h >= p.tp1) { res = 'TP'; break; } }
          else { if (x.h >= p.sl) { res = 'SL'; break; } if (x.l <= p.tp1) { res = 'TP'; break; } }
        }
        p.lastT = lastT;
        if (!res && EXIT_G62() && g.g62 && g.g62.state && (p.dir === 'BUY') !== (g.g62.state === 'BUY')) res = 'G62'; // keluar di harga candle tutup terakhir
        if (!res && p.bars >= (EXIT_G62() ? 1000 : 96)) res = 'TIMEOUT';
        if (res) {
          const risk = Math.abs(p.entry - p.sl) || 1e-9, px = res === 'TP' ? p.tp1 : res === 'SL' ? p.sl : price;
          const R = +(((p.dir === 'BUY' ? px - p.entry : p.entry - px)) / risk).toFixed(2);
          const pnl = Math.round(R * (p.riskRp || st.balance * cfg.riskPct / 100)); st.balance += pnl;
          st.history.unshift({ ...p, res, exit: px, R, pnl, tClose: Date.now() }); if (st.history.length > 200) st.history.length = 200;
          st.positions = st.positions.filter(x => x !== p);
          if (st.go) delete st.go[sym + '|paper']; if (st.locks) delete st.locks[sym]; // posisi selesai: boleh masuk lagi di plan yang sama bila syarat M15 terpenuhi lagi
          ev(st, 'RSK', sym, `posisi ${p.dir} ditutup ${res} @${px} (${R > 0 ? '+' : ''}${R}R · ${idr(pnl)} · saldo ${idr(st.balance)})`);
          await mail(st, cfg, 'Pos', `${res === 'TP' ? '✅' : res === 'SL' ? '❌' : res === 'G62' ? '🔁' : '⏱'} ${sym} ${p.dir} ${res === 'G62' ? 'ditutup sinyal God 62 berbalik' : 'kena ' + res} (${R}R)`, [['Simbol', sym], ['Arah', p.dir], ['Entry', p.entry], ['SL', p.sl], ['TP1', p.tp1], ['Keluar', px], ['Hasil', R + 'R (' + idr(pnl) + ')'], ['Saldo', idr(st.balance)]]);
        } else ev(st, 'RSK', sym, `pantau posisi ${p.dir}: harga ${price}, SL ${p.sl}, TP ${p.tp1}`);
      }
      // KUNCI ENTRY M15: begitu syarat M15 terpenuhi, entry/SL/TP dikunci dan DIBIARKAN TERBUKA sampai ada plan H1 baru, kena SL/TP, atau arah berbalik.
      // Syarat yang hilang di candle berikutnya tidak mencabut kunci.
      st.locks = st.locks || {}; st.go = st.go || {}; st.goWhy = st.goWhy || {};
      const planKey = [g.dir, g.entry, g.sl, g.tp1].join('|');
      let lk = st.locks[sym];
      if (lk) {
        let rel = null;
        if (lk.planKey !== planKey) rel = 'plan H1 baru';
        else for (const x of v.filter(c => c.t > lk.lastT)) {
          if (lk.dir === 'BUY' ? x.l <= lk.sl : x.h >= lk.sl) { rel = 'kena SL'; break; }
          if (lk.dir === 'BUY' ? x.h >= lk.tp : x.l <= lk.tp) { rel = 'kena TP'; break; }
        }
        if (rel) { ev(st, 'ANA', sym, `kunci entry ${lk.dir} @${lk.entry} dilepas: ${rel}`); delete st.locks[sym]; lk = null; } else lk.lastT = lastT;
      }
      if (!lk && g.m.entry != null && !['TERLEWAT', 'BATAL', 'PASAR SEPI'].includes(g.status)) {
        lk = st.locks[sym] = { dir: g.dir, entry: g.m.entry, sl: g.m.sl, tp: g.m.tp != null ? g.m.tp : g.tp1, rr: g.m.rr, mOk: g.m.ok, hOk: g.h.ok, planKey, t: Date.now(), candleT: lastT, lastT };
        ev(st, 'ANA', sym, `entry ${g.ltf} DIKUNCI: ${g.dir} @${lk.entry} SL ${lk.sl} TP ${lk.tp} (R:R 1:${lk.rr}, ${g.ltf} ${g.m.ok}/7); dibiarkan terbuka sampai ada plan baru`);
      }
      const goOnce = (k, m) => { if (st.goWhy[k] !== m) { st.goWhy[k] = m; return true; } return false; };
      ev(st, 'SCN', sym, `${g.htf} ${g.h.ok}/8 · ${g.ltf} ${g.m.ok}/7 · ${g.status}${lk ? ' · entry terkunci' : ''}`);
      const pModeEff = cfg.m15Go ? 'm15' : (cfg.paperMode || 'h1');
      if (cfg.paperPlan !== false) {
        const BAD = ['TERLEWAT', 'BATAL', 'PASAR SEPI'], hOkGate = classPass(g, { cls: cfg.paperCls || 'low' }, true) && !BAD.includes(g.status) && g.sl != null && g.tp1 != null;
        const passive = e => e != null && (g.dir === 'BUY' ? e <= price : e >= price);
        // Mode paper 'h1': pending LIMIT di tepi zona H1 mengikuti plan dashboard. Mode 'm15' dan 'konfirm' dieksekusi saat M15 memenuhi syarat (lihat bawah).
        const specs = [
          { kind: 'H1', valid: pModeEff === 'h1' && hOkGate && (g.rr || 0) >= cfg.rr, entry: g.entry, sl: g.sl, tp1: g.tp1, tp2: g.tp2, rr: g.rr, ukey: g.dir + '|' + g.entry + '|' + g.sl + '|' + g.tp1, same: c => c.entry === g.entry && c.sl === g.sl && c.tp1 === g.tp1 && c.dir === g.dir }
        ];
        for (const sp of specs) {
          const cur = st.pending.find(x => x.s === sym && x.kind === sp.kind), hasPos = st.positions.some(x => x.s === sym && (x.kind || 'H1') === sp.kind);
          if (cur && (!sp.valid || !sp.same(cur))) { st.pending = st.pending.filter(x => x !== cur); ev(st, 'ANA', sym, `plan [${sp.kind}] ${cur.dir} @${cur.entry} diganti/dibatalkan (plan berubah)`); }
          if (sp.valid && passive(sp.entry) && !hasPos && !st.pending.some(x => x.s === sym && x.kind === sp.kind) && (st.used || {})[sym + '|' + sp.kind] !== sp.ukey && st.pending.length + st.positions.length < cfg.maxOpen && st.balance > 0) {
            st.pending.push({ id: Date.now().toString(36) + sym.replace(/\W/g, '') + sp.kind, kind: sp.kind, s: sym, dir: g.dir, entry: sp.entry, sl: sp.sl, tp1: sp.tp1, tp2: sp.tp2, rr: sp.rr, h1time: g.h1time, ukey: sp.ukey, lastT, bars: 0, tCreate: Date.now(), grade: g.grade, hOk: g.h.ok });
            ev(st, 'ANA', sym, `plan [${sp.kind}] dipasang: ${g.dir} LIMIT @${sp.entry} SL ${sp.sl} TP ${sp.tp1} (R:R 1:${sp.rr})`);
          }
        }
      }
      if (g.h.ok >= 7 && !(prev.hOk >= 7))
        await mail(st, cfg, 'H', `📊 ${sym} ${g.dir}: ${g.htf} ${g.h.ok}/8 syarat terpenuhi`, [['Simbol', sym], ['Arah', g.dir], ['Syarat acuan', g.h.ok + '/8'], ['Layak pantau', g.h.layak ? 'ya' : 'belum'], ['Entry limit', g.entry], ['SL', g.sl], ['TP1', g.tp1], ['R:R', '1:' + g.rr], ['Status', g.status]]);
      const mk = g.m.ok, NM = { zone: 'harga di zona', conf: 'sinyal God 62 baru', rr: 'R:R', vol: 'volatilitas', choch: 'BOS M15', ema: 'warna bar God 62', rsi: 'level S/R' };
      const kurang = Object.entries(g.m.chk).filter(([, x]) => !x).map(([k]) => NM[k]).join(', ') || '-';
      const lv = mk >= 7 && !(prev.mOk >= 7) ? 7 : mk >= 6 && !(prev.mOk >= 6) ? 6 : 0;
      if (lv) await mail(st, cfg, 'Mn', `${lv === 7 ? '🔥' : '📈'} ${sym} ${g.dir}: entry ${g.ltf} ${mk}/7 syarat`, [['Simbol', sym], ['Arah', g.dir], ['Syarat entry', mk + '/7'], ['Belum terpenuhi', kurang], ['Acuan ' + g.htf, g.h.ok + '/8 (layak ' + (g.h.layak ? 'ya' : 'belum') + ')'], ['Status', g.status], ['Entry limit', g.entry], ['SL', g.sl], ['TP1', g.tp1], ['R:R', '1:' + g.rr]]);
      if (mt5) await realAnalyst(mt5, st, cfg, g, sym, price);
      const aCls = { ...AUTO, ...(cfg.auto || {}) }, planAuto = aCls.mode === 'plan' && !cfg.m15Go;
      // Mode plan (real): pasang LIMIT di zona plan H1 selagi harga belum masuk zona (tidak menunggu konfirmasi M15).
      if (mt5 && planAuto && planReady(g, aCls, cfg))
        await autoReport(st, cfg, await autoQueue(mt5, cfg, g, sym, price, st), g, sym);
      const eligible = nearReady(g, aCls, cfg), goKey = sym + '|real';
      // m15Go: satu kali per plan H1, langsung saat M15 siap (tidak bergantung kedip syarat). Mode lama: pemicu saat syarat baru terpenuhi.
      const siap = cfg.m15Go ? (eligible && st.go[goKey] !== planKey) : (eligible && (!prev.elig || !!(st.retrig || {})[sym])); if (st.retrig) delete st.retrig[sym];
      if (siap) {
        if (!cfg.m15Go || st.go[sym + '|ready'] !== planKey) {
        if (cfg.m15Go) st.go[sym + '|ready'] = planKey;
        ev(st, 'ANA', sym, `syarat inti ${g.ltf} terpenuhi (${g.m.ok}/7), ${g.htf} ${g.h.ok}/8, grade ${g.grade}`);
        await mail(st, cfg, 'M', `🎯 ${sym} ${g.dir}: entry ${g.ltf} siap (${g.m.ok}/7, grade ${g.grade})`, [['Simbol', sym], ['Arah', g.dir], ['Syarat entry', g.m.ok + '/7 (inti terpenuhi)'], ['Entry presisi', g.m.entry], ['SL', g.m.sl], ['TP1', g.m.tp != null ? g.m.tp : g.tp1], ['R:R', '1:' + g.m.rr], ['Risiko → potensi TP1', idr(st.balance * cfg.riskPct / 100) + ' → ' + idr(st.balance * cfg.riskPct / 100 * g.m.rr)]]);
        }
        if (mt5 && !planAuto) { const au = await autoQueue(mt5, cfg, g, sym, price, st); await autoReport(st, cfg, au, g, sym); if (cfg.m15Go && au.cmd) st.go[goKey] = planKey; }
      }
      // PAPER: eksekusi sesuai pilihan. 'm15' = entry/SL/TP M15 saat syarat M15 terpenuhi; 'konfirm' = saat M15 terpenuhi, ambil SL/TP plan H1; 'h1' = pending LIMIT plan H1 (di atas).
      const pMode = pModeEff, pEl = nearReady(g, { cls: cfg.paperCls || 'low', minSkor: cfg.paperMinSkor || 70 }, cfg), pKey = sym + '|paper', pSiap = cfg.m15Go ? (pEl && st.go[pKey] !== planKey) : (pEl && !prev.pElig);
      if (pSiap && (pMode === 'm15' || pMode === 'konfirm') && cfg.paperPlan !== false) {
        const kind = pMode === 'm15' ? 'M15' : 'KONF', buy = g.dir === 'BUY', en = g.m.entry;
        const sl = pMode === 'm15' ? g.m.sl : g.sl, tp = pMode === 'm15' ? (g.m.tp != null ? g.m.tp : g.tp1) : g.tp1;
        const rk = Math.abs(en - sl), rr = rk > 0 ? +(Math.abs(tp - en) / rk).toFixed(2) : 0;
        const okSeq = buy ? sl < en && en < tp : tp < en && en < sl;
        let pRisk2 = Math.round(st.balance * cfg.riskPct / 100), slBad = null;
        if (pNeed) { const c = paperRisk(cfg, pSpecs, sym, Math.abs(en - sl), st.balance); if (!c.ok) slBad = c.msg; else pRisk2 = Math.round(c.cost); }
        if (!okSeq || rr < cfg.rr) { const m = `[${kind}] sinyal ${g.m.ok}/7 dilewati: ${!okSeq ? 'urutan entry/SL/TP tidak valid' : 'R:R 1:' + rr + ' di bawah minimum'}`; if (!cfg.m15Go || goOnce(pKey, m)) ev(st, 'ANA', sym, m); }
        else if (slBad) { const m = `[${kind}] sinyal ${g.m.ok}/7 dilewati: ${slBad}`; if (!cfg.m15Go || goOnce(pKey, m)) ev(st, 'ANA', sym, m); }
        else if (st.positions.some(x => x.s === sym && x.kind === kind) || st.positions.length >= cfg.maxOpen || st.balance <= 0) { const m = `[${kind}] sinyal ${g.m.ok}/7 dilewati: posisi/slot penuh`; if (!cfg.m15Go || goOnce(pKey, m)) ev(st, 'ANA', sym, m); }
        else {
          const b = cfg.aiOpen && !cfg.m15Go ? await brain(sym, { ...g, m15Min: cfg.m15Min, m: { ...g.m, sl, tp, rr } }) : { ok: true, note: cfg.m15Go ? 'tanpa Brain (mode M15 siap → langsung masuk)' : 'tanpa Brain' };
          ev(st, 'BRN', sym, (b.ok ? 'setuju: ' : 'menolak: ') + b.note);
          if (cfg.m15Go) st.go[pKey] = planKey;
          if (b.ok) {
            const pos = { id: Date.now().toString(36), kind, s: sym, a: asset, dir: g.dir, entry: en, sl, tp1: tp, tp2: pMode === 'konfirm' ? g.tp2 : null, rr, tOpen: Date.now(), lastT, bars: 0, riskRp: pRisk2, grade: g.grade, hOk: g.h.ok, mOk: g.m.ok, why: b.note };
            st.positions.push(pos); ev(st, 'EXE', sym, `[${kind}] ${g.dir} paper dibuka @${pos.entry} SL ${pos.sl} TP ${pos.tp1} (M15 ${g.m.ok}/7) · risiko ${idr(pos.riskRp)}`);
            await mail(st, cfg, 'Pos', `🚀 AI membuka posisi (paper, ${kind}): ${sym} ${g.dir}`, [['Simbol', sym], ['Arah', g.dir], ['Mode', cfg.m15Go ? 'M15 siap → langsung masuk' : kind === 'M15' ? 'Plan M15 (' + (cfg.m15Min || 6) + '/7)' : 'Konfirmasi M15 → plan H1'], ['Entry', pos.entry], ['SL', pos.sl], ['TP1', pos.tp1], ['R:R', '1:' + pos.rr], ['Risiko', idr(pos.riskRp)], ['Potensi TP1', idr(pos.riskRp * rr)], ['Saldo', idr(st.balance)], ['Alasan AI', b.note]]);
          }
        }
      }
      st.last[sym] = { status: g.status, hOk: g.h.ok, mOk: g.m.ok, price, t: lastT, closed: false, src, elig: eligible, pElig: pEl };
    } catch (e) { ev(st, 'SCN', sym, 'gagal: ' + String(e.message).slice(0, 80)); }
  }
  st.lastRun = Date.now();
  await store.setJSON('state', st);
  return { ok: true };
}
module.exports = { marketOpen, assetOf, htfData, effCfg, paperRisk, cancelReal, realAnalyst, judge, brainAuto, autoQueue, classPass, nearReady, planReady, runOnce, getCfg, getState, applyModal, fresh, testMail, DEF };
