// Uji syarat H1/M15 (core.js god()) pada data historis dari MT5. Jalankan: node tools/backtest.js data_M15.csv [opsi]
// Data: CSV M15 (kolom waktu, open, high, low, close; atau ekspor MT5 <DATE> <TIME> <OPEN> <HIGH> <LOW> <CLOSE>). Minimal ~3 bulan.
// Opsi: --rr=3 --m15min=6 --cost=0.1 --timeout=96 --from=2026-01-01
// Hasil dibandingkan: A = acuan H1 + entry M15, B = acuan H4 + entry H1, plus pembanding God 62 murni (reversal).
const fs = require('fs'), core = require('../netlify/lib/core.js');
const arg = Object.fromEntries(process.argv.slice(3).map(x => x.replace(/^--/, '').split('=')));
if (arg.exit === 'tp') process.env.EXIT_G62 = 'false'; // --exit=tp: pakai TP zona (rumus lama). Default: keluar saat sinyal God 62 berlawanan
const EXIT = process.env.EXIT_G62 !== 'false', RR = +(arg.rr || 3), M15MIN = +(arg.m15min || 6), COST = +(arg.cost || 0.1), TIMEOUT = +(arg.timeout || 96);
function load(f) {
  const out = [];
  for (const ln of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const p = ln.trim().split(/[,;\t]+/); if (p.length < 5) continue;
    let t, o;
    if (/^\d{4}[.\-/]\d{2}[.\-/]\d{2}$/.test(p[0]) && /^\d{1,2}:\d{2}/.test(p[1])) { t = p[0].replace(/[./]/g, '-') + ' ' + p[1].slice(0, 5).padStart(5, '0'); o = p.slice(2, 6); }
    else if (/^\d{9,10}$/.test(p[0])) { t = new Date(+p[0] * 1000).toISOString().slice(0, 16).replace('T', ' '); o = p.slice(1, 5); }
    else if (/^\d{4}[.\-/]\d{2}[.\-/]\d{2}/.test(p[0])) { t = p[0].replace(/[./]/g, '-').replace('T', ' ').slice(0, 16); o = p.slice(1, 5); }
    else continue;
    const [a, h, l, c] = o.map(Number); if ([a, h, l, c].some(x => !isFinite(x))) continue;
    out.push({ t, o: a, h, l, c });
  }
  return out;
}
const ep = x => Date.parse(x.replace(' ', 'T') + ':00Z') / 60000;
function run(m15, accMult, entMult, req) {
  process.env.G62_REQUIRED = req ? 'true' : 'false';
  const acc = core.resampleAlt(m15, accMult), ent = entMult === 1 ? m15 : core.resampleAlt(m15, entMult);
  const base = 15, accEnd = acc.map(x => ep(x.t) + base * accMult), entEnd = ent.map(x => ep(x.t) + base * entMult);
  // status sinyal God 62 pada akhir tiap bucket 2 jam (kunci = waktu akhir bucket, menit epoch)
  const gb = core.resampleAlt(m15, 8), gC = core.alma(gb.map(x => x.c)), gO = core.alma(gb.map(x => x.o)), gMap = new Map();
  gb.forEach((x, k) => { if (gC[k] != null && gO[k] != null) gMap.set(ep(x.t) + 120, gC[k] > gO[k] ? 'BUY' : gC[k] < gO[k] ? 'SELL' : null); });
  const m15t = m15.map(x => ep(x.t)); const trades = []; let ai = 0, mi = 0, busyUntil = -1; const used = new Set();
  for (let i = 0; i < ent.length; i++) {
    const now = entEnd[i]; if (now <= busyUntil) continue;
    while (ai < acc.length && accEnd[ai] <= now) ai++;
    if (ai < 60 || i < 50) continue;
    const vh = acc.slice(Math.max(0, ai - 200), ai); vh.push({ ...vh[vh.length - 1] }); // candle "berjalan" tiruan, dibuang god()
    const ve = ent.slice(Math.max(0, i - 299), i + 1);
    let g; try { g = core.god(vh, ve, RR, { h: accMult === 4 ? '1h' : '4h', l: entMult === 1 ? '15min' : '1h', m15Min: M15MIN }); } catch (e) { continue; }
    if (g.m.entry == null || ['TERLEWAT', 'BATAL', 'PASAR SEPI'].includes(g.status)) continue;
    const key = g.h1time + g.dir + g.entry; if (used.has(key)) continue; used.add(key);
    const buy = g.dir === 'BUY', en = g.m.entry, sl = g.m.sl, tp = g.m.tp != null ? g.m.tp : g.tp1, risk = Math.abs(en - sl); if (!(risk > 0)) continue;
    while (mi < m15.length && m15t[mi] + base <= now) mi++;
    let R = null, n = 0, ex = null;
    const maxBars = EXIT ? 1500 : TIMEOUT * Math.max(1, entMult);
    for (let j = mi; j < m15.length && n < maxBars; j++, n++) {
      const x = m15[j], hitSl = buy ? x.l <= sl : x.h >= sl, hitTp = buy ? x.h >= tp : x.l <= tp;
      if (hitSl) { R = -1; ex = 'SL'; break; } if (hitTp) { R = Math.abs(tp - en) / risk; ex = 'TP'; break; }
      const gs = EXIT ? gMap.get(m15t[j] + base) : null;
      if (gs && gs !== (buy ? 'BUY' : 'SELL')) { R = (buy ? x.c - en : en - x.c) / risk; ex = 'G62'; break; }
      if (n === maxBars - 1) { R = (buy ? x.c - en : en - x.c) / risk; ex = 'TO'; }
    }
    if (R == null) continue;
    busyUntil = now + (n + 1) * base; R -= COST; trades.push({ t: ent[i].t, dir: g.dir, R, ex, g62: g.g62 && g.g62.aligned });
  }
  return trades;
}
function stat(tr) {
  if (!tr.length) return { n: 0 };
  const w = tr.filter(x => x.R > 0), l = tr.filter(x => x.R <= 0), sw = w.reduce((a, b) => a + b.R, 0), sl = -l.reduce((a, b) => a + b.R, 0);
  let eq = 0, pk = 0, dd = 0; tr.forEach(x => { eq += x.R; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); });
  return { n: tr.length, winrate: +(100 * w.length / tr.length).toFixed(1) + '%', expectancyR: +(eq / tr.length).toFixed(3), profitFactor: sl ? +(sw / sl).toFixed(2) : null, totalR: +eq.toFixed(1), maxDD_R: +dd.toFixed(1), TP: tr.filter(x => x.ex === 'TP').length, SL: tr.filter(x => x.ex === 'SL').length, keluar_G62: tr.filter(x => x.ex === 'G62').length, timeout: tr.filter(x => x.ex === 'TO').length, aligned_with_G62: tr.filter(x => x.g62).length };
}
if (require.main === module) {
  let m15 = load(process.argv[2] || ''); if (arg.from) m15 = m15.filter(x => x.t >= arg.from);
  if (m15.length < 2000) { console.log('Data kurang (' + m15.length + ' candle M15). Perlu minimal beberapa bulan.'); process.exit(1); }
  console.log(`Keluar: ${EXIT ? 'sinyal God 62 berlawanan (TP jauh sebagai pengaman)' : 'TP zona'}. Data: ${m15.length} candle M15, ${m15[0].t} s/d ${m15[m15.length - 1].t}. RR min ${RR}, M15 min ${M15MIN}/7, biaya ${COST}R/trade.`);
  for (const [name, am, em] of [['A  acuan H1 + entry M15', 4, 1], ['B  acuan H4 + entry H1', 16, 4]])
    console.log(name.padEnd(26), JSON.stringify(stat(run(m15, am, em, false))));
  // Pembanding: God 62 murni (dugaan) = stop-and-reverse pada tiap pembalikan sinyal TF 2 jam, tanpa SL/TP, hasil dalam persen harga.
  const b = core.resampleAlt(m15, 8), aC = core.alma(b.map(x => x.c)), aO = core.alma(b.map(x => x.o)); let pos = null; const rs = [];
  for (let i = 1; i < b.length; i++) { if (aC[i] == null || aO[i] == null || aC[i - 1] == null) continue;
    const st = aC[i] > aO[i] ? 1 : aC[i] < aO[i] ? -1 : 0, pv = aC[i - 1] > aO[i - 1] ? 1 : aC[i - 1] < aO[i - 1] ? -1 : 0;
    if (st && st !== pv) { if (pos) rs.push(pos.d * (b[i].c / pos.p - 1) * 100); pos = { d: st, p: b[i].c }; } }
  const w = rs.filter(x => x > 0), l = rs.filter(x => x <= 0);
  console.log('God 62 murni (reversal 2 jam)'.padEnd(26), JSON.stringify({ n: rs.length, winrate: rs.length ? +(100 * w.length / rs.length).toFixed(1) + '%' : null, avgPct: rs.length ? +(rs.reduce((a, c) => a + c, 0) / rs.length).toFixed(3) : null, profitFactor: l.length ? +(w.reduce((a, c) => a + c, 0) / -l.reduce((a, c) => a + c, 0)).toFixed(2) : null }));
}
module.exports = { load, run, stat };
