// 10 plan M15 tambahan untuk M15 Lab. Semua hanya simulasi paper; tidak menyentuh H1 atau akun real.
// Tiap sinyal membaca candle M15 TERTUTUP (v) dan H1 (vh), lalu mengembalikan null atau { dir, mode:'market'|'limit', entry, sl, tag, expire }.
const core = require('./core');

const last = a => a[a.length - 1];
const emaLast = (c, p) => last(core.ema(c, p));
// Arah tren H1 dari EMA20/EMA50 (independen dari God 62), dihitung dari candle H1 yang sudah tertutup.
function htfDir(vh) {
  const c = vh.slice(0, -1).map(x => x.c); if (c.length < 60) return null;
  const e20 = emaLast(c, 20), e50 = emaLast(c, 50), l = last(c);
  return e20 > e50 && l > e50 ? 'BUY' : e20 < e50 && l < e50 ? 'SELL' : null;
}
// Kekuatan volume sebuah candle terhadap rata-rata 20 candle sebelumnya.
// Memakai tick volume MT5 bila EA sudah mengirimnya (real:true); bila belum, memakai range candle sebagai pengganti (real:false).
function volRatio(v, i) {
  const prev = v.slice(Math.max(0, i - 20), i); if (prev.length < 10) return { r: 0, real: false };
  if (v[i].vol > 0 && prev.every(x => x.vol > 0)) return { r: v[i].vol / (prev.reduce((s, x) => s + x.vol, 0) / prev.length), real: true };
  const a = prev.reduce((s, x) => s + (x.h - x.l), 0) / prev.length;
  return { r: (v[i].h - v[i].l) / (a || 1e-9), real: false };
}
// Candle impuls: volume besar, badan besar, searah, dan menembus high/low 10 candle sebelumnya.
function impulse(v, i, dir, X, lb = 10) {
  const x = v[i], rng = x.h - x.l, body = Math.abs(x.c - x.o); if (!(rng > 0) || body < 0.6 * rng) return false;
  if ((dir === 'BUY') !== (x.c > x.o)) return false;
  const prev = v.slice(Math.max(0, i - lb), i); if (prev.length < lb) return false;
  if (!(dir === 'BUY' ? x.c > Math.max(...prev.map(y => y.h)) : x.c < Math.min(...prev.map(y => y.l)))) return false;
  return volRatio(v, i).r >= X;
}
// Retest: level ditembus (close melewati level +/- 0.15 ATR), harga kembali menyentuh level dan candle terakhir menolak (tutup searah).
function retest(v, A, dir, levels, K) {
  const n = v.length - 1, c = v.map(x => x.c), b = dir === 'BUY' ? 1 : -1, x = v[n];
  for (const p of levels) {
    const th = p + b * 0.15 * A; let j = -1;
    for (let k = Math.max(1, n - K); k <= n - 2; k++) { if (b > 0 ? (c[k] > th && c[k - 1] <= th) : (c[k] < th && c[k - 1] >= th)) { j = k; break; } }
    if (j < 0) continue;
    let lost = false; for (let k = j + 1; k <= n; k++) { if (b > 0 ? c[k] < p - 0.1 * A : c[k] > p + 0.1 * A) { lost = true; break; } }
    if (lost) continue;
    const touch = b > 0 ? (x.l <= p + 0.25 * A && x.l >= p - 0.5 * A) : (x.h >= p - 0.25 * A && x.h <= p + 0.5 * A);
    const conf = b > 0 ? (x.c > p && x.c > x.o) : (x.c < p && x.c < x.o);
    if (touch && conf) return { p, j };
  }
  return null;
}
const nearest = (arr, price, dir) => arr.map(o => o.p).filter(p => (dir === 'BUY' ? p < price : p > price)).sort((a, b) => Math.abs(a - price) - Math.abs(b - price)).slice(0, 6);
const rd = p => (p > 1000 ? p.toFixed(2) : p > 100 ? p.toFixed(3) : p.toFixed(5));

