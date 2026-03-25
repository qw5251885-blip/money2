// api/funding.js
// 後端中間人伺服器：抓取 Binance、Bybit、OKX、Bitget、MEXC、KuCoin 的資金費率

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=30');

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

    function mergeIn(result, key, nextKey) {
      if (result.status !== 'fulfilled') return;
      for (const item of result.value) {
        if (!merged[item.symbol]) merged[item.symbol] = { symbol: item.symbol };
        merged[item.symbol][key] = item.rate;
        if (nextKey && item.nextFunding) merged[item.symbol][nextKey] = item.nextFunding;
      }
    }

    mergeIn(binanceRes, 'binance', 'binanceNext');
    mergeIn(bybitRes,   'bybit',   'bybitNext');
    mergeIn(okxRes,     'okx',     'okxNext');
    mergeIn(bitgetRes,  'bitget',  null);
    mergeIn(mexcRes,    'mexc',    'mexcNext');
    mergeIn(kucoinRes,  'kucoin',  'kucoinNext');

    // 交易所手續費（Taker，開倉+平倉 = ×2）
    const FEES = {
      binance: 0.0005,  // 0.05%
      bybit:   0.0006,  // 0.06%
      okx:     0.0005,  // 0.05%
      bitget:  0.0006,  // 0.06%
      mexc:    0.0002,  // 0.02%
      kucoin:  0.0006,  // 0.06%
    };

    const EXCHANGES = ['binance','bybit','okx','bitget','mexc','kucoin'];

    const result = Object.values(merged)
      .map(row => {
        const available = EXCHANGES.filter(e => row[e] !== undefined);
        if (available.length < 2) return null;

        // 找最高費率交易所和最低費率交易所
        let maxEx = null, minEx = null;
        let maxRate = -Infinity, minRate = Infinity;
        for (const ex of available) {
          if (row[ex] > maxRate) { maxRate = row[ex]; maxEx = ex; }
          if (row[ex] < minRate) { minRate = row[ex]; minEx = ex; }
        }

        const spread = maxRate - minRate;
        // 套利總手續費 = (做多交易所taker + 做空交易所taker) × 2（開+平）
        const totalFee = (FEES[maxEx] + FEES[minEx]) * 2;
        const netSpread = spread - totalFee; // 扣手續費後的淨利差

        row.spread    = spread;
        row.netSpread = netSpread;
        row.maxEx     = maxEx;
        row.minEx     = minEx;
        row.maxRate   = maxRate;
        row.minRate   = minRate;
        row.totalFee  = totalFee;
        return row;
      })
      .filter(r => r && r.spread > 0)
      .sort((a, b) => b.netSpread - a.netSpread);

    const exchangeStatus = {
      binance: binanceRes.status === 'fulfilled' ? 'ok' : binanceRes.reason?.message,
      bybit:   bybitRes.status   === 'fulfilled' ? 'ok' : bybitRes.reason?.message,
      okx:     okxRes.status     === 'fulfilled' ? 'ok' : okxRes.reason?.message,
      bitget:  bitgetRes.status  === 'fulfilled' ? 'ok' : bitgetRes.reason?.message,
      mexc:    mexcRes.status    === 'fulfilled' ? 'ok' : mexcRes.reason?.message,
      kucoin:  kucoinRes.status  === 'fulfilled' ? 'ok' : kucoinRes.reason?.message,
    };

    res.status(200).json({
      success: true,
      data: result,
      exchangeStatus,
      updatedAt: Date.now(),
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// ─── Binance ──────────────────────────────────
async function fetchBinance() {
  const r = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const data = await r.json();
  return data
    .filter(d => d.symbol.endsWith('USDT') && d.lastFundingRate)
    .map(d => ({
      symbol: d.symbol.replace('USDT',''),
      rate: parseFloat(d.lastFundingRate),
      nextFunding: parseInt(d.nextFundingTime) || null,
    }));
}

// ─── Bybit ────────────────────────────────────
async function fetchBybit() {
  const r = await fetch('https://api.bybit.com/v5/market/tickers?category=linear',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  if (j.retCode !== 0) throw new Error(j.retMsg);
  return j.result.list
    .filter(d => d.symbol.endsWith('USDT') && d.fundingRate)
    .map(d => ({
      symbol: d.symbol.replace('USDT',''),
      rate: parseFloat(d.fundingRate),
      nextFunding: d.nextFundingTime ? parseInt(d.nextFundingTime) : null,
    }));
}

// ─── OKX ──────────────────────────────────────
async function fetchOKX() {
  const r = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  if (j.code !== '0') throw new Error('OKX instruments error');

  const syms = j.data.filter(d => d.instId.endsWith('-USDT-SWAP')).map(d => d.instId);
  const results = [];
  const batchSize = 20;
  for (let i = 0; i < Math.min(syms.length, 120); i += batchSize) {
    const batch = syms.slice(i, i + batchSize);
    const fetched = await Promise.allSettled(
      batch.map(id =>
        fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${id}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json())
      )
    );
    for (const f of fetched) {
      if (f.status==='fulfilled' && f.value.code==='0' && f.value.data?.[0]) {
        const d = f.value.data[0];
        results.push({
          symbol: d.instId.replace('-USDT-SWAP',''),
          rate: parseFloat(d.fundingRate),
          nextFunding: d.nextFundingTime ? parseInt(d.nextFundingTime) : null,
        });
      }
    }
  }
  return results;
}

// ─── Bitget ───────────────────────────────────
async function fetchBitget() {
  const r = await fetch('https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  if (j.code !== '00000') throw new Error(j.msg);
  return (j.data||[])
    .filter(d => d.symbol.endsWith('USDT') && d.fundingRate)
    .map(d => ({
      symbol: d.symbol.replace('USDT',''),
      rate: parseFloat(d.fundingRate),
      nextFunding: null,
    }));
}

// ─── MEXC ─────────────────────────────────────
async function fetchMEXC() {
  // 先取得所有合約列表
  const r = await fetch('https://api.mexc.com/api/v1/contract/detail',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  if (!j.success) throw new Error('MEXC contract list error');

  const symbols = (j.data || [])
    .filter(d => d.symbol.endsWith('_USDT'))
    .map(d => d.symbol);

  // 分批抓資金費率（每次20個）
  const results = [];
  const batchSize = 20;
  for (let i = 0; i < Math.min(symbols.length, 100); i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const fetched = await Promise.allSettled(
      batch.map(sym =>
        fetch(`https://api.mexc.com/api/v1/contract/funding_rate/${sym}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }).then(r => r.json())
      )
    );
    for (const f of fetched) {
      if (f.status==='fulfilled' && f.value.success && f.value.data) {
        const d = f.value.data;
        results.push({
          symbol: d.symbol.replace('_USDT',''),
          rate: parseFloat(d.fundingRate),
          nextFunding: d.nextSettleTime || null,
        });
      }
    }
  }
  return results;
}

// ─── KuCoin ───────────────────────────────────
async function fetchKuCoin() {
  // KuCoin 可以一次取得所有合約列表（含資金費率）
  const r = await fetch('https://api-futures.kucoin.com/api/v1/contracts/active',
    { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  if (j.code !== '200000') throw new Error('KuCoin error: ' + j.msg);

  return (j.data || [])
    .filter(d => d.quoteCurrency === 'USDT' && d.fundingFeeRate !== undefined)
    .map(d => ({
      // KuCoin 的 BTC 合約叫 XBTUSDTM，需要轉換
      symbol: d.baseCurrency === 'XBT' ? 'BTC' : d.baseCurrency,
      rate: parseFloat(d.fundingFeeRate),
      nextFunding: d.nextFundingRateTime || null,
    }));
}
