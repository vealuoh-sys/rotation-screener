const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3001;
const HOST = "0.0.0.0";
const TG_TOKEN = process.env.TG_TOKEN || "";
const TG_CHAT = process.env.TG_CHAT || "";
const SCAN_MINUTES = Math.max(2, Number(process.env.SCAN_MINUTES || 10));

const SPOT_HOSTS = [
  "data-api.binance.vision",
  "api.binance.com",
  "api1.binance.com",
  "api2.binance.com",
  "api3.binance.com",
  "api4.binance.com"
];

const FUTURES_HOSTS = ["fapi.binance.com", "fapi1.binance.com", "fapi2.binance.com"];

const SECTORS = {
  L1_MAJOR: ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "AVAXUSDT", "TRXUSDT", "TONUSDT", "HBARUSDT"],
  L1_ALT: ["NEARUSDT", "SUIUSDT", "APTUSDT", "ICPUSDT", "ALGOUSDT", "EGLDUSDT", "FLOWUSDT", "KAVAUSDT", "XTZUSDT", "EOSUSDT", "THETAUSDT", "MINAUSDT"],
  L2: ["POLUSDT", "ARBUSDT", "OPUSDT", "IMXUSDT", "STRKUSDT", "STXUSDT", "METISUSDT", "SKLUSDT", "LRCUSDT", "SCRUSDT"],
  DEFI: ["UNIUSDT", "AAVEUSDT", "CRVUSDT", "MKRUSDT", "SNXUSDT", "COMPUSDT", "SUSHIUSDT", "DYDXUSDT", "GMXUSDT", "CAKEUSDT", "BALUSDT", "YFIUSDT", "1INCHUSDT", "RUNEUSDT", "KNCUSDT"],
  AI_DATA: ["FETUSDT", "RENDERUSDT", "GRTUSDT", "INJUSDT", "WLDUSDT", "TAOUSDT", "NMRUSDT", "PHAUSDT", "ARKMUSDT"],
  GAMING: ["AXSUSDT", "SANDUSDT", "MANAUSDT", "GALAUSDT", "GMTUSDT", "APEUSDT", "ILVUSDT", "YGGUSDT", "MBOXUSDT", "ALICEUSDT", "TLMUSDT", "RAREUSDT"],
  INFRA: ["LINKUSDT", "FILUSDT", "LDOUSDT", "ENSUSDT", "STORJUSDT", "SCUSDT", "NKNUSDT", "IOTAUSDT", "JASMYUSDT", "QNTUSDT"],
  PAYMENTS: ["XLMUSDT", "LTCUSDT", "VETUSDT", "ZECUSDT", "DASHUSDT", "BCHUSDT", "DGBUSDT", "COTIUSDT", "ACHUSDT", "REQUSDT"],
  COSMOS: ["ATOMUSDT", "TIAUSDT", "RUNEUSDT", "INJUSDT", "AKTUSDT", "OSMOUSDT", "NTRNUSDT"],
  MEME: ["DOGEUSDT", "SHIBUSDT", "PEPEUSDT", "FLOKIUSDT", "BONKUSDT", "WIFUSDT", "MEMEUSDT", "TURBOUSDT", "BOMEUSDT", "PNUTUSDT"],
  EXCHANGE: ["BNBUSDT", "CAKEUSDT", "DYDXUSDT", "GTCUSDT"],
  PRIVACY: ["XMRUSDT", "ZECUSDT", "DASHUSDT", "ROSEUSDT", "SCRTUSDT", "PHAUSDT"],
  ORACLE: ["LINKUSDT", "BANDUSDT", "API3USDT", "PYTHUSDT"],
  RWA: ["ONDOUSDT", "PENDLEUSDT", "MKRUSDT", "RLCUSDT", "POLYXUSDT"],
  BIG_ALTS: ["SOLUSDT", "AVAXUSDT", "DOTUSDT", "NEARUSDT", "POLUSDT", "LTCUSDT", "LINKUSDT", "ATOMUSDT", "UNIUSDT", "AAVEUSDT", "XRPUSDT", "ADAUSDT", "FILUSDT", "ARBUSDT", "OPUSDT"]
};

const SUB_NARRATIVE = {
  ETH_L2: ["POLUSDT", "ARBUSDT", "OPUSDT", "METISUSDT", "SKLUSDT", "LRCUSDT", "IMXUSDT", "STRKUSDT", "SCRUSDT"],
  SOL_ECO: ["SOLUSDT", "BONKUSDT", "WIFUSDT", "BOMEUSDT", "JUPUSDT", "PYTHUSDT"],
  COSMOS_ECO: ["ATOMUSDT", "TIAUSDT", "INJUSDT", "AKTUSDT", "OSMOUSDT", "NTRNUSDT", "RUNEUSDT"],
  AI_COMPUTE: ["FETUSDT", "RENDERUSDT", "WLDUSDT", "TAOUSDT", "GRTUSDT", "NMRUSDT", "ARKMUSDT"],
  DEX: ["UNIUSDT", "SUSHIUSDT", "CRVUSDT", "BALUSDT", "1INCHUSDT", "CAKEUSDT"],
  LENDING: ["AAVEUSDT", "COMPUSDT", "MKRUSDT", "SNXUSDT"],
  PERPS: ["DYDXUSDT", "GMXUSDT", "SNXUSDT"],
  MEME_OG: ["DOGEUSDT", "SHIBUSDT"],
  MEME_NEW: ["PEPEUSDT", "FLOKIUSDT", "BONKUSDT", "WIFUSDT", "MEMEUSDT", "TURBOUSDT", "BOMEUSDT", "PNUTUSDT"],
  STORAGE: ["FILUSDT", "STORJUSDT", "SCUSDT"],
  ORACLE: ["LINKUSDT", "BANDUSDT", "API3USDT", "PYTHUSDT"],
  RWA: ["ONDOUSDT", "PENDLEUSDT", "MKRUSDT", "POLYXUSDT"]
};

