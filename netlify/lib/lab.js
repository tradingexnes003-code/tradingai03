// M15 LAB: simulasi paper TERPISAH untuk membandingkan beberapa "plan M15" dengan H1.
// - Memakai penyimpanan sendiri (store 'lab'); TIDAK menulis ke state Control Tower, TIDAK menyentuh logika H1, TIDAK ada order real.
// - Satu pemindaian god() per simbol dipakai bersama oleh semua profil, jadi tidak menambah kuota data.
// - Semua hasil dalam satuan R (1R = jarak entry ke SL), sudah dikurangi biaya spread, supaya adil dibandingkan antar plan.
const core = require('./core');
const tower = require('./tower');
const { SIGS, EXTRA, guardSl, htfDir } = require('./labsig');

const BAD = ['TERLEWAT', 'BATAL', 'PASAR SEPI'];
const BAR_MIN = 15;
// Profil bawaan. Tiap profil = satu hipotesis cara memperbaiki winrate M15. Semuanya bisa diubah dari dashboard.
const PROFILES = {
  asis: { name: 'M15-ASIS', desc: 'Aturan M15 sekarang (market, 6/7, keluar saat God 62 berbalik). Pembanding untuk membuktikan masalahnya.', on: true, entry: 'market', hMin: 5, mMin: 6, exit: 'g62', tpR: 2, beR: 0, room: false, sess: null, cool: 0, reject: false, maxOpen: 3 },
  tp2: { name: 'M15-TP2', desc: 'Entry sama dengan ASIS, tetapi keluar di TP 2R + SL geser ke BE setelah +1R. Menguji apakah masalahnya ada di cara keluar.', on: true, entry: 'market', hMin: 5, mMin: 6, exit: 'tp', tpR: 2, beR: 1, room: false, sess: null, cool: 0, reject: false, maxOpen: 3 },
  zona: { name: 'M15-ZONA', desc: 'LIMIT di tepi zona H1, hanya terisi jika candle M15 menolak zona (tutup kembali searah), sesi aktif, TP 2R + BE.', on: true, entry: 'limit', hMin: 6, mMin: 0, exit: 'tp', tpR: 2, beR: 1, room: true, sess: [7, 20], cool: 8, reject: true, maxOpen: 3 },
  selektif: { name: 'M15-SELEKTIF', desc: 'Market hanya jika M15 7/7, H1 7/8, ada ruang ke target H1, sesi aktif, jeda setelah rugi. Sedikit trade, kualitas tinggi.', on: true, entry: 'market', hMin: 7, mMin: 7, exit: 'tp', tpR: 2, beR: 1, room: true, sess: [7, 20], cool: 8, reject: false, maxOpen: 3 }
};
Object.assign(PROFILES, EXTRA);
const DEF = { enabled: true, costR: 0.1, onlyExness: true, profiles: {} };
const fresh = () => ({ open: {}, pend: {}, trades: {}, elig: {}, until: {}, used: {}, skip: {}, last: {}, log: [], since: Date.now(), lastRun: null });

const getCfg = async store => {
  const c = (await store.get('config', { type: 'json' }).catch(() => null)) || {};
  const profiles = {}; for (const id of Object.keys(PROFILES)) profiles[id] = { ...PROFILES[id], ...((c.profiles || {})[id] || {}) };
  return { enabled: c.enabled !== false, costR: isFinite(c.costR) ? +c.costR : DEF.costR, onlyExness: c.onlyExness !== false, profiles };
};
const getState = async store => ({ ...fresh(), ...((await store.get('state', { type: 'json' }).catch(() => null)) || {}) });
const hourOf = t => { const h = parseInt(String(t).slice(11, 13), 10); return isFinite(h) ? h : null; };
const inSess = (p, t) => { if (!p.sess) return true; const h = hourOf(t); if (h == null) return true; const [a, b] = p.sess; return a <= b ? h >= a && h < b : h >= a || h < b; };
const ev = (st, s, m) => { st.log.unshift({ t: Date.now(), s, m }); if (st.log.length > 60) st.log.length = 60; };
const sgn = d => (d === 'BUY' ? 1 : -1);