const SIGS = {
  // 1) Break level swing M15 lalu retest dengan candle konfirmasi (level lawan menjadi dukungan/hambatan).
  rt15: ({ v, g, A, price }) => {
    const dir = g.dir; if (!dir) return null;
    const pv = core.pivots(v.slice(-90), 3), lv = nearest(dir === 'BUY' ? pv.H : pv.L, price, dir), r = retest(v, A, dir, lv, 16); if (!r) return null;
    const x = last(v);
    return { dir, mode: 'market', entry: x.c, sl: dir === 'BUY' ? Math.min(x.l, r.p) - 0.3 * A : Math.max(x.h, r.p) + 0.3 * A, tag: 'rt15|' + dir + '|' + rd(r.p) };
  },
  // 2) Sama, tetapi levelnya swing H1 (lebih signifikan), retest dicari di M15.
  rth1: ({ v, vh, g, A, price }) => {
    const dir = g.dir; if (!dir || vh.length < 30) return null;
    const pv = core.pivots(vh.slice(0, -1).slice(-80), 3), lv = nearest(dir === 'BUY' ? pv.H : pv.L, price, dir), r = retest(v, A, dir, lv, 24); if (!r) return null;
    const x = last(v);
    return { dir, mode: 'market', entry: x.c, sl: dir === 'BUY' ? Math.min(x.l, r.p) - 0.3 * A : Math.max(x.h, r.p) + 0.3 * A, tag: 'rth1|' + dir + '|' + rd(r.p) };
  },
  // 3) Pin bar (ekor panjang) menolak support/resistance M15 atau H1, searah tren H1.
  srrej: ({ v, vh, g, A }) => {
    const dir = g.dir; if (!dir) return null;
    const x = last(v), rng = x.h - x.l, body = Math.abs(x.c - x.o); if (rng < 0.8 * A) return null;
    const m = core.pivots(v.slice(-90), 3), h = vh.length > 30 ? core.pivots(vh.slice(0, -1).slice(-60), 3) : { H: [], L: [] };
    const buy = dir === 'BUY', lv = (buy ? m.L : m.H).concat(buy ? h.L : h.H).map(o => o.p);
    const wick = buy ? Math.min(x.o, x.c) - x.l : x.h - Math.max(x.o, x.c);
    if (wick < 2 * Math.max(body, 0.1 * A)) return null;
    if (buy ? x.c < x.l + 0.6 * rng : x.c > x.h - 0.6 * rng) return null;
    const hit = lv.find(p => buy ? (x.l <= p + 0.3 * A && x.l >= p - 0.6 * A && x.c > p) : (x.h >= p - 0.3 * A && x.h <= p + 0.6 * A && x.c < p)); if (hit == null) return null;
    return { dir, mode: 'market', entry: x.c, sl: buy ? x.l - 0.3 * A : x.h + 0.3 * A, tag: 'srrej|' + dir + '|' + x.t };
  },
  // 4) Ikut candle volume besar yang menembus 10 candle terakhir, searah tren H1.
  vfol: ({ v, g, P }) => {
    const dir = g.dir, n = v.length - 1; if (!dir || !impulse(v, n, dir, P.volX || 1.8)) return null;
    const x = v[n]; return { dir, mode: 'market', entry: x.c, sl: dir === 'BUY' ? x.l : x.h, tag: 'vfol|' + x.t, _atrPad: 0.2 };
  },
  // 5) Candle volume besar lalu LIMIT di 50% range candle impuls (menunggu koreksi), kedaluwarsa 8 candle.
  vret: ({ v, g, P, price }) => {
    const dir = g.dir, n = v.length - 1; if (!dir) return null;
    for (let i = n; i >= n - 5; i--) {
      if (!impulse(v, i, dir, P.volX || 1.8)) continue;
      const x = v[i], en = (x.h + x.l) / 2, buy = dir === 'BUY';
      if (buy ? en >= price : en <= price) return null; // harga sudah di bawah/atas level entry
      if (v.slice(i + 1).some(y => (buy ? y.l <= en : y.h >= en))) return null; // koreksi sudah lewat
      return { dir, mode: 'limit', entry: en, sl: buy ? x.l : x.h, tag: 'vret|' + x.t, expire: 8, _atrPad: 0.2 };
    }
    return null;
  },
  // 6) Candle volume besar saat harga berada di zona plan H1.
  vzon: ({ v, g, A, P }) => {
    const dir = g.dir, n = v.length - 1, pl = g.m && g.m.plan; if (!dir || !pl || pl.entry == null) return null;
    const x = v[n], rng = x.h - x.l, buy = dir === 'BUY'; if (!(rng > 0) || Math.abs(x.c - x.o) < 0.5 * rng || buy !== (x.c > x.o)) return null;
    const inZone = buy ? (x.l <= pl.entry + 0.6 * A && x.c > pl.entry) : (x.h >= pl.entry - 0.6 * A && x.c < pl.entry); if (!inZone) return null;
    if (volRatio(v, n).r < (P.volX || 1.8)) return null;
    return { dir, mode: 'market', entry: x.c, sl: buy ? Math.min(x.l, pl.entry) : Math.max(x.h, pl.entry), tag: 'vzon|' + x.t, _atrPad: 0.3 };
  },
  // 7) Pullback ke EMA20 M15 searah tren EMA H1 (arah dari EMA, bukan God 62).
  emap: ({ v, vh, A }) => {
    const dir = htfDir(vh); if (!dir) return null;
    const c = v.map(x => x.c), e20 = emaLast(c, 20), e50 = emaLast(c, 50), x = last(v), buy = dir === 'BUY';
    if (buy ? !(e20 > e50 && x.l <= e20 + 0.1 * A && x.c > e20 && x.c > x.o && x.l >= e50 - 0.5 * A) : !(e20 < e50 && x.h >= e20 - 0.1 * A && x.c < e20 && x.c < x.o && x.h <= e50 + 0.5 * A)) return null;
    const t3 = v.slice(-3);
    return { dir, mode: 'market', entry: x.c, sl: buy ? Math.min(...t3.map(y => y.l)) : Math.max(...t3.map(y => y.h)), tag: 'emap|' + x.t, _atrPad: 0.3 };
  },
  // 8) Breakout 20 candle searah tren EMA H1, SL 1.5 ATR.
  dcb: ({ v, vh, A }) => {
    const dir = htfDir(vh); if (!dir) return null;
    const x = last(v), prev = v.slice(-21, -1), buy = dir === 'BUY', rng = x.h - x.l; if (prev.length < 20 || !(rng > 0) || Math.abs(x.c - x.o) < 0.5 * rng) return null;
    if (buy ? !(x.c > Math.max(...prev.map(y => y.h)) + 0.1 * A) : !(x.c < Math.min(...prev.map(y => y.l)) - 0.1 * A)) return null;
    return { dir, mode: 'market', entry: x.c, sl: buy ? x.c - 1.5 * A : x.c + 1.5 * A, tag: 'dcb|' + x.t };
  }
};