const CORR_PAIRS = [
  ["BTCUSDT", "ETHUSDT"], ["ETHUSDT", "SOLUSDT"], ["SOLUSDT", "AVAXUSDT"], ["AVAXUSDT", "NEARUSDT"],
  ["APTUSDT", "SUIUSDT"], ["ARBUSDT", "OPUSDT"], ["POLUSDT", "ARBUSDT"], ["IMXUSDT", "OPUSDT"],
  ["UNIUSDT", "AAVEUSDT"], ["CRVUSDT", "AAVEUSDT"], ["GMXUSDT", "DYDXUSDT"], ["SUSHIUSDT", "UNIUSDT"],
  ["SANDUSDT", "MANAUSDT"], ["AXSUSDT", "GALAUSDT"], ["DOGEUSDT", "SHIBUSDT"], ["PEPEUSDT", "FLOKIUSDT"],
  ["BONKUSDT", "WIFUSDT"], ["XRPUSDT", "XLMUSDT"], ["LTCUSDT", "BCHUSDT"], ["FETUSDT", "RENDERUSDT"],
  ["FETUSDT", "GRTUSDT"], ["ATOMUSDT", "TIAUSDT"], ["ONDOUSDT", "PENDLEUSDT"], ["LINKUSDT", "PYTHUSDT"]
];

const CAP_TIER = {
  BTCUSDT: 1, ETHUSDT: 1, BNBUSDT: 1, SOLUSDT: 1, XRPUSDT: 1,
  ADAUSDT: 2, AVAXUSDT: 2, DOGEUSDT: 2, DOTUSDT: 2, TRXUSDT: 2, TONUSDT: 2, LINKUSDT: 2, UNIUSDT: 2,
  NEARUSDT: 3, SUIUSDT: 3, APTUSDT: 3, ARBUSDT: 3, OPUSDT: 3, ATOMUSDT: 3, HBARUSDT: 3, ICPUSDT: 3,
  FILUSDT: 3, INJUSDT: 3, IMXUSDT: 3, AAVEUSDT: 3, TIAUSDT: 3, RUNEUSDT: 3, WLDUSDT: 3, POLUSDT: 3,
  FETUSDT: 4, RENDERUSDT: 4, GRTUSDT: 4, SUSHIUSDT: 4, DYDXUSDT: 4, GMXUSDT: 4, CRVUSDT: 4, MKRUSDT: 4,
  CAKEUSDT: 4, SANDUSDT: 4, MANAUSDT: 4, AXSUSDT: 4, SNXUSDT: 4, COMPUSDT: 4, LDOUSDT: 4, ENSUSDT: 4,
  STXUSDT: 4, GALAUSDT: 4, APEUSDT: 4, GMTUSDT: 4, YFIUSDT: 4, BALUSDT: 4, ONDOUSDT: 4, PENDLEUSDT: 4
};

const SYMBOL_SECTOR = {};
for (const [sector, coins] of Object.entries(SECTORS)) {
  for (const sym of coins) if (!SYMBOL_SECTOR[sym]) SYMBOL_SECTOR[sym] = sector;
}

const SYM_NARRATIVES = {};
for (const [name, coins] of Object.entries(SUB_NARRATIVE)) {
  for (const sym of coins) {
    if (!SYM_NARRATIVES[sym]) SYM_NARRATIVES[sym] = [];
    SYM_NARRATIVES[sym].push(name);
  }
}

let validSpotSymbols = new Set();
let validFuturesSymbols = new Set();
let allSymbols = [...new Set(Object.values(SECTORS).flat())];
let scanInProgress = false;

let rotationCache = {
  ok: true,
  signals: [],
  sectors: {},
  metrics: {},
  regime: null,
  ts: null,
  scanning: false,
  progress: { done: 0, total: 0 },
  coinCount: 0,
  skippedSymbols: []
};

