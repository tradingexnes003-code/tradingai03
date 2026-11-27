// Uji mundur SEMUA varian God62 Baru (M15 Lab) pada data historis MT5, dalam hitungan detik.
// Memakai mesin yang sama persis dengan lab di dashboard (netlify/lib/lab.js stepFlip), jadi hasilnya sebanding.
//
// Pakai:  node tools/flip_lab.js BTCUSDm.csv ETHUSDm.csv XAUUSDm.csv [--cost=0.1] [--split=0.6] [--out=flip_hasil.csv] [--top=15]
// Data  : CSV M15 per simbol (ekspor MT5: Tools > History Center, atau kolom waktu,open,high,low,close). Minimal ~3 bulan per simbol.
// Hasil : tabel peringkat + file CSV berisi SEMUA trade tiap varian (history per varian).
//
// Cara membaca (penting): data dibagi dua menurut waktu. Kolom BELAJAR = bagian awal (boleh dipakai memilih varian),
// kolom UJI = bagian akhir yang tidak dipakai memilih. Varian yang bagus di BELAJAR tetapi jelek di UJI = kebetulan.
const fs = require('fs'), path = require('path');
const core = require('../netlify/lib/core.js'), lab = require('../netlify/lib/lab.js');
const files = process.argv.slice(2).filter(x => !x.startsWith('--')), arg = Object.fromEntries(process.argv.slice(2).filter(x => x.startsWith('--')).map(x => x.replace(/^--/, '').split('=')));
if (!files.length) { console.log('Pakai: node tools/flip_lab.js BTCUSDm.csv ETHUSDm.csv [--cost=0.1] [--split=0.6] [--out=flip_hasil.csv] [--top=15]'); process.exit(1); }
const COST = +(arg.cost ?? 0.1), SPLIT = Math.min(0.9, Math.max(0.3, +(arg.split ?? 0.6))), OUT = arg.out || 'flip_hasil.csv', TOP = +(arg.top || 15);

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
    out.push({ t, o: a, h, l, c, vol: 0 });
  }
  return out;
}
const flipIds = Object.entries(lab.PROFILES).filter(([, P]) => P.entry === 'flip').map(([id]) => id);
const st = lab.fresh(), cfg = { costR: COST }, symbols = [], WINDOW = 99, ARC = {}; // ARC: arsip trade (lab menyimpan maks 200 trade terbaru; alat ini mengambil semuanya)
const lastTimes = [];
for (const f of files) {
  const sym = path.basename(f).replace(/\.[^.]+$/, '').replace(/_M15$/i, ''), m15 = load(f);
  if (m15.length < 400) { console.log(`Lewati ${sym}: data terlalu sedikit (${m15.length} candle)`); continue; }
  symbols.push(sym); lastTimes.push(m15[m15.length - 1].t);
  const ep = x => Date.parse(x.t.replace(' ', 'T') + ':00Z') / 60000;
  for (let k = 200; k <= m15.length; k++) {
    const v = m15.slice(Math.max(0, k - WINDOW), k);                    // jendela yang sama dengan lab live (99 candle tertutup)
    const h1 = core.resampleAlt(m15.slice(Math.max(0, k - 800), k), 4); h1.push({ ...h1[h1.length - 1] }); // H1 tertutup + 1 candle berjalan (diabaikan lab)
    let g; try { g = core.god(h1, v, 3, { h: '1h', l: '15min', m15Min: 1 }); } catch (e) { continue; }
    for (const id of flipIds) { const P = lab.PROFILES[id]; lab.stepFlip(st, id, P, cfg, sym, g, v, null, 'fx', h1); }
    st.last[sym] = { t: v[v.length - 1].t }; st.log.length = 0;
    for (const id of flipIds) if ((st.trades[id] || []).length) { (ARC[id] = ARC[id] || []).push(...st.trades[id].reverse()); st.trades[id] = []; }
  }
}
if (!symbols.length) { console.log('Tidak ada data yang bisa dipakai.'); process.exit(1); }
// bagi dua menurut waktu masuk
const allT = flipIds.flatMap(id => (ARC[id] || []).map(t => t.bar)).sort(), cut = allT.length ? allT[Math.floor(allT.length * SPLIT)] : '';
const rows = flipIds.map(id => {
  const P = lab.PROFILES[id], tr = (ARC[id] || []).slice().sort((x, y) => (y.bar < x.bar ? -1 : y.bar > x.bar ? 1 : 0)), a = tr.filter(t => t.bar < cut), b = tr.filter(t => t.bar >= cut), S = lab.stats(tr, 30), Sa = lab.stats(a, 1), Sb = lab.stats(b, 1);
  return { id, name: P.name, fam: P.fam, S, a: Sa, b: Sb };
}).sort((x, y) => (y.S.exp || -9) - (x.S.exp || -9));
const f2 = (v, d = 2) => v == null ? '–' : (+v).toFixed(d), pad = (s, n) => String(s).padEnd(n), lp = (s, n) => String(s).padStart(n);
console.log(`\nSimbol: ${symbols.join(', ')} | sampai ${lastTimes.sort()[0]} | biaya ${COST}R/trade | pembagian: BELAJAR < ${cut} <= UJI (${Math.round(SPLIT * 100)}%/${Math.round((1 - SPLIT) * 100)}%)\n`);
console.log(pad('Varian', 30) + lp('Trade', 6) + lp('WR', 6) + lp('Exp R', 8) + lp('PF', 6) + lp('DD(R)', 7) + lp('P(edge)', 8) + lp('BELAJAR', 9) + lp('UJI', 8) + '  Catatan');
rows.slice(0, TOP).forEach(r => {
  const S = r.S, note = S.n < 30 ? 'data kurang' : (r.a.exp > 0 && r.b.exp > 0 ? 'positif di kedua bagian' : r.a.exp > 0 && !(r.b.exp > 0) ? 'bagus di BELAJAR saja (waspada)' : 'tidak meyakinkan');
  console.log(pad(r.name, 30) + lp(S.n || 0, 6) + lp(S.n ? S.wr + '%' : '–', 6) + lp(f2(S.exp), 8) + lp(f2(S.pf), 6) + lp(f2(S.dd, 1), 7) + lp(S.pPos != null ? S.pPos + '%' : '–', 8) + lp(f2(r.a.exp), 9) + lp(f2(r.b.exp), 8) + '  ' + note);
});
console.log(`\n(${rows.length} varian, ${TOP} teratas ditampilkan; semua trade ada di ${OUT}.) Exp R = rata-rata R bersih per trade; P(edge) = peluang rata-rata R > 0 dari bootstrap.`);
console.log('Ingat: menguji banyak varian pada data yang sama membuat sebagian tampak bagus karena kebetulan. Utamakan varian yang positif di BELAJAR dan UJI, dengan P(edge) tinggi, di banyak simbol.');
const esc = x => '"' + String(x).replace(/"/g, '""') + '"';
const lines = ['id,varian,keluarga,simbol,arah,masuk,keluar,entry,exit,hasil,R,persen,mfe_R,mae_R'];
flipIds.forEach(id => { const P = lab.PROFILES[id]; [...(ARC[id] || [])].sort((x, y) => (x.bar < y.bar ? -1 : x.bar > y.bar ? 1 : 0)).forEach(t => lines.push([id, esc(P.name), P.fam, t.s, t.dir, t.bar, t.tb, t.entry, t.exit, t.res, t.R, t.pct, t.mfe ?? '', t.mae ?? ''].join(','))); });
fs.writeFileSync(OUT, lines.join('\n')); console.log('Tersimpan:', OUT, `(${lines.length - 1} baris trade)`);
