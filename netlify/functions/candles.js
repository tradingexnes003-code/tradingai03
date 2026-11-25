const { candles, scan, god, view, res, setStore, blobs, pickSource } = require('../lib/core');
const ttlOf = iv => ({ '1h': 600000, '2h': 900000, '4h': 1800000, '1day': 3600000 })[iv] || 600000;
exports.handler = async e => {
  if (!view(e)) return res(401, { error: 'Password salah. Klik tombol Password.' });
  if ((process.env.DATA_SOURCE || 'twelve') !== 'twelve') setStore(await blobs(e));
  const q = e.queryStringParameters || {};
  const ltf = ['5min', '15min', '30min'].includes(q.interval) ? q.interval : '15min';
  const htf = ['1h', '2h', '4h', '1day'].includes(q.htf) ? q.htf : '1h', rr = parseFloat(q.rr) || 3;
  const sy = [...new Set((q.symbols || '').split(',').map(s => s.trim()).filter(Boolean))].slice(0, 6);
  const items = await Promise.all(sy.map(async s => {
    try {
      const src = await pickSource(s, [ltf, htf]), v = await candles(s, ltf, 100, 50000, src), it = scan(s, ltf, v); it.src = src;
      // candle M15 yang masih berjalan dibuang: hitungan identik dengan Control Tower
      try { it.god = god(await candles(s, htf, 200, ttlOf(htf), src), v.slice(0, -1), rr, { h: htf, l: ltf, m15Min: parseInt(q.m15) || 6 }); } catch (x) { it.godError = x.message; }
      return it;
    } catch (err) { return { symbol: s, error: err.message }; }
  }));
  return res(200, { items });
};