const ipMap = new Map();
const alertedSignals = new Map();

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function pct(a, b) { return b ? ((a - b) / b) * 100 : 0; }
function avg(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function sum(a) { return a.reduce((x, y) => x + y, 0); }
function round(n, d = 2) { return Number.isFinite(n) ? Number(n.toFixed(d)) : 0; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function clean(sym) { return String(sym || "").replace("USDT", ""); }
function capTier(sym) { return CAP_TIER[sym] || 4; }

function jsonRequest(hosts, reqPath, timeoutMs = 15000) {
  function tryHost(i) {
    if (i >= hosts.length) return Promise.reject(new Error("all endpoints failed"));
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: hosts[i],
        path: reqPath,
        method: "GET",
        headers: { "User-Agent": "RotationScreenerPro/2.0", Accept: "application/json" },
        timeout: timeoutMs
      }, res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 400) return tryHost(i + 1).then(resolve).catch(reject);
          try {
            const data = JSON.parse(body);
            if (data && data.code && data.msg) return tryHost(i + 1).then(resolve).catch(reject);
            resolve(data);
          } catch {
            tryHost(i + 1).then(resolve).catch(reject);
          }
        });
      });
      req.on("timeout", () => { req.destroy(); tryHost(i + 1).then(resolve).catch(reject); });
      req.on("error", () => tryHost(i + 1).then(resolve).catch(reject));
      req.end();
    });
  }
  return tryHost(0);
}

const spot = p => jsonRequest(SPOT_HOSTS, p);
const futures = p => jsonRequest(FUTURES_HOSTS, p);