// Biaya spread dalam R: dari spesifikasi EA bila ada (spread dalam satuan harga), selain itu biaya tetap costR.
function costOf(specs, sym, risk, costR) {
  try {
    const nm = core.exName(sym).replace(/[^A-Za-z0-9._#-]/g, '').slice(0, 24), sp = (specs || []).find(x => x.s === nm);
    if (sp && sp.spr > 0 && risk > 0) return +Math.min(1, sp.spr / risk).toFixed(3);
  } catch (e) { /* abaikan */ }
  return costR;
}

function close(st, id, p, res, px, lastT, costR) {
  const risk = Math.abs(p.entry - p.sl0) || 1e-9, gross = sgn(p.dir) * (px - p.entry) / risk, R = +(gross - p.cost).toFixed(2), pct = +(sgn(p.dir) * (px - p.entry) / p.entry * 100).toFixed(3);
  (st.trades[id] = st.trades[id] || []).unshift({ s: p.s, dir: p.dir, entry: p.entry, sl: p.sl0, tp: p.tp, res, exit: px, R, cost: p.cost, tOpen: p.tOpen, tClose: Date.now(), bar: p.t0, hour: hourOf(p.t0), hOk: p.hOk, mOk: p.mOk, be: !!p.be, trl: !!p.trl, sig: p.sig || null, pct, tb: lastT });
  if (st.trades[id].length > 200) st.trades[id].length = 200;
  st.open[id] = (st.open[id] || []).filter(x => x !== p);
  return R;
}

// Satu langkah untuk satu profil dan satu simbol. g = hasil core.god (dihitung sekali dengan m15Min=1), v = candle M15 tertutup.
function stepProfile(st, id, P, cfg, sym, g, v, specs, asset, vh = []) {
  const lastT = v[v.length - 1].t, price = v[v.length - 1].c, key = id + '|' + sym, A = core.atr(v);
  st.open[id] = st.open[id] || []; st.pend[id] = st.pend[id] || []; st.used = st.used || {}; st.elig = st.elig || {}; st.until = st.until || {};
  // 1) posisi terbuka: SL dulu bila SL dan TP tersentuh di candle yang sama (konservatif)
  for (const p of st.open[id].filter(x => x.s === sym)) {
    let res = null, px = null; const risk = Math.abs(p.entry - p.sl0), b = sgn(p.dir);
    for (const x of v.filter(c => c.t > p.lastT)) {
      p.bars++;
      if (b > 0 ? x.l <= p.sl : x.h >= p.sl) { res = p.trl ? 'TRAIL' : p.be && Math.abs(p.sl - p.entry) < 1e-9 ? 'BE' : 'SL'; px = p.sl; break; }
      if (P.exit === 'tp' && p.tp != null && (b > 0 ? x.h >= p.tp : x.l <= p.tp)) { res = 'TP'; px = p.tp; break; }
      if (P.beR > 0 && !p.be && (b > 0 ? x.h - p.entry : p.entry - x.l) >= P.beR * risk) { p.be = true; p.sl = p.entry; } // berlaku mulai candle berikutnya
      if (P.trail > 0 && p.atr) { // SL mengekor: mulai setelah untung >= trailAt R, mengikuti ekstrem candle, berlaku mulai candle berikutnya
        const fav = b > 0 ? x.h - p.entry : p.entry - x.l;
        if (fav >= (P.trailAt || 1) * risk) { const ns = b > 0 ? x.h - P.trail * p.atr : x.l + P.trail * p.atr; if (b > 0 ? ns > p.sl : ns < p.sl) { p.sl = ns; p.trl = true; } }
      }
    }
    p.lastT = lastT;
    if (!res && P.exit === 'g62' && g.g62 && g.g62.state && (p.dir === 'BUY') !== (g.g62.state === 'BUY')) { res = 'G62'; px = price; }
    if (!res && p.bars >= (P.exit === 'g62' ? 1000 : 96)) { res = 'TIMEOUT'; px = price; }
    if (res) {
      const R = close(st, id, p, res, px, lastT, cfg.costR);
      if (R <= 0 && P.cool > 0) st.until[key] = { bars: P.cool, from: lastT, n: 0 };
      ev(st, id, `${sym} ${p.dir} ditutup ${res} ${R > 0 ? '+' : ''}${R}R`);
    }
  }
  // 2) pending LIMIT
  for (const q of st.pend[id].filter(x => x.s === sym)) {
    let fill = null, why = null; const b = sgn(q.dir);
    for (const x of v.filter(c => c.t > q.lastT)) {
      q.bars++;
      if (b > 0 ? x.l <= q.sl : x.h >= q.sl) { why = 'zona jebol sebelum terisi'; break; }
      if (q.tp != null && (b > 0 ? x.h >= q.tp : x.l <= q.tp)) { why = 'target tercapai sebelum terisi'; break; }
      const touch = b > 0 ? x.l <= q.entry : x.h >= q.entry;
      if (touch && inSess(P, x.t)) {
        const rej = b > 0 ? x.c > q.entry : x.c < q.entry; // candle menolak zona: tutup kembali searah
        if (!P.reject || rej) { fill = x; break; }
      }
    }
    if (!fill && !why && q.bars >= (q.exp || 64)) why = 'kedaluwarsa (' + (q.exp || 64) + ' candle)';
    if (fill) {
      const cost = costOf(specs, sym, Math.abs(q.entry - q.sl), cfg.costR);
      const p = { s: sym, a: asset, dir: q.dir, entry: q.entry, sl: q.sl, sl0: q.sl, tp: q.tp, rr: q.rr, tOpen: Date.now(), t0: fill.t, lastT: fill.t, bars: 0, cost, hOk: q.hOk, mOk: q.mOk, be: false, atr: A, sig: q.sig || null };
      st.pend[id] = st.pend[id].filter(x => x !== q); st.open[id].push(p);
      // candle pengisi: bila SL ikut tersentuh di candle yang sama, hitung rugi (konservatif)
      if (b > 0 ? fill.l <= p.sl : fill.h >= p.sl) { close(st, id, p, 'SL', p.sl, lastT, cfg.costR); if (P.cool > 0) st.until[key] = { bars: P.cool, from: lastT, n: 0 }; ev(st, id, `${sym} ${p.dir} terisi lalu SL di candle yang sama -1R`); }
      else { p.lastT = fill.t; ev(st, id, `${sym} ${p.dir} LIMIT terisi @${p.entry} SL ${p.sl} TP ${p.tp}`); }
    } else if (why) { st.pend[id] = st.pend[id].filter(x => x !== q); ev(st, id, `${sym} ${q.dir} @${q.entry} dibatalkan: ${why}`); }
    else q.lastT = lastT;
  }
  // jeda setelah rugi (dihitung per candle yang sudah berlalu)
  const u = st.until[key]; let coolOn = false;
  if (u && typeof u === 'object') { u.n += v.filter(c => c.t > (u.seen || u.from)).length; u.seen = lastT; if (u.n >= u.bars) delete st.until[key]; else coolOn = true; }
  // 3) sinyal baru
  const planKey = [g.dir, g.entry, g.sl, g.tp1].join('|'), has = st.open[id].some(x => x.s === sym) || st.pend[id].some(x => x.s === sym), total = st.open[id].length + st.pend[id].length;
  const hOk = g.h.ok >= P.hMin && !BAD.includes(g.status) && g.sl != null && g.tp1 != null;
  if (P.entry === 'limit') {
    const pl = g.m && g.m.plan, buy = g.dir === 'BUY';
    const cur = st.pend[id].find(x => x.s === sym);
    const valid = hOk && pl && pl.entry != null && (buy ? pl.entry <= price : pl.entry >= price) && (pl.rr || 0) >= Math.max(P.tpR, 2) && (!P.room || (g.rr || 0) >= g.minRR);
    if (cur && (!valid || cur.planKey !== planKey)) { st.pend[id] = st.pend[id].filter(x => x !== cur); ev(st, id, `${sym} plan LIMIT diganti/dibatalkan (plan H1 berubah)`); }
    if (valid && !has && !coolOn && total < P.maxOpen && !st.pend[id].some(x => x.s === sym) && (st.used[key] !== planKey || false)) {
      const risk = Math.abs(pl.entry - pl.sl), tp = buy ? pl.entry + P.tpR * risk : pl.entry - P.tpR * risk;
      st.pend[id].push({ s: sym, dir: g.dir, entry: pl.entry, sl: pl.sl, tp: +tp.toFixed(price > 100 ? 2 : 5), rr: pl.rr, planKey, lastT, bars: 0, hOk: g.h.ok, mOk: g.m.ok });
      ev(st, id, `${sym} ${g.dir} LIMIT dipasang @${pl.entry} SL ${pl.sl} TP ${P.tpR}R`);
    }
  } else if (P.entry === 'sig') {
    const S = SIGS[P.sig];
    if (S && g.h.ok >= P.hMin && inSess(P, lastT) && !has && !coolOn && total < P.maxOpen) {
      let sg = null; try { sg = S({ v, vh, g, P, A, price, lastT }); } catch (e) { sg = null; st.sigErr = st.sigErr || {}; if (st.sigErr[id] !== e.message) { st.sigErr[id] = e.message; ev(st, 'ERR', `sinyal ${P.sig}: ${String(e.message).slice(0, 80)}`); } }
      if (sg && sg.tag !== st.used[key]) {
        const buy = sg.dir === 'BUY', en = sg.entry, sl = guardSl(sg.dir, en, sg.sl, A, sg._atrPad || 0);
        if (sl != null) {
          const risk = Math.abs(en - sl), d = price > 1000 ? 2 : price > 100 ? 3 : 5, tp = P.exit === 'tp' ? +(buy ? en + P.tpR * risk : en - P.tpR * risk).toFixed(d) : null;
          st.used[key] = sg.tag;
          if (sg.mode === 'limit') { st.pend[id].push({ s: sym, dir: sg.dir, entry: +en.toFixed(d), sl: +sl.toFixed(d), tp, rr: P.tpR, planKey: sg.tag, sig: P.sig, lastT, bars: 0, exp: sg.expire || 8, hOk: g.h.ok, mOk: g.m.ok }); ev(st, id, `${sym} ${sg.dir} LIMIT sinyal ${P.sig} @${en.toFixed(d)} SL ${sl.toFixed(d)}`); }
          else { st.open[id].push({ s: sym, a: asset, dir: sg.dir, entry: +en.toFixed(d), sl: +sl.toFixed(d), sl0: +sl.toFixed(d), tp, rr: P.tpR, tOpen: Date.now(), t0: lastT, lastT, bars: 0, cost: costOf(specs, sym, risk, cfg.costR), hOk: g.h.ok, mOk: g.m.ok, be: false, atr: A, sig: P.sig }); ev(st, id, `${sym} ${sg.dir} masuk sinyal ${P.sig} @${en.toFixed(d)} SL ${sl.toFixed(d)}${tp ? ' TP ' + tp : ' (SL mengekor)'}`); }
        }
      }
    }
  } else {
    const ok = hOk && g.m.ok >= P.mMin && g.m.entry != null && inSess(P, lastT) && (!P.room || g.m.tpBasis === 'struktur H1');
    const edge = ok && !st.elig[key];
    st.elig[key] = ok;
    if (edge && !has && !coolOn && total < P.maxOpen) {
      const buy = g.dir === 'BUY', en = g.m.entry, sl = g.m.sl, risk = Math.abs(en - sl);
      if (risk > 0) {
        const tp = P.exit === 'tp' ? +(buy ? en + P.tpR * risk : en - P.tpR * risk).toFixed(price > 100 ? 2 : 5) : null;
        const p = { s: sym, a: asset, dir: g.dir, entry: en, sl, sl0: sl, tp, rr: g.m.rr, tOpen: Date.now(), t0: lastT, lastT, bars: 0, cost: costOf(specs, sym, risk, cfg.costR), hOk: g.h.ok, mOk: g.m.ok, be: false, atr: A };
        st.open[id].push(p); st.used[key] = planKey;
        ev(st, id, `${sym} ${g.dir} market @${en} SL ${sl}${tp ? ' TP ' + tp : ' keluar saat God 62 berbalik'} (H1 ${g.h.ok}/8, M15 ${g.m.ok}/7)`);
      }
    }
  }
}

// ---------- Uji Trading God62 Baru: stop-and-reverse ----------
function stepFlip(st, id, P, cfg, sym, g, v, specs, asset, vh = []) {
  const x = v[v.length - 1], lastT = x.t, price = x.c, key = id + '|' + sym, A = core.atr(v), state = g.g62 && g.g62.state;
  st.open[id] = st.open[id] || []; st.flip = st.flip || {};
  if (!state || !(A > 0)) return;
  const prev = st.flip[key], seen = (st.last[sym] || {}).t; st.flip[key] = state;
  const ms = t => Date.parse(String(t).replace(' ', 'T') + 'Z'), gap = seen ? (ms(lastT) - ms(seen)) / 60000 : 0, d = price > 1000 ? 2 : price > 100 ? 3 : 5;
  // 1) posisi terbuka: SL keras (bila ada), lalu keluar saat God 62 berbalik
  for (const p of st.open[id].filter(o => o.s === sym)) {
    let res = null, px = null; const b = sgn(p.dir), news = v.filter(c => c.t > p.lastT);
    if (p.hard) { for (const c of news) { p.bars++; if (b > 0 ? c.l <= p.sl : c.h >= p.sl) { res = 'SL'; px = p.sl; break; } } } else p.bars += news.length;
    p.lastT = lastT;
    if (!res && p.dir !== state) { res = 'FLIP'; px = price; }
    if (res) { const R = close(st, id, p, res, px, lastT, cfg.costR), t = st.trades[id][0]; ev(st, id, `${sym} ${p.dir} ditutup ${res} ${t.pct > 0 ? '+' : ''}${t.pct}% (${R > 0 ? '+' : ''}${R}R)`); }
  }
  // 2) masuk hanya pada pembalikan nyata yang terlihat oleh lab (bukan menebak posisi sebelum lab jalan)
  if (!prev || prev === state || st.open[id].some(o => o.s === sym)) return;
  if (gap > 45) { ev(st, id, `${sym} flip ${state} terlewat (data terakhir ${Math.round(gap)} menit lalu), menunggu flip berikutnya`); return; }
  if (P.trendFilter && htfDir(vh) !== state) { ev(st, id, `${sym} flip ${state} dilewati: tidak searah tren EMA H1`); return; }
  const unit = P.riskAtr * A, buy = state === 'BUY', sl0 = +(buy ? price - unit : price + unit).toFixed(d);
  st.open[id].push({ s: sym, a: asset, dir: state, entry: price, sl: P.hardSl ? sl0 : null, sl0, tp: null, tOpen: Date.now(), t0: lastT, lastT, bars: 0, cost: costOf(specs, sym, unit, cfg.costR), hOk: g.h.ok, mOk: g.m.ok, be: false, atr: A, hard: !!P.hardSl, sig: 'flip' });
  ev(st, id, `${sym} FLIP → ${state} @${price}${P.hardSl ? ' SL ' + sl0 : ' (tanpa SL)'} (candle ${lastT})`);
}

// ---------- statistik ----------
function wilsonLow(w, n) { if (!n) return 0; const z = 1.96, p = w / n, d = 1 + z * z / n, c = p + z * z / (2 * n), a = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return Math.max(0, (c - a) / d); }
function stats(tr, minN = 30) {
  const n = tr.length; if (!n) return { n: 0, verdict: 'belum ada trade' };
  const w = tr.filter(x => x.R > 0).length, l = tr.filter(x => x.R <= 0).length, sw = tr.filter(x => x.R > 0).reduce((a, b) => a + b.R, 0), sl = -tr.filter(x => x.R <= 0).reduce((a, b) => a + b.R, 0);
  let eq = 0, pk = 0, dd = 0; [...tr].reverse().forEach(x => { eq += x.R; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); });
  const tot = tr.reduce((a, b) => a + b.R, 0), exp = tot / n, pf = sl > 0 ? sw / sl : (sw > 0 ? 99 : 0), lo = wilsonLow(w, n);
  const res = {}; tr.forEach(x => { res[x.res] = (res[x.res] || 0) + 1; });
  const SES = { asia: [0, 7], london: [7, 13], ny: [13, 20], malam: [20, 24] }, ses = {};
  for (const [k, [a, b]] of Object.entries(SES)) { const q = tr.filter(x => x.hour != null && x.hour >= a && x.hour < b); if (q.length) ses[k] = { n: q.length, wr: Math.round(q.filter(x => x.R > 0).length / q.length * 100), R: +q.reduce((s, x) => s + x.R, 0).toFixed(1) }; }
  const r20 = tr.slice(0, 20), wr20 = r20.length ? Math.round(r20.filter(x => x.R > 0).length / r20.length * 100) : null;
  const pr = tr.filter(x => x.pct != null), avg = a => (a.length ? +(a.reduce((s, x) => s + x.pct, 0) / a.length).toFixed(3) : null);
  const avgPct = avg(pr), avgWinPct = avg(pr.filter(x => x.pct > 0)), avgLossPct = avg(pr.filter(x => x.pct <= 0)), totPct = pr.length ? +pr.reduce((s, x) => s + x.pct, 0).toFixed(2) : null;
  const bySym = {}; tr.forEach(x => { const o = bySym[x.s] = bySym[x.s] || { n: 0, w: 0, R: 0 }; o.n++; if (x.R > 0) o.w++; o.R += x.R; }); Object.values(bySym).forEach(o => { o.wr = Math.round(o.w / o.n * 100); o.R = +o.R.toFixed(1); });
  const sy = new Set(tr.map(x => x.s)).size, mean = a => (a.length ? a.reduce((s, x) => s + x.R, 0) / a.length : 0), hf = Math.floor(n / 2), expNew = mean(tr.slice(0, hf)), expOld = mean(tr.slice(hf));
  let verdict;
  if (n < minN) verdict = `data kurang (${n}/${minN})`;
  else if (exp > 0) {
    // Dengan banyak plan diuji bersamaan, ada yang tampak bagus hanya karena kebetulan. Karena itu 'layak' wajib: PF, batas bawah WR, minimal 3 simbol, dan positif di kedua paruh periode.
    const why = []; if (pf < 1.2) why.push('PF rendah'); if (lo < 0.35) why.push('WR belum meyakinkan'); if (sy < 3) why.push(`baru ${sy} simbol`); if (!(expNew > 0 && expOld > 0)) why.push('tidak konsisten antar-paruh');
    verdict = why.length ? 'positif, belum teruji: ' + why.join(', ') : 'layak dilanjutkan';
  } else verdict = 'belum layak';
  return { n, w, l, wr: Math.round(w / n * 100), wrLow: Math.round(lo * 100), exp: +exp.toFixed(2), pf: +pf.toFixed(2), dd: +dd.toFixed(1), tot: +tot.toFixed(1), res, ses, wr20, sy, avgPct, avgWinPct, avgLossPct, totPct, bySym, verdict };
}

// Baseline dari Control Tower (hanya dibaca): H1 plan dan M15 yang sedang berjalan, R dikurangi biaya yang sama.
function baseline(tst, costR) {
  const h = (tst.history || []).map(x => ({ ...x, R: +((+x.R || 0) - costR).toFixed(2), hour: hourOf(x.bar) }));
  const by = f => h.filter(f);
  return { h1: by(x => (x.kind || 'H1') === 'H1'), m15: by(x => x.kind === 'M15' || x.kind === 'KONF') };
}

async function summary(store, tstore) {
  const cfg = await getCfg(store), st = await getState(store), tst = await tower.getState(tstore, await tower.getCfg(tstore)), b = baseline(tst, cfg.costR);
  const rows = [
    { id: 'base_h1', name: 'H1 plan (Control Tower, real-paper)', base: true, ...stats(b.h1) },
    { id: 'base_m15', name: 'M15 di Control Tower sekarang', base: true, ...stats(b.m15) }
  ];
  for (const [id, P] of Object.entries(cfg.profiles)) rows.push({ id, name: P.name, desc: P.desc, on: P.on, params: { riskAtr: P.riskAtr, hardSl: P.hardSl, trendFilter: P.trendFilter, entry: P.entry, sig: P.sig, hMin: P.hMin, mMin: P.mMin, exit: P.exit, tpR: P.tpR, beR: P.beR, room: P.room, sess: P.sess, cool: P.cool, reject: P.reject }, open: (st.open[id] || []).length, pend: (st.pend[id] || []).length, ...stats(st.trades[id] || []) });
  const openPos = {}; for (const [id, P] of Object.entries(cfg.profiles)) if (P.entry === 'flip') openPos[id] = (st.open[id] || []).map(p => { const px = (st.last[p.s] || {}).price; return { s: p.s, dir: p.dir, entry: p.entry, since: p.t0, price: px != null ? px : null, pct: px ? +(sgn(p.dir) * (px - p.entry) / p.entry * 100).toFixed(2) : null }; });
  const pending = []; for (const [id, P] of Object.entries(cfg.profiles)) for (const q of (st.pend[id] || [])) { const px = (st.last[q.s] || {}).price; pending.push({ plan: P.name, s: q.s, dir: q.dir, entry: q.entry, sl: q.sl, tp: q.tp, bars: q.bars, price: px != null ? px : null, distPct: px ? +(Math.abs(px - q.entry) / px * 100).toFixed(2) : null }); }
  return { cfg, since: st.since, lastRun: st.lastRun, symbols: st.last, skip: st.skip || {}, pending, rows, log: st.log.slice(0, 30), openPos, recent: Object.fromEntries(Object.keys(cfg.profiles).map(id => [id, (st.trades[id] || []).slice(0, 12)])) };
}

// ---------- pemindaian ----------
const defaultLoader = async (store, sym, tcfg, labCfg = {}) => {
  const ivs = [tcfg.ltf, tcfg.htf], src = await core.pickSource(sym, ivs);
  // Lab hanya memakai data Exness (bila EA dipakai) agar zona dan plan tidak berganti-ganti antara dua feed harga, dan agar kuota Twelve Data tidak terpakai.
  if (labCfg.onlyExness !== false && (process.env.DATA_SOURCE || 'twelve') !== 'twelve' && src !== 'exness') {
    const e = new Error('dilewati: data Exness belum siap (' + ((await core.sourceWhy(sym, ivs)) || 'tidak diketahui') + ')'); e.skip = true; throw e;
  }
  const v = (await core.candles(sym, tcfg.ltf, 100, 50000, src)).slice(0, -1), vh = await tower.htfData(store, sym, tcfg.htf, src);
  return { v, vh, src };
};
async function runLab(store, tstore, mt5, manual, loader = defaultLoader) {
  const lk = await store.get('run_lock', { type: 'json' }).catch(() => null);
  if (lk && Date.now() - lk.t < 100000) return { skipped: true };
  await store.setJSON('run_lock', { t: Date.now() }).catch(() => null);
  try {
    const cfg = await getCfg(store), tcfg = await tower.getCfg(tstore);
    if (!cfg.enabled || (!tcfg.enabled && !manual)) return { skipped: 'nonaktif' };
    core.setStore(tstore); // arahkan core ke penyimpanan data EA (px_*); tanpa ini pickSource selalu memilih Twelve Data
    const st = await getState(store), specs = mt5 ? ((await mt5.get('account_report', { type: 'json' }).catch(() => null)) || {}).specs : null;
    const syms = (Array.isArray(tcfg.symbols) ? tcfg.symbols : []).filter((it, i, a) => it && it.s && a.findIndex(x => x && String(x.s).toUpperCase().replace(/[^A-Z0-9]/g, '') === String(it.s).toUpperCase().replace(/[^A-Z0-9]/g, '')) === i).slice(0, 6);
    for (const it of syms) {
      const sym = it.s, asset = tower.assetOf(sym, it.a);
      if (!tower.marketOpen(asset)) continue;
      try {
        const { v, vh, src } = await loader(tstore, sym, tcfg, cfg), lastT = v[v.length - 1].t;
        if ((st.last[sym] || {}).t === lastT) continue; // belum ada candle M15 baru
        const g = core.god(vh, v, tcfg.rr, { h: tcfg.htf, l: tcfg.ltf, m15Min: 1 });
        for (const [id, P] of Object.entries(cfg.profiles)) { if (P.on) (P.entry === 'flip' ? stepFlip : stepProfile)(st, id, P, cfg, sym, g, v, specs, asset, vh); }
        st.last[sym] = { t: lastT, status: g.status, hOk: g.h.ok, mOk: g.m.ok, price: v[v.length - 1].c, dir: g.dir, src: src || null, vol: v.slice(-21).every(x => x.vol > 0) ? 'tick' : 'proxy', at: Date.now() };
        if (st.skip) delete st.skip[sym];
      } catch (e) {
        if (e.skip) { st.skip = st.skip || {}; if (st.skip[sym] !== e.message) { st.skip[sym] = e.message; ev(st, 'SKIP', `${sym} ${e.message}`.slice(0, 140)); } }
        else ev(st, 'ERR', `${sym}: ${String(e.message).slice(0, 80)}`);
      }
    }
    st.lastRun = Date.now(); await store.setJSON('state', st);
    return { ok: true };
  } finally { await store.setJSON('run_lock', { t: 0 }).catch(() => null); }
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, +x));
// Simpan konfigurasi (daftar putih; hanya parameter yang aman).
async function setConfig(store, body) {
  const cur = (await store.get('config', { type: 'json' }).catch(() => null)) || {}, nx = { ...cur, profiles: { ...(cur.profiles || {}) } };
  if (typeof body.enabled === 'boolean') nx.enabled = body.enabled;
  if (isFinite(body.costR)) nx.costR = clamp(body.costR, 0, 1);
  if (typeof body.onlyExness === 'boolean') nx.onlyExness = body.onlyExness;
  for (const [id, x] of Object.entries(body.profiles || {})) {
    if (!PROFILES[id] || !x || typeof x !== 'object') continue; const p = nx.profiles[id] = { ...(nx.profiles[id] || {}) };
    if (typeof x.on === 'boolean') p.on = x.on;
    if (['market', 'limit'].includes(x.entry) && !['sig', 'flip'].includes(PROFILES[id].entry)) p.entry = x.entry;
    if (isFinite(x.riskAtr)) p.riskAtr = clamp(x.riskAtr, 1, 6);
    if (typeof x.hardSl === 'boolean') p.hardSl = x.hardSl;
    if (typeof x.trendFilter === 'boolean') p.trendFilter = x.trendFilter;
    if (isFinite(x.volX)) p.volX = clamp(x.volX, 1.1, 5);
    if (isFinite(x.trail)) p.trail = clamp(x.trail, 0, 5);
    if (isFinite(x.trailAt)) p.trailAt = clamp(x.trailAt, 0, 3);
    if (['g62', 'tp'].includes(x.exit)) p.exit = x.exit;
    if (isFinite(x.hMin)) p.hMin = Math.round(clamp(x.hMin, 3, 8));
    if (isFinite(x.mMin)) p.mMin = Math.round(clamp(x.mMin, 0, 7));
    if (isFinite(x.tpR)) p.tpR = clamp(x.tpR, 1, 5);
    if (isFinite(x.beR)) p.beR = clamp(x.beR, 0, 3);
    if (isFinite(x.cool)) p.cool = Math.round(clamp(x.cool, 0, 96));
    if (typeof x.room === 'boolean') p.room = x.room;
    if (typeof x.reject === 'boolean') p.reject = x.reject;
    if (x.sess === null) p.sess = null; else if (Array.isArray(x.sess) && x.sess.length === 2 && x.sess.every(isFinite)) p.sess = [Math.round(clamp(x.sess[0], 0, 24)), Math.round(clamp(x.sess[1], 0, 24))];
  }
  await store.setJSON('config', nx);
}
const reset = store => store.setJSON('state', fresh());

module.exports = { PROFILES, getCfg, getState, runLab, summary, setConfig, reset, stepProfile, stepFlip, stats, fresh, costOf };