const base = { on: true, hMin: 5, mMin: 0, exit: 'tp', tpR: 2, beR: 1, room: false, sess: [7, 20], cool: 4, reject: false, maxOpen: 3 };
const EXTRA = {
  rt15: { ...base, name: 'M15-RETEST', desc: 'Level swing M15 ditembus lalu di-retest; masuk di candle penolakan, searah H1. TP 2R + BE.', entry: 'sig', sig: 'rt15' },
  rth1: { ...base, name: 'M15-RETEST-H1', desc: 'Level swing H1 ditembus lalu di-retest di M15 dengan candle penolakan. TP 2R + BE.', entry: 'sig', sig: 'rth1' },
  srrej: { ...base, name: 'M15-PINBAR-SR', desc: 'Pin bar menolak support/resistance M15 atau H1, searah H1. TP 2R + BE.', entry: 'sig', sig: 'srrej' },
  vfol: { ...base, name: 'M15-VOL-IKUT', desc: 'Ikut candle volume besar yang menembus 10 candle terakhir, searah H1. TP 2R + BE.', entry: 'sig', sig: 'vfol', volX: 1.8 },
  vret: { ...base, name: 'M15-VOL-RETEST', desc: 'Candle volume besar, lalu LIMIT di 50% candle impuls (menunggu koreksi). TP 2R + BE.', entry: 'sig', sig: 'vret', volX: 1.8 },
  vzon: { ...base, name: 'M15-VOL-ZONA', desc: 'Candle volume besar saat harga berada di zona plan H1. TP 2R + BE.', entry: 'sig', sig: 'vzon', volX: 1.8 },
  emap: { ...base, name: 'M15-EMA-PULLBACK', desc: 'Pullback ke EMA20 M15 searah tren EMA H1 (tanpa God 62). TP 2R + BE.', entry: 'sig', sig: 'emap', hMin: 0 },
  dcb: { ...base, name: 'M15-BREAKOUT20', desc: 'Breakout 20 candle searah tren EMA H1 (tanpa God 62), SL 1.5 ATR. TP 2R + BE.', entry: 'sig', sig: 'dcb', hMin: 0 },
  tp15: { ...base, name: 'M15-ASIS-TP1.5', desc: 'Entry ASIS (market 6/7), tetapi TP 1.5R dan BE di +0.8R. Menguji target yang lebih dekat.', entry: 'market', sig: null, mMin: 6, tpR: 1.5, beR: 0.8, sess: null, cool: 0 },
  trail: { ...base, name: 'M15-ASIS-TRAIL', desc: 'Entry ASIS, tanpa TP tetap: SL mengekor 1.5 ATR setelah +1R; keluar bila SL mengekor kena atau God 62 berbalik.', entry: 'market', sig: null, mMin: 6, exit: 'g62', tpR: 0, beR: 0, trail: 1.5, trailAt: 1, sess: null, cool: 0 }
};