async function fetchKlines(symbol, interval, limit) {
  const raw = await spot(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return raw.map(k => ({
    time: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    quoteVolume: Number(k[7] || 0)
  }));
}

function ema(values, period) {
  if (!values.length) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function atr(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  return avg(trs.slice(-period));
}

function vwap(candles) {
  const pv = sum(candles.map(c => ((c.high + c.low + c.close) / 3) * (c.quoteVolume || c.volume)));
  const vv = sum(candles.map(c => c.quoteVolume || c.volume));
  return vv ? pv / vv : candles[candles.length - 1]?.close || 0;
}

function calcVP(candles, bins = 36) {
  if (!candles || candles.length < 10) return null;
  let lo = Infinity, hi = -Infinity;
  candles.forEach(c => { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); });
  const range = hi - lo;
  if (!Number.isFinite(range) || range <= 0) return null;

  const bin = range / bins;
  const vol = new Array(bins).fill(0);

  candles.forEach(c => {
    const typical = (c.high + c.low + c.close) / 3;
    const idx = clamp(Math.floor((typical - lo) / bin), 0, bins - 1);
    vol[idx] += c.volume;
  });

  let pocIdx = 0;
  vol.forEach((v, i) => { if (v > vol[pocIdx]) pocIdx = i; });

  const target = sum(vol) * 0.7;
  let vaVol = vol[pocIdx], vaLo = pocIdx, vaHi = pocIdx;

  while (vaVol < target) {
    const left = vaLo > 0 ? vol[vaLo - 1] : -1;
    const right = vaHi < bins - 1 ? vol[vaHi + 1] : -1;
    if (left >= right && vaLo > 0) { vaLo--; vaVol += left; }
    else if (vaHi < bins - 1) { vaHi++; vaVol += right; }
    else break;
  }

  return {
    val: lo + vaLo * bin,
    poc: lo + (pocIdx + 0.5) * bin,
    vah: lo + (vaHi + 1) * bin
  };
}

function vpScore(price, vp) {
  if (!vp) return 45;
  const dVal = Math.abs(price - vp.val) / vp.val * 100;
  const dPoc = Math.abs(price - vp.poc) / vp.poc * 100;
  const dVah = Math.abs(price - vp.vah) / vp.vah * 100;

  if (price < vp.val * 0.985) return 15;
  if (dVal <= 0.8) return 100;
  if (dVal <= 2.0) return 88;
  if (dPoc <= 1.0) return 68;
  if (dPoc <= 2.0) return 55;
  if (dVah <= 1.5) return 42;
  if (price >= vp.val && price <= vp.vah) return 48;
  return 30;
}

function vpLabel(price, vp) {
  if (!vp) return "NO VP";
  const dVal = Math.abs(price - vp.val) / vp.val * 100;
  const dPoc = Math.abs(price - vp.poc) / vp.poc * 100;
  const dVah = Math.abs(price - vp.vah) / vp.vah * 100;

  if (price < vp.val * 0.985) return "BELOW VALUE";
  if (dVal <= 2.0) return "AT VAL SUPPORT";
  if (dPoc <= 2.0) return "AT POC";
  if (dVah <= 1.5) return "AT VAH RESISTANCE";
  if (price >= vp.val && price <= vp.vah) return "IN VALUE";
  return "ABOVE VALUE";
}

function volumeQuality(candles) {
  const last = candles[candles.length - 1];
  const prev = candles.slice(-21, -1);
  const avgVol = avg(prev.map(c => c.volume));
  const volRatio = avgVol ? last.volume / avgVol : 1;
  const range = Math.max(last.high - last.low, last.close * 0.0001);
  const closeLocation = (last.close - last.low) / range;
  const body = Math.abs(last.close - last.open) / range;

  let score = 40;
  if (volRatio >= 1.2) score += 15;
  if (volRatio >= 2.0) score += 10;
  if (closeLocation >= 0.65) score += 18;
  if (body >= 0.45) score += 10;
  if (last.close >= last.open) score += 7;
  if (closeLocation < 0.35 && volRatio > 1.5) score -= 25;

  return {
    score: clamp(Math.round(score), 0, 100),
    closeLocation: round(closeLocation * 100, 0),
    candleBody: round(body * 100, 0),
    volRatio
  };
}

function structure(c1h, c4h, c1d) {
  const last = c1h[c1h.length - 1];
  const closes = c1h.map(c => c.close);
  const ema20 = ema(closes.slice(-40), 20);
  const ema50 = ema(closes.slice(-70), 50);
  const vw = vwap(c1h.slice(-24));
  const rangeHigh20 = Math.max(...c1h.slice(-21, -1).map(c => c.high));
  const rangeLow20 = Math.min(...c1h.slice(-21, -1).map(c => c.low));
  const prevDay = c1d[c1d.length - 2] || c1d[0];

  let state = "ACCUMULATION";
  let score = 50;

  if (last.close > rangeHigh20 && last.close > vw) {
    state = "BREAKOUT CONFIRMED";
    score = 92;
  } else if (pct(last.close, rangeHigh20) > -0.7 && last.close > ema20) {
    state = "PRE-BREAKOUT";
    score = 78;
  } else if (last.close > ema20 && last.close > vw) {
    state = "TRENDING";
    score = 68;
  } else if (last.close < ema50 && last.close < vw) {
    state = "WEAK STRUCTURE";
    score = 25;
  }

  if (last.close > prevDay.high) score += 5;
  if (last.close < prevDay.low) score -= 20;

  return {
    ema20,
    ema50,
    vwap: vw,
    atr: atr(c1h, 14),
    rangeHigh20,
    rangeLow20,
    prevDayHigh: prevDay.high,
    prevDayLow: prevDay.low,
    breakoutDistance: round(pct(last.close, rangeHigh20), 2),
    downsideToRangeLow: round(pct(last.close, rangeLow20), 2),
    state,
    score: clamp(Math.round(score), 0, 100)
  };
}

function calcMetrics(symbol, c1h, c4h, c1d, ticker24, book) {
  const last = c1h[c1h.length - 1];
  const open1h = c1h[c1h.length - 2]?.close || last.open;
  const open4h = c4h[c4h.length - 2]?.close || c4h[0].open;
  const open24h = c1d[c1d.length - 2]?.close || c1d[0].open;

  const vq = volumeQuality(c1h);
  const st = structure(c1h, c4h, c1d);
  const vp = calcVP(c1h.slice(-60));

  const bid = Number(book?.bidPrice || 0);
  const ask = Number(book?.askPrice || 0);
  const mid = bid && ask ? (bid + ask) / 2 : last.close;
  const spreadPct = bid && ask ? ((ask - bid) / mid) * 100 : 0.2;

  return {
    symbol,
    sector: SYMBOL_SECTOR[symbol] || "OTHER",
    price: last.close,
    change1h: pct(last.close, open1h),
    change4h: pct(last.close, open4h),
    change24h: pct(last.close, open24h),
    volRatio: vq.volRatio,
    quoteVolume24h: Number(ticker24?.quoteVolume || sum(c1h.slice(-24).map(c => c.quoteVolume || 0))),
    spreadPct,
    vp,
    vpLabel: vpLabel(last.close, vp),
    structure: st,
    volumeQuality: vq,
    lastCandleTime: last.time
  };
}

function sharedNarratives(a, b) {
  const aa = SYM_NARRATIVES[a] || [];
  const bb = SYM_NARRATIVES[b] || [];
  return aa.filter(x => bb.includes(x)).length;
}

function capTierScore(a, b) {
  const diff = Math.abs(capTier(a) - capTier(b));
  return [100, 65, 30, 5, 0][diff] || 0;
}

function liquidityScore(m) {
  let score = 100;
  if (m.quoteVolume24h < 1000000) score -= 45;
  else if (m.quoteVolume24h < 5000000) score -= 25;
  else if (m.quoteVolume24h < 15000000) score -= 10;

  if (m.spreadPct > 0.35) score -= 35;
  else if (m.spreadPct > 0.18) score -= 18;
  else if (m.spreadPct > 0.08) score -= 8;

  return clamp(Math.round(score), 0, 100);
}

function coilScore(m) {
  let score = 65;
  const ran24 = Math.abs(m.change24h);
  const ran4 = Math.abs(m.change4h);

  if (ran24 < 3) score += 18;
  else if (ran24 > 12) score -= 30;
  else if (ran24 > 7) score -= 14;

  if (ran4 < 1.5 && Math.abs(m.change1h) > 0.15) score += 12;
  if (m.change4h < -4) score -= 25;

  return clamp(Math.round(score), 0, 100);
}

function futuresScore(f) {
  if (!f || !f.available) return 50;
  let score = 55;

  if (f.openInterestChangePct > 2 && f.openInterestChangePct < 15) score += 22;
  if (f.openInterestChangePct >= 15) score += 8;

  if (Math.abs(f.fundingRatePct) < 0.025) score += 15;
  else if (f.fundingRatePct > 0.08) score -= 25;
  else if (f.fundingRatePct < -0.05) score += 8;

  return clamp(Math.round(score), 0, 100);
}

function grade(score) {
  if (score >= 86) return "A+";
  if (score >= 78) return "A";
  if (score >= 68) return "B";
  if (score >= 58) return "C";
  return "D";
}

function calcRegime(metrics) {
  const btc = metrics.BTCUSDT;
  const eth = metrics.ETHUSDT;
  const sol = metrics.SOLUSDT;
  let score = 50;
  const notes = [];

  if (btc) {
    if (btc.change4h > 0.8 && btc.price > btc.structure.vwap) {
      score += 20;
      notes.push("BTC supports risk");
    } else if (btc.change4h < -1.2 || btc.price < btc.structure.ema50) {
      score -= 25;
      notes.push("BTC pressure");
    }
  }

  if (eth && btc) {
    const ethVsBtc4h = eth.change4h - btc.change4h;
    if (ethVsBtc4h > 0.4) {
      score += 12;
      notes.push("ETH leading BTC");
    } else if (ethVsBtc4h < -0.8) {
      score -= 10;
      notes.push("ETH lagging BTC");
    }
  }

  if (sol && btc && sol.change4h - btc.change4h > 0.6) {
    score += 8;
    notes.push("SOL beta active");
  }

  score = clamp(Math.round(score), 0, 100);

  return {
    score,
    label: score >= 70 ? "RISK ON" : score >= 45 ? "NEUTRAL" : "RISK OFF",
    btc4h: round(btc?.change4h || 0, 2),
    ethVsBtc4h: round((eth?.change4h || 0) - (btc?.change4h || 0), 2),
    notes
  };
}

function sectorSummaries(metrics) {
  const out = {};

  for (const [sector, coins] of Object.entries(SECTORS)) {
    const rows = coins.filter(s => metrics[s]).map(s => metrics[s]);
    if (!rows.length) continue;

    const leader = [...rows].sort((a, b) => b.change1h - a.change1h)[0];

    out[sector] = {
      coins: rows.length,
      avgChange1h: round(avg(rows.map(r => r.change1h)), 2),
      avgChange4h: round(avg(rows.map(r => r.change4h)), 2),
      maxVolRatio: round(Math.max(...rows.map(r => r.volRatio)), 2),
      leader: leader.symbol,
      leaderChange1h: round(leader.change1h, 2)
    };
  }

  return out;
}

function setupLabel(s) {
  if (s.grade === "A+" && s.structureState === "PRE-BREAKOUT") return "ACTIONABLE WATCH";
  if (s.grade === "A+" && s.structureState === "BREAKOUT CONFIRMED") return "BREAKOUT LIVE";
  if (s.grade === "A" && s.regimeLabel !== "RISK OFF") return "HIGH QUALITY";
  if (s.regimeLabel === "RISK OFF") return "DEFENSIVE ONLY";
  if (s.liquidityScore < 55) return "LIQUIDITY RISK";
  return "WATCHLIST";
}

function scoreCandidate(symbol, leader, signalType, lag, metrics, sectors, regime, futuresMap) {
  const m = metrics[symbol];
  const lm = metrics[leader];
  const sector = m.sector || SYMBOL_SECTOR[symbol] || "OTHER";
  const sec = sectors[sector];
  const btc = metrics.BTCUSDT;
  const narCount = sharedNarratives(symbol, leader);

  const narrativeScore =
    narCount >= 2 ? 100 :
    narCount === 1 ? 78 :
    sector === (lm?.sector || SYMBOL_SECTOR[leader]) ? 55 : 25;

  const rotationCore =
    narrativeScore * 0.36 +
    capTierScore(symbol, leader) * 0.22 +
    clamp(lag * 18 + 45, 0, 100) * 0.25 +
    coilScore(m) * 0.17;

  const relBtc = btc ? m.change4h - btc.change4h : 0;
  const relSector = sec ? m.change1h - sec.avgChange1h : 0;
  const relativeStrengthScore = clamp(55 + relBtc * 9 + relSector * 5, 0, 100);

  const liq = liquidityScore(m);
  const structureScore = m.structure.score * 0.72 + vpScore(m.price, m.vp) * 0.28;
  const fut = futuresMap[symbol] || { available: false };
  const futScore = futuresScore(fut);
  let regimeScore = regime.score;

  if (sector === "MEME" && regime.label === "RISK OFF") regimeScore -= 15;

  const total =
    rotationCore * 0.27 +
    relativeStrengthScore * 0.15 +
    structureScore * 0.17 +
    liq * 0.13 +
    futScore * 0.12 +
    regimeScore * 0.10 +
    m.volumeQuality.score * 0.06;

  const score = clamp(Math.round(total), 0, 100);
  const invalidation = Math.min(m.structure.rangeLow20, m.vp?.val || m.structure.rangeLow20);
  const resistance = Math.max(m.structure.rangeHigh20, m.vp?.vah || m.structure.rangeHigh20, m.structure.prevDayHigh);
  const riskPct = Math.abs(pct(m.price, invalidation));
  const rewardPct = Math.max(0, pct(resistance, m.price));

  return {
    score,
    grade: grade(score),
    scoreBreakdown: {
      rotation: Math.round(rotationCore),
      relativeStrength: Math.round(relativeStrengthScore),
      structure: Math.round(structureScore),
      liquidity: Math.round(liq),
      futures: Math.round(futScore),
      regime: Math.round(regimeScore),
      volumeQuality: Math.round(m.volumeQuality.score)
    },
    relative: {
      btc4h: round(relBtc, 2),
      sector1h: round(relSector, 2)
    },
    liquidityScore: liq,
    futures: fut,
    narCount,
    capTierVal: capTier(symbol),
    vpLabel: m.vpLabel,
    structureState: m.structure.state,
    invalidation: round(invalidation, 8),
    resistance: round(resistance, 8),
    riskReward: round(riskPct > 0 ? rewardPct / riskPct : 0, 2),
    upsideToLeader: round(Math.max(0, (lm?.change1h || 0) - m.change1h), 2),
    chaseRisk: m.change1h > 4 || (m.vp && m.price > m.vp.vah * 1.025)
  };
}

function makeSignal(type, symbol, leader, lag, metrics, sectors, regime, futuresMap, extra = {}) {
  const m = metrics[symbol];
  const lm = metrics[leader];
  const scored = scoreCandidate(symbol, leader, type, lag, metrics, sectors, regime, futuresMap);

  const s = {
    id: `${type}-${symbol}-${leader}-${Date.now()}`,
    type,
    symbol,
    sector: m.sector || SYMBOL_SECTOR[symbol] || "OTHER",
    leader,
    leaderGain: round(lm?.change1h || 0, 2),
    ownChange1h: round(m.change1h, 2),
    ownChange4h: round(m.change4h, 2),
    change24h: round(m.change24h, 2),
    lag: round(lag, 2),
    price: m.price,
    volRatio: round(m.volRatio, 2),
    quoteVolume24h: round(m.quoteVolume24h, 0),
    spreadPct: round(m.spreadPct, 3),
    regimeLabel: regime.label,
    createdAt: new Date().toISOString(),
    narrative: `${clean(leader)} leads, ${clean(symbol)} lags by ${round(lag, 2)}%. ${scored.structureState}. ${scored.vpLabel}.`,
    ...scored,
    ...extra
  };

  s.setup = setupLabel(s);
  return s;
}

function detectSectorRotation(metrics, sectors, regime, futuresMap) {
  const signals = [];

  for (const [sector, coins] of Object.entries(SECTORS)) {
    const rows = coins.filter(s => metrics[s]).sort((a, b) => metrics[b].change1h - metrics[a].change1h);
    if (rows.length < 2) continue;

    const leader = rows[0];
    const leaderGain = metrics[leader].change1h;
    if (leaderGain < 0.35) continue;

    rows.slice(1).forEach(sym => {
      const m = metrics[sym];
      if (m.change1h > leaderGain * 0.72) return;
      if (m.change4h < -6) return;
      signals.push(makeSignal("SECTOR", sym, leader, leaderGain - m.change1h, metrics, sectors, regime, futuresMap, { sector }));
    });
  }

  return signals;
}

function detectCorrelationDivergence(metrics, sectors, regime, futuresMap) {
  const signals = [];

  for (const [a, b] of CORR_PAIRS) {
    if (!metrics[a] || !metrics[b]) continue;

    const diff = metrics[a].change1h - metrics[b].change1h;
    const absDiff = Math.abs(diff);
    if (absDiff < 0.35) continue;

    const leader = diff > 0 ? a : b;
    const laggard = diff > 0 ? b : a;

    if (metrics[laggard].change4h < -6) continue;
    signals.push(makeSignal("CORR", laggard, leader, absDiff, metrics, sectors, regime, futuresMap));
  }

  return signals;
}

function detectVolumeFlow(metrics, sectors, regime, futuresMap) {
  const signals = [];

  for (const [sector, coins] of Object.entries(SECTORS)) {
    const rows = coins.filter(s => metrics[s]);
    const leaders = rows
      .filter(s => metrics[s].volRatio >= 1.5 && metrics[s].change1h > -0.6)
      .sort((a, b) => metrics[b].volRatio - metrics[a].volRatio);

    if (!leaders.length) continue;

    const leader = leaders[0];
    const lm = metrics[leader];

    rows.forEach(sym => {
      if (sym === leader) return;
      const m = metrics[sym];
      if (m.volRatio > lm.volRatio * 0.75) return;
      if (m.change1h < -3.5) return;

      signals.push(makeSignal("VOLFLOW", sym, leader, Math.max(0.1, lm.change1h - m.change1h), metrics, sectors, regime, futuresMap, {
        sector,
        leaderVol: round(lm.volRatio, 2)
      }));
    });
  }

  return signals;
}

function dedupeSignals(signals) {
  const bySymbol = new Map();

  signals.forEach(s => {
    if (!bySymbol.has(s.symbol)) bySymbol.set(s.symbol, []);
    bySymbol.get(s.symbol).push(s);
  });

  const out = [];

  for (const rows of bySymbol.values()) {
    rows.sort((a, b) => b.score - a.score);
    const best = { ...rows[0] };
    const types = [...new Set(rows.map(r => r.type))];

    best.confirmedTypes = types;
    best.confirmed = types.length > 1;
    best.allNarratives = rows.map(r => `[${r.type}] ${r.narrative}`);

    if (best.confirmed) {
      best.score = clamp(best.score + 7, 0, 100);
      best.grade = grade(best.score);
      best.setup = setupLabel(best);
      best.narrative = `Multi-confirmed by ${types.join("+")}. ${best.narrative}`;
    }

    out.push(best);
  }

  return out.sort((a, b) => b.score - a.score);
}

async function loadExchangeInfo() {
  const [spotInfo, futuresInfo] = await Promise.allSettled([
    spot("/api/v3/exchangeInfo"),
    futures("/fapi/v1/exchangeInfo")
  ]);

  if (spotInfo.status === "fulfilled") {
    validSpotSymbols = new Set((spotInfo.value.symbols || [])
      .filter(s => s.status === "TRADING" && s.quoteAsset === "USDT" && s.isSpotTradingAllowed !== false)
      .map(s => s.symbol));
  }

  if (futuresInfo.status === "fulfilled") {
    validFuturesSymbols = new Set((futuresInfo.value.symbols || [])
      .filter(s => s.status === "TRADING" && s.quoteAsset === "USDT")
      .map(s => s.symbol));
  }

  if (validSpotSymbols.size) {
    allSymbols = allSymbols.filter(s => validSpotSymbols.has(s));
  }
}

async function fetchMarketMaps() {
  const [tickers, books] = await Promise.allSettled([
    spot("/api/v3/ticker/24hr"),
    spot("/api/v3/ticker/bookTicker")
  ]);

  const tickerMap = {};
  const bookMap = {};

  if (tickers.status === "fulfilled" && Array.isArray(tickers.value)) {
    tickers.value.forEach(t => { tickerMap[t.symbol] = t; });
  }

  if (books.status === "fulfilled" && Array.isArray(books.value)) {
    books.value.forEach(b => { bookMap[b.symbol] = b; });
  }

  return { tickerMap, bookMap };
}

async function fetchFuturesEnrichment(symbols) {
  const out = {};
  const targets = symbols.filter(s => validFuturesSymbols.has(s)).slice(0, 45);

  for (let i = 0; i < targets.length; i += 3) {
    const batch = targets.slice(i, i + 3);

    await Promise.allSettled(batch.map(async sym => {
      try {
        const [premium, oiHist] = await Promise.allSettled([
          futures(`/fapi/v1/premiumIndex?symbol=${sym}`),
          futures(`/futures/data/openInterestHist?symbol=${sym}&period=5m&limit=12`)
        ]);

        let fundingRatePct = 0;
        let openInterestChangePct = 0;

        if (premium.status === "fulfilled") {
          fundingRatePct = Number(premium.value.lastFundingRate || 0) * 100;
        }

        if (oiHist.status === "fulfilled" && Array.isArray(oiHist.value) && oiHist.value.length >= 2) {
          const first = Number(oiHist.value[0].sumOpenInterest || oiHist.value[0].sumOpenInterestValue || 0);
          const last = Number(oiHist.value[oiHist.value.length - 1].sumOpenInterest || oiHist.value[oiHist.value.length - 1].sumOpenInterestValue || 0);
          openInterestChangePct = first ? ((last - first) / first) * 100 : 0;
        }

        out[sym] = {
          available: true,
          fundingRatePct: round(fundingRatePct, 4),
          openInterestChangePct: round(openInterestChangePct, 2)
        };
      } catch {
        out[sym] = { available: false };
      }
    }));

    await sleep(150);
  }

  return out;
}

async function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT) return;
  const text = encodeURIComponent(msg);
  const reqPath = `/bot${TG_TOKEN}/sendMessage?chat_id=${TG_CHAT}&text=${text}&parse_mode=HTML`;
  jsonRequest(["api.telegram.org"], reqPath, 10000).catch(() => {});
}

