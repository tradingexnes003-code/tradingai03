const { candles, scan, validate, god, auth, res, setStore, blobs, pickSource } = require('../lib/core');
const ttlOf = iv => ({ '1h': 600000, '2h': 900000, '4h': 1800000, '1day': 3600000 })[iv] || 600000;
const LB = { '5min': 'M5', '15min': 'M15', '30min': 'M30', '1h': 'H1', '2h': 'H2', '4h': 'H4', '1day': 'D1' };
exports.handler = async e => {
  if (!auth(e)) return res(401, { error: 'Analisa AI hanya untuk pemilik: klik tombol Password dan isi password pemilik.' });
  if ((process.env.DATA_SOURCE || 'twelve') !== 'twelve') setStore(await blobs(e));
  try {
    if (!process.env.GEMINI_KEY && !process.env.ANTHROPIC_KEY) throw new Error('Isi ANTHROPIC_KEY (Claude) atau GEMINI_KEY di Netlify');
    const b = JSON.parse(e.body || '{}'), mode = b.mode === 'ltf' ? 'ltf' : 'htf';
    const ltf = ['5min', '15min', '30min'].includes(b.interval) ? b.interval : '15min';
    const htf = ['1h', '2h', '4h', '1day'].includes(b.htf) ? b.htf : '1h', H = LB[htf], M = LB[ltf];
    const src = await pickSource(b.symbol, [ltf, htf]), vl = await candles(b.symbol, ltf, 100, 50000, src), vh = await candles(b.symbol, htf, 200, ttlOf(htf), src);
    const sl_ = scan(b.symbol, ltf, vl), sh = scan(b.symbol, htf, vh);
    let g = null; try { g = god(vh, vl.slice(0, -1), parseFloat(b.rr) || 3, { h: htf, l: ltf, m15Min: parseInt(b.m15) || 6 }); } catch (x) {}
    const s = mode === 'ltf' ? sl_ : { ...sh, price: sl_.price };
    const v = mode === 'ltf' ? vl : vh, TF = mode === 'ltf' ? M : H;
    const ctx = v.slice(-30).map(x => [x.t.slice(5, 16), x.o, x.h, x.l, x.c].join(' ')).join('\n');
    const guide = b.asset === 'saham'
      ? 'Aset SAHAM: pertimbangkan tren indeks, kekuatan sektor, volume, laporan keuangan, jam bursa.'
      : 'Aset FOREX/KOMODITAS: pertimbangkan selisih suku bunga, data ekonomi, kekuatan USD, sesi London/New York, spread.';
    const ck = g ? Object.entries(g.m.chk).map(([k, x]) => `${k}=${x ? 'ya' : 'belum'}`).join(', ') : '';
    const hck = g ? Object.entries(g.h.chk).map(([k, x]) => `${k}=${x ? 'ya' : 'belum'}`).join(', ') : '';
    const gline = g ? `Acuan trader (dihitung kode; level ${H} TETAP selama candle ${H} belum berganti): ${H} tren ${g.trend}${g.kuat ? ' (kuat)' : ' (lemah)'}; dasar ${g.basis}; kandidat ${g.dir} LIMIT entry ${g.entry} (zona ${g.entryLo}-${g.entryHi}) SL ${g.sl} TP1 ${g.tp1} TP2 ${g.tp2 || '-'} R:R 1:${g.rr}; harga live ${sl_.price} berjarak ${g.dist} ATR ${H} dari entry; status ${g.status}. Supply ${g.supply || '-'}, demand ${g.demand || '-'}. Checklist ${H}: ${hck} (layak pantau: ${g.h.layak ? 'ya' : 'belum'}); grade ${g.grade}. Checklist ${M}: ${ck}; tren ${M} ${g.m.trend}, RSI ${g.m.rsi}${g.m.entry ? `; entry presisi ${M} ${g.m.entry} SL ketat ${g.m.sl} R:R 1:${g.m.rr}` : ''}.` : '';
    const task = mode === 'htf'
      ? `TUGAS: ANALISA ${H} (strategis: tren, zona, rencana bertahap). Entry adalah LIMIT di zona supply/demand atau area pullback ${H}, BUKAN harga live (kecuali harga live sudah di zona). Pecah entry 2 tahap jika masuk akal (entry di tepi zona, entry2 lebih dalam). Rencana searah tren ${H} dan memakai level kandidat sebagai dasar.`
      : `TUGAS: ANALISA ${M} (timing entry di dalam konteks ${H}). Nilai checklist ${M}: kapan entry layak, konfirmasi apa yang ditunggu, SL ketat di balik swing ${M}, target menuju level ${H}. JANGAN melawan tren ${H}. Entry boleh di harga sekarang HANYA jika syarat konfirmasi sudah terpenuhi; jika belum, beri limit di zona atau arah 'Tunggu' beserta syarat yang ditunggu.`;
    const prompt = `Anda manajer investasi profesional yang mengelola risiko portofolio. Susun rencana trading yang disiplin dalam Bahasa Indonesia.
${guide}
Simbol ${b.symbol}. Timeframe analisa ${TF}. Harga live ${sl_.price}. Tren EMA ${s.trend}, RSI ${s.rsi}, ATR ${s.atr}, high20 ${s.hi}, low20 ${s.lo}. Sinyal pemindai: ${s.signals.join('; ') || 'tidak ada'}.
${task}
30 candle ${TF} terakhir (waktu open high low close):
${ctx}
${b.image ? 'Screenshot chart trader dengan garis analisanya dilampirkan; pertimbangkan level yang ia tandai.' : ''}
${gline}
ATURAN SKOR ENTRY PLAN: skor acuan dihitung oleh kode pada rentang 0-100. Jika skor ${g ? g.skor : 0}/100 mencapai 70 atau lebih, WAJIB susun ENTRY PLAN bersyarat searah kandidat ${g ? g.dir : 'tren'} menggunakan level kandidat kode (entry/zona, SL, TP1) sebagai titik awal; jangan otomatis mengubahnya menjadi order pasar. Skor 70+ berarti wajib dibuatkan rencana entry. Syarat timing M15 minimal 6/7 sudah cukup untuk status SIAP ENTRY; 7/7 tidak wajib. Jika M15 masih di bawah 6/7, tetap tampilkan plan dengan status WAIT TRIGGER dan sebutkan syarat yang ditunggu. Ini bukan izin order live otomatis. Jika skor di bawah 70, arah 'Tunggu'. Pada skor 70+, bila tren lemah atau checklist inti belum lengkap, tetap boleh memberi arah Buy/Sell bersyarat hanya jika level teknis dan R:R masuk akal; tuliskan konfirmasi yang masih ditunggu pada langkah eksekusi dan kondisi batal. Jangan mengarang level yang bertentangan dengan acuan kode.
Aturan lain: semua level harus ANGKA harga numerik. Beri ukuran_posisi berdasarkan risiko 1% modal dan TP bertahap dengan trailing stop. SL di luar zona dengan ruang secukupnya; jangan memaksakan entry jika peluang terbesar di bawah 45% atau struktur level tidak valid. Jangan menjanjikan kepastian.
Balas HANYA JSON: {"bias":"Bullish|Bearish|Sideways","keyakinan":0-100,"ringkasan":"","bullish":{"peluang":0,"kondisi":"","target":"","invalidasi":""},"bearish":{"peluang":0,"kondisi":"","target":"","invalidasi":""},"sideways":0,"rencana":{"arah":"Buy|Sell|Tunggu","tipe_entry":"","entry":0,"entry2":0,"sl":0,"tp1":0,"tp2":0,"langkah":["4-6 langkah eksekusi berurutan"],"kondisi_batal":"","ukuran_posisi":"","manajemen_risiko":""},"risiko":[""]}. bullish+bearish+sideways=100.`;
    let t;
    if (process.env.ANTHROPIC_KEY) {
      const content = [];
      if (b.image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b.image } });
      content.push({ type: 'text', text: prompt });
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 1800, messages: [{ role: 'user', content }] })
      });
      const j = await r.json();
      t = j.content && j.content[0] && j.content[0].text;
      if (!t) throw new Error((j.error && j.error.message) || 'Claude tidak merespons');
    } else {
      const parts = [{ text: prompt }];
      if (b.image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: b.image } });
      const m = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_KEY },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } })
      });
      const j = await r.json();
      t = j.candidates && j.candidates[0] && j.candidates[0].content.parts[0].text;
      if (!t) throw new Error((j.error && j.error.message) || 'AI tidak merespons');
    }
    const i0 = t.indexOf('{'), i1 = t.lastIndexOf('}');
    const out = JSON.parse(t.slice(i0, i1 + 1));
    out.validasi = validate(out.rencana || {}, s);
    return res(200, { result: out, scan: mode === 'ltf' ? sl_ : sh, god: g, lt: sl_.time, mode });
  } catch (err) { return res(500, { error: err.message }); }
};