// Uji Trading God62 Baru: stop-and-reverse seperti strategy TradingView "God 62 PERSONAL" (selalu ada posisi; masuk saat God 62 M15x8 berbalik, keluar saat berbalik lagi).
// 1R virtual = riskAtr x ATR(14) M15, hanya untuk membandingkan dengan plan lain. Varian tanpa SL meniru TradingView apa adanya.
const flipBase = { on: true, entry: 'flip', sig: null, hMin: 0, mMin: 0, exit: 'g62', tpR: 0, beR: 0, room: false, sess: null, cool: 0, reject: false, maxOpen: 6, riskAtr: 3, hardSl: false, trendFilter: false };
Object.assign(EXTRA, {
  g62tv: { ...flipBase, name: 'GOD62-BARU', desc: 'Persis seperti trade TradingView: masuk di harga saat God 62 (M15 x 8) berbalik, keluar saat berbalik lagi, tanpa SL dan tanpa filter. 1R virtual = 3 ATR.' },
  g62sl: { ...flipBase, name: 'GOD62-BARU+SL', hardSl: true, desc: 'Sama, tetapi ada SL keras 3 ATR (versi yang aman dipakai di MT5). Menunjukkan harga perlindungan SL.' },
  g62tf: { ...flipBase, name: 'GOD62-BARU+TREN-H1', trendFilter: true, desc: 'Sama, tetapi hanya masuk bila arah flip searah tren EMA20/50 H1. Menguji apakah filter H1 membantu atau malah mengurangi hasil.' }
});

