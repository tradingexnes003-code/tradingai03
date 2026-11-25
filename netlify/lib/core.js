const cache = new Map();
const res = (c, b) => ({ statusCode: c, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
// Dua tingkat akses: PEMILIK (header x-app-key = APP_PASSWORD) dan PENGUNJUNG (lihat saja, bila PUBLIC_VIEW tidak 'false').
// Tanpa APP_PASSWORD terkonfigurasi tidak ada pemilik: fitur kontrol, AI berbayar, dan akun real tertutup untuk semua orang.
const owner = e => !!process.env.APP_PASSWORD && e.headers['x-app-key'] === process.env.APP_PASSWORD;
const auth = owner, view = e => owner(e) || process.env.PUBLIC_VIEW !== 'false';

// ---- Sumber data Exness lewat EA MT5 (DATA_SOURCE = twelve | exness | auto) ----
let _store = null;
const setStore = s => { _store = s; };
async function blobs(e) { try { const b = await import('@netlify/blobs'); if (e && b.connectLambda) b.connectLambda(e); return b.getStore('tower'); } catch (x) { return null; } }
const TFM = { '5min': 'M5', '15min': 'M15', '30min': 'M30', '1h': 'H1', '2h': 'H2', '4h': 'H4', '1day': 'D1' };
const exName = s => /\//.test(s) ? s.replace('/', '') + (process.env.EXNESS_SUFFIX || '') : s;
const staleMin = () => Math.max(1, +(process.env.EA_STALE_MIN || 2));
async function eaBars(sym, iv) {
  if (!_store) throw new Error('Penyimpanan data EA tidak tersedia');
  const name = exName(sym), d = await _store.get('px_' + name, { type: 'json' }), b = d && d.tf && d.tf[TFM[iv]];
  if (!b || !b.length) return null;
  const age = (Date.now() - (d.u || 0)) / 60000;
  if (age > staleMin()) throw new Error(`Data EA ${name} basi (${Math.round(age)} menit). Pastikan MT5 menyala dan EA aktif`);
  return b.map(x => ({ t: new Date(x[0] * 1000).toISOString().slice(0, 19).replace('T', ' '), o: x[1], h: x[2], l: x[3], c: x[4] }));
}
// Mode auto: satu simbol memakai SATU sumber untuk semua timeframe (EA hanya jika segar dan lengkap), agar zona dan entry tidak bercampur dua feed harga.
async function pickSource(sym, ivs) {
  const src = process.env.DATA_SOURCE || 'twelve';
  if (src !== 'auto') return src;
  try {
    if (!_store) return 'twelve';
    const d = await _store.get('px_' + exName(sym), { type: 'json' });
    // Gunakan waktu tick terakhir dari terminal MT5, bukan waktu HTTP ingest.
    // EA bisa tetap mengirim timer saat market tutup; timestamp tick mencegah data diam dianggap live.
    const quoteAt = Number(d && d.q || 0) * 1000;
    if (!d || !quoteAt || (Date.now() - quoteAt) / 60000 > staleMin()) return 'twelve';
    return ivs.every(iv => d.tf && d.tf[TFM[iv]] && d.tf[TFM[iv]].length >= 70) ? 'exness' : 'twelve';
  } catch (e) { return 'twelve'; }
}
async function ingest(store, body) {
  if (!body || !Array.isArray(body.d)) throw new Error('format salah');
  let n = 0;
  for (const it of body.d.slice(0, 12)) {
    const name = String(it.s || '').replace(/[^\w.#-]/g, '').slice(0, 24); if (!name) continue;
    const cur = (await store.get('px_' + name, { type: 'json' }).catch(() => null)) || { tf: {} };
    for (const [tf, bars] of Object.entries(it.tf || {})) {
      if (!['M5', 'M15', 'M30', 'H1', 'H2', 'H4', 'D1'].includes(tf) || !Array.isArray(bars)) continue;
      const m = new Map((cur.tf[tf] || []).map(x => [x[0], x]));
      bars.forEach(x => { if (Array.isArray(x) && x.length === 5 && x.every(Number.isFinite)) m.set(x[0], x); });
      cur.tf[tf] = [...m.values()].sort((a, c) => a[0] - c[0]).slice(-300);
    }
    // q = timestamp tick broker (Unix seconds); hanya update jika benar-benar ada tick.
    if (Number.isFinite(it.q) && it.q > 0) cur.q = it.q;
    cur.u = Date.now(); await store.setJSON('px_' + name, cur); n++;
  }
  return { ok: true, n };
}
// Nama simbol untuk Twelve Data (cadangan): ubah nama mentah MT5 ke format Twelve Data, mis. XAUUSD -> XAU/USD, BTCUSDm -> BTC/USD.
const tdName = s => {
  let x = String(s).trim();
  if (x.includes('/')) return x;
  const m = x.match(/^([A-Za-z]{6})[a-z]$/); if (m) x = m[1];
  if (/^[A-Za-z]{6}$/.test(x)) return (x.slice(0, 3) + '/' + x.slice(3)).toUpperCase();
  return x;
};
async function candles(sym, iv, n = 100, ttl = 50000, force) {
  const src = force || process.env.DATA_SOURCE || 'twelve';
  if (src === 'exness' || src === 'auto') {
    let v = null;
    try { v = await eaBars(sym, iv); } catch (e) { if (src === 'exness') throw e; }
    if (v) { const r = v.slice(-n); r.src = 'exness'; return r; }
    if (src === 'exness') throw new Error(`Belum ada data EA untuk ${exName(sym)} ${TFM[iv] || iv}. Cek nama simbol (EXNESS_SUFFIX) dan EA`);
  }
  if (!process.env.TWELVEDATA_KEY) throw new Error('TWELVEDATA_KEY belum diisi di Netlify');
  const k = sym + iv, c = cache.get(k);
  if (c && Date.now() - c.t < ttl) return c.v;
  const r = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdName(sym))}&interval=${iv}&outputsize=${n}&apikey=${process.env.TWELVEDATA_KEY}`);
  const j = await r.json();
  if (j.status === 'error' || !j.values) throw new Error(j.message || 'Data tidak tersedia');
  const v = j.values.slice().reverse().map(x => ({ t: x.datetime, o: +x.open, h: +x.high, l: +x.low, c: +x.close }));
  v.src = 'twelve';
  cache.set(k, { t: Date.now(), v });
  return v;
}
const ema = (a, p) => { const k = 2 / (p + 1); let e = a[0]; return a.map(x => (e = x * k + e * (1 - k))); };
function rsi(c, p = 14) {
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; d > 0 ? (g += d) : (l -= d); }
  g /= p; l /= p;
  for (let i = p + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function atr(v, p = 14) {
  const tr = v.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - v[i - 1].c), Math.abs(x.l - v[i - 1].c)) : x.h - x.l);
  return tr.slice(-p).reduce((a, b) => a + b, 0) / p;
}
function scan(sym, iv, v) {
  if (v.length < 50) throw new Error('Data candle kurang');
  const c = v.map(x => x.c), last = c[c.length - 1], e20 = ema(c, 20), e50 = ema(c, 50);
  const R = rsi(c), A = atr(v), prev = v.slice(-21, -1);
  const hi = Math.max(...prev.map(x => x.h)), lo = Math.min(...prev.map(x => x.l));
  const trend = e20[e20.length - 1] > e50[e50.length - 1] ? 'naik' : 'turun';
  const sig = []; let sc = 0;
  if (last > hi) { sig.push('Breakout atas 20 candle'); sc += 40; }
  if (last < lo) { sig.push('Breakdown bawah 20 candle'); sc += 40; }
  if (R > 70) { sig.push('RSI overbought'); sc += 20; }
  if (R < 30) { sig.push('RSI oversold'); sc += 20; }
  const n = e20.length, x1 = e20[n - 2] - e50[n - 2], x2 = e20[n - 1] - e50[n - 1];
  if (x1 * x2 < 0) { sig.push('EMA20 memotong EMA50'); sc += 30; }
  if (!sc && Math.abs(last - e20[n - 1]) < A * 0.3) { sig.push('Dekat EMA20 (area pullback)'); sc += 15; }
  const dec = last > 100 ? 2 : 5;
  return { symbol: sym, interval: iv, price: +last.toFixed(dec), chg: (last / c[c.length - 25] - 1) * 100, rsi: +R.toFixed(1), atr: A, trend,
    hi, lo, score: Math.min(100, sc), signals: sig, closes: c.slice(-60).map(x => +x.toFixed(dec)), time: v[v.length - 1].t.slice(5, 16) };
}
function validate(p, s) {
  const n = x => { const v = parseFloat(x); return isFinite(v) ? v : null; };
  const en = n(p.entry), sl = n(p.sl), t1 = n(p.tp1), w = [];
  const buy = /buy/i.test(p.arah || ''), sell = /sell/i.test(p.arah || '');
  if (!buy && !sell) return { ok: true, warn: ['Rencana: tunggu, belum ada entry.'], rr: null };
  if (en === null || sl === null || t1 === null) return { ok: false, warn: ['Level entry/SL/TP tidak lengkap.'], rr: null };
  if ((buy && !(sl < en && en < t1)) || (sell && !(t1 < en && en < sl))) w.push('Urutan SL/entry/TP tidak sesuai arah. Jangan dipakai.');
  const rr = +(Math.abs(t1 - en) / Math.abs(en - sl)).toFixed(2), d = Math.abs(en - s.price) / s.atr;
  if (d > 12) w.push('Entry sangat jauh dari harga sekarang; pertimbangkan menunggu atau membatalkan plan.');
  if (Math.abs(en - sl) < 0.5 * s.atr) w.push('SL sangat dekat (<0.5 ATR), rawan tersapu noise.');
  if (rr < 1.5) w.push('Risk:Reward di bawah 1:1.5.');
  return { ok: !w.length, warn: w, rr, distAtr: +d.toFixed(2) };
}

// ---- God 62 PERSONAL (dari screenshot Input TradingView): MA Type ALMA, MA Period 2, Sigma 5, Offset 0.85, Delay 0,
// TIMEFRAME 15 menit, Use Alternate Signals = ya, Multiplier = 8, Swing 10, Supply/Demand Box Width 2.5, trade BOTH.
// Sumber script tidak bisa dibuka, jadi logika sinyal (ALMA close vs ALMA open pada TF alternatif) adalah DUGAAN dari input, bukan salinan.
const G62 = { p: 2, sig: 5, off: 0.85, altMin: 120, swing: 10, box: 2.5, boxAtr: 50, srStr: 2, freshBuckets: 2 }; // altMin = 15 menit x 8
function alma(a, p = G62.p, off = G62.off, sig = G62.sig) {
  const m = Math.floor(off * (p - 1)), s = p / sig, w = []; let ws = 0;
  for (let i = 0; i < p; i++) { const x = Math.exp(-((i - m) ** 2) / (2 * s * s)); w.push(x); ws += x; }
  return a.map((_, k) => k < p - 1 ? null : a.slice(k - p + 1, k + 1).reduce((t, v, i) => t + v * w[i], 0) / ws);
}

// Gabung candle berurutan menjadi TF alternatif (bucket jam server). Bucket terakhir dibuang bila belum lengkap (non-repaint).
function resampleAlt(v, mult) {
  if (v.length < 3) return [];
  const ep = x => Date.parse(String(x.t).replace(' ', 'T') + (String(x.t).length <= 16 ? ':00' : '') + 'Z') / 60000;
  const ds = []; for (let i = 1; i < v.length; i++) { const d = ep(v[i]) - ep(v[i - 1]); if (d > 0) ds.push(d); }
  ds.sort((a, b) => a - b); const base = ds[Math.floor(ds.length / 2)] || 15, B = base * mult, out = []; let cur = null;
  for (const x of v) {
    const k = Math.floor(ep(x) / B);
    if (!cur || cur.k !== k) { cur = { k, t: x.t, o: x.o, h: x.h, l: x.l, c: x.c }; out.push(cur); }
    else { cur.h = Math.max(cur.h, x.h); cur.l = Math.min(cur.l, x.l); cur.c = x.c; }
  }
  const lastEnd = ep(v[v.length - 1]) + base;
  if (out.length && lastEnd % B !== 0) out.pop();
  return out.map(x => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, bucketMin: B }));
}
// Sinyal God 62 (dugaan): ALMA(close) memotong ALMA(open). Mengembalikan arah sekarang, apakah baru berbalik di bucket tutup terakhir, dan umurnya.
function g62(v, altMin = G62.altMin) {
  const ds = []; for (let i = 1; i < v.length; i++) { const d = (Date.parse(String(v[i].t).replace(' ', 'T') + ':00Z') - Date.parse(String(v[i - 1].t).replace(' ', 'T') + ':00Z')) / 60000; if (d > 0) ds.push(d); }
  ds.sort((a, c) => a - c); const base = ds[Math.floor(ds.length / 2)] || 15;
  const b = resampleAlt(v, Math.max(1, Math.round(altMin / base)));
  if (b.length < G62.p + 3) return { state: null, flip: null, age: null, tfMin: null, t: null };
  const aC = alma(b.map(x => x.c)), aO = alma(b.map(x => x.o)), st = [];
  for (let i = 0; i < b.length; i++) st.push(aC[i] == null || aO[i] == null ? null : (aC[i] > aO[i] ? 'BUY' : aC[i] < aO[i] ? 'SELL' : null));
  let n = st.length - 1; while (n > 0 && st[n] == null) n--;
  const state = st[n]; let k = n; while (k > 0 && st[k - 1] === state) k--;
  return { state, flip: k === n && k > 0 && st[k - 1] != null && st[k - 1] !== state ? state : null, age: n - k, tfMin: b[0].bucketMin, t: b[k].t };
}
function pivots(v, len = G62.swing) {
  const H = [], L = [];
  for (let i = len; i < v.length - len; i++) {
    const w = v.slice(i - len, i + len + 1);
    if (v[i].h === Math.max(...w.map(x => x.h))) H.push({ i, p: v[i].h });
    if (v[i].l === Math.min(...w.map(x => x.l))) L.push({ i, p: v[i].l });
  }
  return { H, L };
}
// Acuan: H1 = tren, zona, dan level plan (tetap selama candle H1 belum berganti). M15/harga live hanya menentukan STATUS.
// Aturan ini PERKIRAAN, bukan salinan script asli.
const SL_MULT = 2, RR_MAX = 4; // SL = 2x jarak SL lama; TP dibatasi maks 1:4 (R:R target 1:3 s/d 1:4)
function god(v1raw, v15, minRR = 3, tf = {}) {
  const v1 = v1raw.slice(0, -1);
  if (v1.length < 60 || v15.length < 50) throw new Error('Data H1/M15 kurang untuk acuan');
  const c1 = v1.map(x => x.c), n = c1.length - 1, ref = c1[n], e20 = ema(c1, 20), e50 = ema(c1, 50);
  // Arah tren H1 = EMA20 vs EMA50 (lambat). Dulu arah memakai harga vs ALMA(9) yang sangat cepat: begitu harga pullback ke zona, bias langsung berbalik
  // dan zona yang dituju berubah jadi zona arah sebaliknya, sehingga "harga di zona" dan "tren kuat" nyaris tidak pernah terjadi bersamaan.
  const gs = g62(v15); if (!gs.state) throw new Error('Data God 62 kurang (butuh beberapa candle TF alternatif)');
  const h1signal = gs.flip, trend = gs.state === 'BUY' ? 'naik' : 'turun', kuat = true; // ARAH = sinyal God 62 (ALMA2 open/close, TF 15m x8), bukan EMA20/50
  const A1 = atr(v1), A15 = atr(v15), ZB = atr(v1, G62.boxAtr) * (G62.box / 10), buy = trend === 'naik';
  const last = v15[v15.length - 1], price = last.c;
  const pv = pivots(v1, 10);
  const ups = pv.H.filter(q => q.p > ref && !v1.slice(q.i + 1).some(x => x.c > q.p)).sort((a, b) => a.p - b.p);
  const dns = pv.L.filter(q => q.p < ref && !v1.slice(q.i + 1).some(x => x.c < q.p)).sort((a, b) => b.p - a.p);
  const supZ = ups[0] ? [ups[0].p - ZB, ups[0].p] : null, demZ = dns[0] ? [dns[0].p, dns[0].p + ZB] : null;
  let lo, hi, sl, tp1, tp2, basis;
  if (buy) {
    if (demZ) { lo = demZ[0]; hi = demZ[1]; basis = 'demand H1'; } else { hi = Math.min(e20[n], ref); lo = hi - 0.3 * A1; basis = 'pullback EMA20 H1'; }
    sl = lo - 0.3 * A1;
    tp1 = supZ ? supZ[0] : null;
    tp2 = ups[1] ? ups[1].p - ZB : null;
  } else {
    if (supZ) { lo = supZ[0]; hi = supZ[1]; basis = 'supply H1'; } else { lo = Math.max(e20[n], ref); hi = lo + 0.3 * A1; basis = 'pullback EMA20 H1'; }
    sl = hi + 0.3 * A1;
    tp1 = demZ ? demZ[1] : null;
    tp2 = dns[1] ? dns[1].p + ZB : null;
  }
  const entry = buy ? hi : lo; // limit di tepi zona yang pertama disentuh
  // SL diperlebar SL_MULT kali dari jarak SL lama (entry -> balik zona + buffer) agar tidak mudah tersapu.
  sl = buy ? entry - SL_MULT * (entry - sl) : entry + SL_MULT * (sl - entry);
  const risk = Math.abs(entry - sl);
  if (tp1 === null) tp1 = buy ? entry + 3 * risk : entry - 3 * risk; // tanpa zona lawan: target 1:3
  if (tp2 !== null && (buy ? tp2 <= tp1 : tp2 >= tp1)) tp2 = null;
  const tpStruct = tp1, rewardRaw = buy ? tpStruct - entry : entry - tpStruct, rrRaw = rewardRaw > 0 && risk > 0 ? rewardRaw / risk : 0;
  // TP1 dibatasi maks R:R 1:RR_MAX; zona lawan (target struktural asli) dijadikan TP2 bila lebih jauh.
  if (rrRaw > RR_MAX) { tp1 = buy ? entry + RR_MAX * risk : entry - RR_MAX * risk; tp2 = tpStruct; }
  const reward = buy ? tp1 - entry : entry - tp1;
  const rr = reward > 0 && risk > 0 ? +(reward / risk).toFixed(2) : 0;
  // Zona M15: zona dianggap aktif jika salah satu dari 4 candle M15 terakhir menyentuh zona H1 dan harga belum jauh meninggalkannya.
  // (Dulu harus tepat di dalam zona saat ini, padahal candle konfirmasi biasanya sudah menutup di luar zona, sehingga 6/7 nyaris mustahil.)
  const rec4 = v15.slice(-4), touched = buy ? Math.min(...rec4.map(x => x.l)) <= hi + 0.1 * A15 : Math.max(...rec4.map(x => x.h)) >= lo - 0.1 * A15;
  const inZone = buy ? (touched && price > sl && price <= hi + A15) : (touched && price < sl && price >= lo - A15);
  const conf = buy ? last.c > last.o : last.c < last.o;
  const dist = +(Math.abs(price - entry) / A1).toFixed(2);
  const trs = v => v.map((x, i) => i ? Math.max(x.h - x.l, Math.abs(x.h - v[i - 1].c), Math.abs(x.l - v[i - 1].c)) : x.h - x.l);
  const act = v => { const t = trs(v), a = t.reduce((q, y) => q + y, 0) / t.length; return a > 0 && atr(v) >= 0.5 * a; };
  // ---- Syarat acuan (H1): inti = trend, zona, ruang/R:R, pasar aktif ----
  const zRow = buy ? dns[0] : ups[0];
  const fresh = !!zRow && (buy ? v1.slice(zRow.i + 1).every(x => x.l > demZ[1]) : v1.slice(zRow.i + 1).every(x => x.h < supZ[0]));
  const pLo = pv.L, pHi = pv.H;
  // BOS searah (label BOS God 62): dalam 20 candle H1 terakhir ada CLOSE yang menembus swing (10) sebelumnya. S/R (strength 2): ada level S/R di/dekat zona.
  const lastP = (arr, idx) => { const f = arr.filter(q => q.i <= idx); return f.length ? f[f.length - 1] : null; };
  const bP = lastP(buy ? pv.H : pv.L, n - 20), bosH = !!bP && (buy ? Math.max(...c1.slice(-20)) > bP.p : Math.min(...c1.slice(-20)) < bP.p);
  const sr2 = pivots(v1, G62.srStr), srOk = (buy ? sr2.L : sr2.H).some(q => q.p >= lo - ZB && q.p <= hi + ZB);
  const struktur = buy ? (pLo.length >= 2 && pLo[pLo.length - 1].p > pLo[pLo.length - 2].p) : (pHi.length >= 2 && pHi[pHi.length - 1].p < pHi[pHi.length - 2].p);
  const hchk = { trend: kuat, zona: !!zRow, ruang: rrRaw >= minRR && Math.abs(tpStruct - entry) >= 2 * A1, aktif: act(v1),
    slope: bosH, struktur, segar: fresh, rsi: srOk };
  const hCore = hchk.trend && hchk.zona && hchk.ruang && hchk.aktif;
  const hOpt = [hchk.slope, hchk.struktur, hchk.segar, hchk.rsi].filter(Boolean).length;
  const hOk = Object.values(hchk).filter(Boolean).length, layak = hCore && hOpt >= 2;
  // ---- Syarat entry (M15): inti = zona, konfirmasi kuat, R:R, volatilitas ----
  const cl15 = v15.map(x => x.c), m20 = ema(cl15, 20), m50 = ema(cl15, 50), ln = cl15.length - 1, R15 = rsi(cl15), R15b = rsi(cl15.slice(0, -3));
  const ltfTrend = m20[ln] > m50[ln] ? 'naik' : 'turun';
  const pb = v15[v15.length - 2], rg = (last.h - last.l) || 1e-9, body = Math.abs(last.c - last.o);
  const strong = conf && body >= 0.4 * rg && (buy ? (last.c > pb.h || (Math.min(last.o, last.c) - last.l) >= 0.5 * rg) : (last.c < pb.l || (last.h - Math.max(last.o, last.c)) >= 0.5 * rg));
  // Struktur mikro: close menembus extreme 3 candle sebelumnya (dulu 6 candle, terlalu telat untuk momen balik dari zona).
  const p6 = v15.slice(-4, -1);
  const choch = buy ? last.c > Math.max(...p6.map(x => x.h)) : last.c < Math.min(...p6.map(x => x.l));
  // Entry M15 percobaan di harga sekarang: SL = ekstrem 8 candle M15 (min 1 ATR M15) x SL_MULT. TP = target struktural H1 (maks 1:RR_MAX);
  // bila target struktural sudah terlewat/terlalu dekat (< minRR), TP dipasang 1:minRR dari harga. Entry baru DIKUNCI saat syarat M15 >= m15Min (default 6/7).
  let mEntry = null, mSl = null, mRr = null, mTp = null;
  const r8 = v15.slice(-8), swSl = buy ? Math.min(...r8.map(x => x.l)) - 0.3 * A15 : Math.max(...r8.map(x => x.h)) + 0.3 * A15;
  const rkT = SL_MULT * Math.max(Math.abs(price - swSl), A15), slT = buy ? price - rkT : price + rkT;
  const rwS = buy ? tp1 - price : price - tp1, rrS = rwS > 0 ? Math.min(rwS, RR_MAX * rkT) / rkT : 0;
  let rwT, tpT, tpBasis = 'struktur H1';
  if (rwS >= minRR * rkT) { rwT = Math.min(rwS, RR_MAX * rkT); tpT = rwS > RR_MAX * rkT ? (buy ? price + rwT : price - rwT) : tp1; }
  else { rwT = minRR * rkT; tpT = buy ? price + rwT : price - rwT; tpBasis = 'R:R 1:' + minRR + ' (target H1 terlewat/dekat)'; }
  // Rencana M15 bersyarat: selalu dihitung dari zona H1 (limit di tepi zona, SL tepat di balik zona dengan buffer ATR M15), walau harga belum sampai.
  const pE = buy ? hi : lo; let pSl = buy ? lo - 0.3 * A15 : hi + 0.3 * A15, pRisk = Math.abs(pE - pSl);
  if (pRisk < A15) pRisk = A15;
  pRisk *= SL_MULT; pSl = buy ? pE - pRisk : pE + pRisk;
  let pRw = buy ? tp1 - pE : pE - tp1, pTp = tp1;
  if (pRw > RR_MAX * pRisk) { pRw = RR_MAX * pRisk; pTp = buy ? pE + pRw : pE - pRw; }
  const pRr = pRw > 0 ? +(pRw / pRisk).toFixed(2) : 0;
  // EMA M15: searah tren H1, ATAU harga sudah merebut EMA9 M15 searah plan (momen balik arah setelah pullback; EMA20/50 yang lambat masih sempat melawan).
  const gAlign = gs.state === (buy ? 'BUY' : 'SELL'), gConf = gAlign && gs.age != null && gs.age <= G62.freshBuckets; // sinyal God 62 searah baru berbalik (<= 2 bucket 2 jam)
  const bm = (() => { const pp = pivots(v15, G62.swing), f = (buy ? pp.H : pp.L).filter(q => q.i <= ln - 9); return f.length ? f[f.length - 1] : null; })();
  const bosM = !!bm && (buy ? Math.max(...cl15.slice(-8)) > bm.p : Math.min(...cl15.slice(-8)) < bm.p); // BOS M15: close menembus swing (10)
  const barOk = (() => { const a = alma(cl15), o = alma(v15.map(x => x.o)); return a[ln] != null && (buy ? a[ln] > o[ln] : a[ln] < o[ln]); })(); // warna bar God 62 pada candle M15 sendiri
  const sr15 = pivots(v15.slice(-60), G62.srStr), srM = (buy ? sr15.L : sr15.H).some(q => Math.abs(q.p - price) <= A15); // level S/R (strength 2) dekat harga
  const chk = { zone: inZone, conf: gConf, rr: ((inZone && gConf) ? rrS : Math.max(rr, pRr)) >= minRR, vol: act(v15), choch: bosM,
    ema: barOk, rsi: srM };
  const mCore = chk.zone && chk.conf && chk.rr && chk.vol, mOk = Object.values(chk).filter(Boolean).length;
  const m15Min = +(tf.m15Min) || 6, deadNow = buy ? price <= sl : price >= sl;
  if (mOk >= m15Min && !deadNow) { mEntry = price; mSl = slT; mTp = tpT; mRr = +(rwT / rkT).toFixed(2); }
  const skor = Math.round(50 * hOk / 8 + 50 * mOk / 7), entryEligible = skor >= 70 && mOk >= 6 && mEntry !== null && (mRr || 0) >= minRR, grade = entryEligible ? (skor >= 85 ? 'A' : 'B') : 'C';
  const dead = buy ? price <= sl : price >= sl, done = buy ? price >= tp1 : price <= tp1;
  let status;
  if (!hchk.aktif || (inZone && !chk.vol)) status = 'PASAR SEPI'; else if (dead) status = 'BATAL'; else if (done) status = 'TERLEWAT'; else if (!layak && !entryEligible) status = 'BELUM LAYAK'; // TERLEWAT = harga sudah melewati TP1 (plan basi)
  else if (inZone) status = !chk.rr ? 'RR KECIL' : entryEligible ? 'SIAP ENTRY' : 'DI ZONA';
  else status = dist <= 0.5 ? 'DEKAT ENTRY' : 'MENUNGGU';
  const sT = kuat ? 100 : 50, sP = Math.min(100, Math.round(rrRaw / minRR * 100));
  const d = price > 100 ? 2 : 5, f = x => +x.toFixed(d), zz = q => q && q.map(f);
  // KELUAR = sinyal God 62 berlawanan (Initial SL/TP God 62 = 0). EA mewajibkan TP, jadi TP dipasang jauh (G62_TP_FAR_R x jarak SL, default 10) sebagai pengaman; level zona asli tetap di tpRef dan dipakai untuk R:R.
  const EXIT = process.env.EXIT_G62 !== 'false', FARR = +(process.env.G62_TP_FAR_R) || 10;
  const far = (e, s) => e == null || s == null ? null : (buy ? e + FARR * Math.abs(e - s) : e - FARR * Math.abs(e - s));
  const tpOut = EXIT ? far(entry, sl) : tp1, mTpOut = mTp === null ? null : (EXIT ? far(mEntry, mSl) : mTp), pTpOut = EXIT ? far(pE, pSl) : pTp, tpTOut = EXIT ? far(price, slT) : tpT;
  return { exitMode: EXIT ? 'G62' : 'TP', trend, kuat, h1signal, h1time: gs.flip ? gs.t : v1[n].t, g62: { state: gs.state, flip: gs.flip, age: gs.age, tfMin: gs.tfMin, aligned: gAlign, conf: gConf }, dir: buy ? 'BUY' : 'SELL', basis, htf: tf.h || '1h', ltf: tf.l || '15min', h: { chk: hchk, ok: hOk, total: 8, core: hCore, layak }, grade,
    m: { preview: mEntry !== null ? null : { entry: f(price), sl: f(slT), tp: f(tpTOut), rr: +(rwT / rkT).toFixed(2), basis: tpBasis }, tpBasis: mEntry === null ? null : tpBasis, trend: ltfTrend, rsi: +R15.toFixed(1), atr: +A15.toPrecision(3), chk, ok: mOk, total: 7, core: mCore, entry: mEntry === null ? null : f(mEntry), sl: mSl === null ? null : f(mSl), tp: mTpOut === null ? null : f(mTpOut), rr: mRr,
      plan: { entry: f(pE), sl: f(pSl), tp: f(pTpOut), rr: pRr, armed: mEntry !== null } }, entry: f(entry), entryLo: f(lo), entryHi: f(hi), sl: f(sl),
    tp1: f(tpOut), tp2: EXIT || tp2 === null ? null : f(tp2), tp: f(tpOut), tpRef: f(tp1), rr, minRR, status, dist, trig: status === 'SIAP ENTRY',
    supply: zz(supZ), demand: zz(demZ), skorTrend: sT, skorPotensi: sP, skor, entryEligible, planEligible: skor >= 70 };
}
module.exports = { G62, g62, resampleAlt, alma, ema, atr, rsi, pivots, candles, scan, validate, god, auth, owner, view, res, setStore, blobs, ingest, exName, pickSource };