function sendTopAlerts(signals) {
  const now = Date.now();

  for (const [k, ts] of alertedSignals) {
    if (now - ts > 30 * 60 * 1000) alertedSignals.delete(k);
  }

  signals.slice(0, 5).forEach(s => {
    if (!["A+", "A"].includes(s.grade)) return;

    const key = `${s.type}-${s.symbol}-${s.leader}-${s.grade}`;
    if (alertedSignals.has(key)) return;
    alertedSignals.set(key, now);

    sendTelegram([
      `<b>${s.grade} ROTATION SETUP</b>`,
      `${clean(s.symbol)} lagging ${clean(s.leader)} | ${s.type}`,
      `Score ${s.score}% | ${s.setup}`,
      `1H ${s.ownChange1h}% | Lag ${s.lag}% | RR ${s.riskReward}`,
      `Regime ${s.regimeLabel} | ${s.structureState}`
    ].join("\n"));
  });
}

async function runScan() {
  if (scanInProgress) return;

  scanInProgress = true;
  rotationCache.scanning = true;
  rotationCache.progress = { done: 0, total: allSymbols.length };

  console.log(`[SCAN] Starting ${allSymbols.length} symbols`);

  try {
    if (!validSpotSymbols.size) await loadExchangeInfo();

    const skippedSymbols = [...new Set(Object.values(SECTORS).flat())]
      .filter(s => validSpotSymbols.size && !validSpotSymbols.has(s));

    const { tickerMap, bookMap } = await fetchMarketMaps();
    const metrics = {};
    const concurrency = 5;

    for (let i = 0; i < allSymbols.length; i += concurrency) {
      const batch = allSymbols.slice(i, i + concurrency);

      await Promise.allSettled(batch.map(async sym => {
        try {
          const [c1h, c4h, c1d] = await Promise.all([
            fetchKlines(sym, "1h", 80),
            fetchKlines(sym, "4h", 60),
            fetchKlines(sym, "1d", 30)
          ]);

          metrics[sym] = calcMetrics(sym, c1h, c4h, c1d, tickerMap[sym], bookMap[sym]);
        } catch (e) {
          console.log(`[WARN] ${sym}: ${e.message}`);
        } finally {
          rotationCache.progress.done += 1;
        }
      }));

      await sleep(250);
    }

    const sectors = sectorSummaries(metrics);
    const regime = calcRegime(metrics);

    const early = [
      ...detectSectorRotation(metrics, sectors, regime, {}),
      ...detectCorrelationDivergence(metrics, sectors, regime, {}),
      ...detectVolumeFlow(metrics, sectors, regime, {})
    ].sort((a, b) => b.score - a.score);

    const enrichSymbols = [...new Set(early.slice(0, 60).flatMap(s => [s.symbol, s.leader]))];
    const futuresMap = await fetchFuturesEnrichment(enrichSymbols);

    const signals = dedupeSignals([
      ...detectSectorRotation(metrics, sectors, regime, futuresMap),
      ...detectCorrelationDivergence(metrics, sectors, regime, futuresMap),
      ...detectVolumeFlow(metrics, sectors, regime, futuresMap)
    ]).slice(0, 180);

    rotationCache = {
      ok: true,
      signals,
      sectors,
      metrics,
      regime,
      ts: new Date().toISOString(),
      scanning: false,
      progress: { done: allSymbols.length, total: allSymbols.length },
      coinCount: Object.keys(metrics).length,
      skippedSymbols
    };

    sendTopAlerts(signals);
    console.log(`[SCAN] Done: ${signals.length} signals, ${Object.keys(metrics).length} coins, ${regime.label}`);
  } catch (e) {
    console.error("[SCAN ERROR]", e);
    rotationCache.scanning = false;
    rotationCache.error = e.message;
  } finally {
    scanInProgress = false;
  }
}

