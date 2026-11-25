const { candles, god, view, res, setStore, blobs, pickSource } = require('../lib/core');
const ttlOf = iv => ({ '1h': 600000, '2h': 900000, '4h': 1800000, '1day': 3600000 })[iv] || 600000;
const ALL = ['5min', '15min', '30min', '1h', '2h', '4h', '1day'];
const ts = t => Math.floor(Date.parse(t.length > 10 ? t.replace(' ', 'T') + 'Z' : t + 'T00:00:00Z') / 1000);
exports.handler = async e => {
  if (!view(e)) return res(401, { error: 'Password salah. Klik tombol Password.' });
  if ((process.env.DATA_SOURCE || 'twelve') !== 'twelve') setStore(await blobs(e));
  const q = e.queryStringParameters || {};
  const ltf = ['5min', '15min', '30min'].includes(q.ltf) ? q.ltf : '15min', htf = ['1h', '2h', '4h', '1day'].includes(q.htf) ? q.htf : '1h';
  const iv = ALL.includes(q.interval) ? q.interval : ltf;
  try {
    const src = await pickSource(q.symbol, [...new Set([ltf, htf, iv])]), vl = await candles(q.symbol, ltf, 100, 50000, src), vh = await candles(q.symbol, htf, 200, ttlOf(htf), src);
    let g = null; try { g = god(vh, vl, parseFloat(q.rr) || 3, { h: htf, l: ltf }); } catch (x) {}
    const v = iv === ltf ? vl : iv === htf ? vh : await candles(q.symbol, iv, 120, ttlOf(iv), src);
    return res(200, { interval: iv, source: src, sourceLabel: src === 'exness' ? 'Exness MT5' : 'Twelve Data (fallback)', god: g, bars: v.map(x => ({ time: ts(x.t), open: x.o, high: x.h, low: x.l, close: x.c })) });
  } catch (err) { return res(500, { error: err.message }); }
};
