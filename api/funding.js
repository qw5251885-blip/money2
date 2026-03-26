// api/funding.js  ─ V3
// 後端：資金費率 + 合約價格（Mark Price & Last Price）

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=20');

  try {
    const [binanceRes, bybitRes, okxRes, bitgetRes, mexcRes, kucoinRes] =
      await Promise.allSettled([
        fetchBinance(),
        fetchBybit(),
        fetchOKX(),
        fetchBitget(),
        fetchMEXC(),
        fetchKuCoin(),
      ]);

    const merged = {};

    function mergeIn(result, ex) {
      if (result.status !== 'fulfilled') return;
      for (const item of result.value) {
        if (!merged[item.symbol]) merged[item.symbol] = { symbol: item.symbol };
        const r = merged[item.symbol];
        r[ex]           = item.rate;
        r[ex+'Mark']    = item.markPrice;
        r[ex+'Last']    = item.lastPrice;
        if (item.nextFunding) r[ex+'Next'] = item.nextFunding;
      }
    }

    mergeIn(binanceRes, 'binance');
    mergeIn(bybitRes,   'bybit');
    mergeIn(okxRes,     'okx');
    mergeIn(bitgetRes,  'bitget');
    mergeIn(mexcRes,    'mexc');
    mergeIn(kucoinRes,  'kucoin');

    const FEES = {
      binance: 0.0005,
      bybit:   0.0006,
      okx:     0.0005,
      bitget:  0.0006,
      mexc:    0.0002,
      kucoin:  0.0006,
    };
    const EXCHANGES = ['binance','bybit','okx','bitget','mexc','kucoin'];

    const result = Object.values(merged).map(row => {
      const available = EXCHANGES.filter(e => row[e] !== undefined);
      if (available.length < 2) return null;

      // 最高費率 / 最低費率
      let maxEx = null, minEx = null, maxRate = -Infinity, minRate = Infinity;
      for (const ex of available) {
        if (row[ex] > maxRate) { maxRate = row[ex]; maxEx = ex; }
        if (row[ex] < minRate) { minRate = row[ex]; minEx = ex; }
      }

      const spread    = maxRate - minRate;
      const totalFee  = (FEES[maxEx] + FEES[minEx]) * 2;
      const netSpread = spread - totalFee;

      // ── 價格資訊 ──────────────────────────────────────────
      // 收集所有有 markPrice 的交易所
      const prices = {};
      for (const ex of available) {
        if (row[ex+'Mark'] !== undefined) prices[ex] = row[ex+'Mark'];
        else if (row[ex+'Last'] !== undefined) prices[ex] = row[ex+'Last'];
      }

      const priceList = Object.values(prices).filter(Boolean);
      let maxPrice = null, minPrice = null, priceMaxEx = null, priceMinEx = null;
      let priceDiffPct = null;

      if (priceList.length >= 2) {
        for (const [ex, p] of Object.entries(prices)) {
          if (maxPrice === null || p > maxPrice) { maxPrice = p; priceMaxEx = ex; }
          if (minPrice === null || p < minPrice) { minPrice = p; priceMinEx = ex; }
        }
        // 價差百分比：(最高 - 最低) / 最低
        priceDiffPct = (maxPrice - minPrice) / minPrice;
      }

      row.spread       = spread;
      row.netSpread    = netSpread;
      row.maxEx        = maxEx;
      row.minEx        = minEx;
      row.maxRate      = maxRate;
      row.minRate      = minRate;
      row.totalFee     = totalFee;
      row.prices       = prices;          // { binance: 65432.1, bybit: 65430.0, ... }
      row.priceDiffPct = priceDiffPct;    // e.g. 0.000031 = 0.0031%
      row.priceMaxEx   = priceMaxEx;
      row.priceMinEx   = priceMinEx;
      return row;
    })
    .filter(r => r && r.spread > 0)
    .sort((a, b) => b.netSpread - a.netSpread);

    const exchangeStatus = {};
    const resMap = { binance: binanceRes, bybit: bybitRes, okx: okxRes,
                     bitget: bitgetRes, mexc: mexcRes, kucoin: kucoinRes };
    for (const [ex, r] of Object.entries(resMap)) {
      exchangeStatus[ex] = r.status === 'fulfilled' ? 'ok' : (r.reason?.message || 'error');
    }

    res.status(200).json({ success: true, data: result, exchangeStatus, updatedAt: Date.now() });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// ══ 各交易所 fetch ════════════════════════════════════════════

async function fetchBinance() {
  // premiumIndex 有 markPrice；ticker 有 lastPrice
  const [piRes, tkRes] = await Promise.all([
    fetch('https://fapi.binance.com/fapi/v1/premiumIndex', { headers: { 'User-Agent': 'Mozilla/5.0' } }),
    fetch('https://fapi.binance.com/fapi/v1/ticker/price', { headers: { 'User-Agent': 'Mozilla/5.0' } }),
  ]);
  const piData = await piRes.json();
  const tkData = await tkRes.json();
  const lastMap = {};
  for (const t of tkData) lastMap[t.symbol] = parseFloat(t.price);

  return piData
    .filter(d => d.symbol.endsWith('USDT') && d.lastFundingRate)
    .map(d => ({
      symbol:      d.symbol.replace('USDT', ''),
      rate:        parseFloat(d.lastFundingRate),
      markPrice:   parseFloat(d.markPrice) || null,
      lastPrice:   lastMap[d.symbol] || null,
      nextFunding: parseInt(d.nextFundingTime) || null,
    }));
}

async function fetchBybit() {
  const r = await fetch('https://api.bybit.com/v5/market/tickers?category=linear',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(j.retMsg);
  return j.result.list
    .filter(d => d.symbol.endsWith('USDT') && d.fundingRate)
    .map(d => ({
      symbol:      d.symbol.replace('USDT', ''),
      rate:        parseFloat(d.fundingRate),
      markPrice:   parseFloat(d.markPrice) || null,
      lastPrice:   parseFloat(d.lastPrice) || null,
      nextFunding: d.nextFundingTime ? parseInt(d.nextFundingTime) : null,
    }));
}

async function fetchOKX() {
  const r = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  if (j.code !== '0') throw new Error('OKX instruments error');
  const syms = j.data.filter(d => d.instId.endsWith('-USDT-SWAP')).map(d => d.instId);

  // 同時抓 funding rate + mark price
  const results = [];
  const batchSize = 20;
  for (let i = 0; i < Math.min(syms.length, 120); i += batchSize) {
    const batch = syms.slice(i, i + batchSize);
    const [frBatch, mkBatch] = await Promise.all([
      Promise.allSettled(batch.map(id =>
        fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${id}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json())
      )),
      Promise.allSettled(batch.map(id =>
        fetch(`https://www.okx.com/api/v5/public/mark-price?instId=${id}&instType=SWAP`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json())
      )),
    ]);

    for (let k = 0; k < batch.length; k++) {
      const fr = frBatch[k], mk = mkBatch[k];
      if (fr.status === 'fulfilled' && fr.value.code === '0' && fr.value.data?.[0]) {
        const d  = fr.value.data[0];
        const mp = (mk.status === 'fulfilled' && mk.value.code === '0' && mk.value.data?.[0])
          ? parseFloat(mk.value.data[0].markPx) : null;
        results.push({
          symbol:      d.instId.replace('-USDT-SWAP', ''),
          rate:        parseFloat(d.fundingRate),
          markPrice:   mp,
          lastPrice:   null,
          nextFunding: d.nextFundingTime ? parseInt(d.nextFundingTime) : null,
        });
      }
    }
  }
  return results;
}

async function fetchBitget() {
  const r = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  if (j.code !== '00000') throw new Error(j.msg);
  return (j.data || [])
    .filter(d => d.symbol.endsWith('USDT') && d.fundingRate)
    .map(d => ({
      symbol:    d.symbol.replace('USDT', ''),
      rate:      parseFloat(d.fundingRate),
      markPrice: parseFloat(d.markPrice) || null,
      lastPrice: parseFloat(d.lastPr)    || null,
      nextFunding: null,
    }));
}

async function fetchMEXC() {
  const r = await fetch('https://api.mexc.com/api/v1/contract/detail',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  if (!j.success) throw new Error('MEXC contract list error');
  const symbols = (j.data || []).filter(d => d.symbol.endsWith('_USDT')).map(d => d.symbol);

  const results = [];
  const batchSize = 20;
  for (let i = 0; i < Math.min(symbols.length, 100); i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const fetched = await Promise.allSettled(batch.map(sym =>
      Promise.all([
        fetch(`https://api.mexc.com/api/v1/contract/funding_rate/${sym}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json()),
        fetch(`https://api.mexc.com/api/v1/contract/ticker?symbol=${sym}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json()),
      ])
    ));
    for (const f of fetched) {
      if (f.status !== 'fulfilled') continue;
      const [fr, tk] = f.value;
      if (fr.success && fr.data) {
        results.push({
          symbol:      fr.data.symbol.replace('_USDT', ''),
          rate:        parseFloat(fr.data.fundingRate),
          markPrice:   tk.success && tk.data ? parseFloat(tk.data.fairPrice) || null : null,
          lastPrice:   tk.success && tk.data ? parseFloat(tk.data.lastPrice) || null : null,
          nextFunding: fr.data.nextSettleTime || null,
        });
      }
    }
  }
  return results;
}

async function fetchKuCoin() {
  const r = await fetch('https://api-futures.kucoin.com/api/v1/contracts/active',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  if (j.code !== '200000') throw new Error('KuCoin error');
  return (j.data || [])
    .filter(d => d.quoteCurrency === 'USDT' && d.fundingFeeRate !== undefined)
    .map(d => ({
      symbol:      d.baseCurrency === 'XBT' ? 'BTC' : d.baseCurrency,
      rate:        parseFloat(d.fundingFeeRate),
      markPrice:   parseFloat(d.markPrice) || null,
      lastPrice:   parseFloat(d.lastTradePrice) || null,
      nextFunding: d.nextFundingRateTime || null,
    }));
}