// ---- Varian God62 Baru lanjutan. Dua varian terbaik uji sebelumnya dijadikan acuan (TRAIL dan TP1.5R, tidak diubah);
// 8 varian yang tidak lolos (SL2, BE, TP3R, KONFIRMASI, TREN-KUAT, SESI, VOLUME, KOMBO) dihapus dan diganti 30 varian turunan:
//  - Keluarga TRAIL (15): variasi jarak trailing, titik mulai trailing, lebar SL, dan satu filter/penambah per varian.
//  - Keluarga TARGET (15): variasi TP, lebar SL, dan satu filter/penambah per varian.
// Semuanya SL keras (EA MT5 mewajibkan SL); 1R virtual = riskAtr x ATR(14) M15. Varian baru mulai dari nol (tanpa history).
const NEWF = { ...flipBase, hardSl: true, riskAtr: 3, tpR: 0, beR: 0, trail: 0, trailAt: 1, confirmN: 0, erMin: 0, volX: 0, fam: 'ref' };
EXTRA.g62tr = { ...NEWF, name: 'GOD62-BARU+TRAIL', trail: 1.5, trailAt: 1, desc: 'ACUAN. SL 3 ATR; setelah +1R SL mengekor 1.5 ATR di belakang harga. Mengunci sebagian untung bila harga balik sebelum God 62 berbalik.' };
EXTRA.g62t15 = { ...NEWF, name: 'GOD62-BARU+TP1.5R', riskAtr: 2, tpR: 1.5, desc: 'ACUAN. SL 2 ATR, TP 1.5R. Keluar mana yang lebih dulu: TP, SL, atau God 62 berbalik.' };
const flags = (p, fam) => (p.beR ? ` +BE${p.beR}` : '') + (p.trendFilter ? ' +H1' : '') + (p.erMin ? ' +ER' : '') + (fam === 'trail' && p.tpR ? ` +TP${p.tpR}R` : '') + (fam === 'target' && p.trail ? ` +TR${p.trail}x@${p.trailAt}R` : '');
const addFam = (id, fam, p) => {
  const q = { ...NEWF, fam, ...p }, nm = fam === 'trail' ? `G62-TR ${q.trail}x@${q.trailAt}R SL${q.riskAtr}${flags(q, fam)}` : `G62-TP ${q.tpR}R SL${q.riskAtr}${flags(q, fam)}`;
  const ds = fam === 'trail'
    ? `Turunan TRAIL: SL ${q.riskAtr} ATR; trailing ${q.trail} ATR mulai setelah +${q.trailAt}R${q.beR ? `; impas di +${q.beR}R` : ''}${q.trendFilter ? '; hanya searah tren EMA H1' : ''}${q.erMin ? '; lewati pasar sideways' : ''}${q.tpR ? `; TP ${q.tpR}R` : ''}. Keluar juga saat God 62 berbalik.`
    : `Turunan TP1.5R: SL ${q.riskAtr} ATR; TP ${q.tpR}R${q.beR ? `; impas di +${q.beR}R` : ''}${q.trail ? `; trailing ${q.trail} ATR setelah +${q.trailAt}R` : ''}${q.trendFilter ? '; hanya searah tren EMA H1' : ''}${q.erMin ? '; lewati pasar sideways' : ''}. Keluar juga saat God 62 berbalik.`;
  EXTRA[id] = { ...q, name: nm, desc: ds };
};
// keluarga TRAIL (acuan: SL3, trail 1.5x mulai 1R)
[
  { riskAtr: 3, trail: 1.0, trailAt: 1 }, { riskAtr: 3, trail: 1.25, trailAt: 1 }, { riskAtr: 3, trail: 2.0, trailAt: 1 },
  { riskAtr: 3, trail: 1.5, trailAt: 0.5 }, { riskAtr: 3, trail: 1.5, trailAt: 0.75 }, { riskAtr: 3, trail: 1.5, trailAt: 1.5 },
  { riskAtr: 2.5, trail: 1.5, trailAt: 1 }, { riskAtr: 2, trail: 1.5, trailAt: 1 }, { riskAtr: 2, trail: 1.0, trailAt: 0.75 },
  { riskAtr: 2, trail: 1.25, trailAt: 1 }, { riskAtr: 4, trail: 2.0, trailAt: 1 },
  { riskAtr: 3, trail: 1.5, trailAt: 1, beR: 0.7 }, { riskAtr: 3, trail: 1.5, trailAt: 1, trendFilter: true },
  { riskAtr: 3, trail: 1.5, trailAt: 1, erMin: 0.25 }, { riskAtr: 3, trail: 1.5, trailAt: 1, tpR: 4 }
].forEach((p, i) => addFam('g62T' + String(i + 1).padStart(2, '0'), 'trail', p));
// keluarga TARGET (acuan: SL2, TP 1.5R)
[
  { riskAtr: 2, tpR: 1.2 }, { riskAtr: 2, tpR: 1.8 }, { riskAtr: 2, tpR: 2 }, { riskAtr: 2, tpR: 2.5 },
  { riskAtr: 1.5, tpR: 1.5 }, { riskAtr: 1.5, tpR: 2 }, { riskAtr: 2.5, tpR: 1.5 }, { riskAtr: 2.5, tpR: 1.2 },
  { riskAtr: 3, tpR: 1 }, { riskAtr: 3, tpR: 1.5 }, { riskAtr: 1.75, tpR: 1.5 },
  { riskAtr: 2, tpR: 1.5, beR: 0.8 }, { riskAtr: 2, tpR: 1.5, trendFilter: true }, { riskAtr: 2, tpR: 1.5, erMin: 0.25 },
  { riskAtr: 2, tpR: 2, trail: 1.5, trailAt: 1 }
].forEach((p, i) => addFam('g62P' + String(i + 1).padStart(2, '0'), 'target', p));
// tiga varian awal ditandai sebagai pembanding
['g62tv', 'g62sl', 'g62tf'].forEach(id => { EXTRA[id].fam = 'base'; });
// Rasio efisiensi Kaufman: 1 = bergerak lurus, mendekati 0 = bolak-balik (sideways).
function effRatio(v, n = 20) {
  if (v.length < n + 1) return 1;
  const s = v.slice(-(n + 1)).map(x => x.c); let path = 0; for (let i = 1; i < s.length; i++) path += Math.abs(s[i] - s[i - 1]);
  return path > 0 ? Math.abs(s[s.length - 1] - s[0]) / path : 0;
}

// Jaga SL tidak terlalu rapat (<0.8 ATR) atau terlalu lebar (>3 ATR). Mengembalikan SL yang disesuaikan atau null bila tidak layak.
function guardSl(dir, entry, sl, A, pad = 0) {
  const buy = dir === 'BUY'; let s = buy ? sl - pad * A : sl + pad * A, risk = Math.abs(entry - s);
  if (!(A > 0) || !(risk > 0)) return null;
  if (risk < 0.8 * A) { s = buy ? entry - 0.8 * A : entry + 0.8 * A; risk = 0.8 * A; }
  if (risk > 3 * A) return null;
  if (buy ? s >= entry : s <= entry) return null;
  return s;
}
module.exports = { SIGS, EXTRA, guardSl, htfDir, volRatio, impulse, retest, effRatio };