function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function isRateLimited(ip, limit = 20) {
  const now = Date.now();
  const e = ipMap.get(ip) || { count: 0, reset: now + 60000 };

  if (now > e.reset) {
    e.count = 0;
    e.reset = now + 60000;
  }

  e.count += 1;
  ipMap.set(ip, e);
  return e.count > limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of ipMap) {
    if (now > e.reset) ipMap.delete(ip);
  }
}, 5 * 60000);

const server = http.createServer((req, res) => {
  setCORS(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const clientIP = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0];

  if (pathname === "/" || pathname === "/index.html" || pathname === "/rotation.html") {
    const htmlPath = path.join(__dirname, "rotation.html");
    if (!fs.existsSync(htmlPath)) {
      res.writeHead(404);
      return res.end("rotation.html not found");
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(fs.readFileSync(htmlPath));
  }

  if (pathname === "/api/rotation") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify(rotationCache));
  }

  if (pathname === "/api/sectors") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ ok: true, sectors: rotationCache.sectors || {} }));
  }

  if (pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({
      ok: true,
      scanning: scanInProgress,
      coinCount: rotationCache.coinCount,
      ts: rotationCache.ts,
      regime: rotationCache.regime,
      progress: rotationCache.progress
    }));
  }

  if (pathname === "/api/trigger-scan") {
    if (isRateLimited(clientIP, 6)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, message: "Too many scan requests. Wait a minute." }));
    }

    if (!scanInProgress) runScan().catch(console.error);

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, message: scanInProgress ? "Scan already running" : "Scan started" }));
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, HOST, async () => {
  console.log(`Professional Rotation Screener running on ${HOST}:${PORT}`);

  if (!TG_TOKEN) console.warn("[INFO] Telegram alerts disabled. Set TG_TOKEN and TG_CHAT to enable.");

  try {
    await loadExchangeInfo();
  } catch (e) {
    console.warn("[WARN] exchangeInfo preload failed:", e.message);
  }

  setTimeout(() => runScan().catch(console.error), 2000);
  setInterval(() => runScan().catch(console.error), SCAN_MINUTES * 60000);
});
