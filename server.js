/**
 * ROTATION SCREENER — server.js
 * Deploy separately on Railway. Set PORT env var (default 3001).
 * Optional: TG_TOKEN + TG_CHAT for Telegram alerts.
 *
 * Three rotation signals:
 *   1. SECTOR   — coin in sector pumped; find lagging peers in same sector
 *   2. CORR     — historically correlated pair diverged; mean-reversion candidate
 *   3. VOLFLOW  — volume spike on coin X; find sector mates with no vol yet
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_CHAT  = process.env.TG_CHAT  || '';

// ── Sector definitions ────────────────────────────────────────────────────────
// 150+ coins across 16 sectors. More coins = more rotation signals even in
// quiet markets. Every sector has enough members that one will always move.
const SECTORS = {
  'L1_MAJOR':  [
    'BTCUSDT','ETHUSDT','SOLUSDT','AVAXUSDT','DOTUSDT',
    'BNBUSDT','ADAUSDT','TRXUSDT','HBARUSDT','TONUSDT'
  ],
  'L1_ALT':    [
    'NEARUSDT','APTUSDT','SUIUSDT','ALGOUSDT','EGLDUSDT',
    'ICPUSDT','FTMUSDT','ONEUSDT','ZILUSDT','KAVAUSDT',
    'FLOWUSDT','MINAUSDT','XTZUSDT','EOSUSDT','THETAUSDT'
  ],
  'L2':        [
    'MATICUSDT','ARBUSDT','OPUSDT','IMXUSDT','STXUSDT',
    'METISUSDT','SKLUSDT','LRCUSDT','NTRNUSDT','SCROLLUSDT'
  ],
  'DEFI':      [
    'UNIUSDT','AAVEUSDT','CRVUSDT','MKRUSDT','SNXUSDT',
    'COMPUSDT','SUSHIUSDT','DYDXUSDT','GMXUSDT','CAKEUSDT',
    'BALUSDT','YFIUSDT','1INCHUSDT','RUNEUSDT','KNCUSDT'
  ],
  'AI_DATA':   [
    'FETUSDT','GRTUSDT','INJUSDT','WLDUSDT','AGIXUSDT',
    'OCEANUSDT','NMRUSDT','PHAUSDT','RNDRUSDT','TAOУСDT'
  ],
  'GAMING':    [
    'AXSUSDT','SANDUSDT','MANAUSDT','GALAUSDT','GMTUSDT',
    'APEUSDT','ILVUSDT','SLPUSDT','YGGUSDT','MBOXUSDT',
    'ALICEUSDT','TLMUSDT','RAREUSDT'
  ],
  'INFRA':     [
    'LINKUSDT','FILUSDT','LDOUSDT','ENSUSDT','STORJUSDT',
    'SCUSDT','AKROUSDT','NKNUSDT','XVSUSDT','IOTAUSDT'
  ],
  'PAYMENTS':  [
    'XRPUSDT','XLMUSDT','LTCUSDT','VETUSDT','NANOUSDT',
    'ZECUSDT','DASHUSDT','BCHUSDT','DGBUSDT','QNTUSDT'
  ],
  'COSMOS':    [
    'ATOMUSDT','TIAUSDT','RUNEUSDT','INJUSDT',
    'AKTUSDT','OSMOУСDT','EVMOSUSDT','STRDUSDT'
  ],
  'MEME':      [
    'DOGEUSDT','SHIBUSDT','PEPEUSDT','FLOKIUSDT','BONKUSDT',
    'WIFUSDT','MEMEUSDT','TURBOUSDT'
  ],
  'EXCHANGE':  [
    'BNBUSDT','CAKEUSDT','DYDXUSDT','GTUSDT'
  ],
  'PRIVACY':   [
    'XMRUSDT','ZECUSDT','ROSEUSDT','PHAUSDT','SCRTUSDT'
  ],
  'ORACLE':    [
    'LINKUSDT','BANDUSDT','APIUSDT'
  ],
  'NFT':       [
    'ENSUSDT','RAREUSDT','SUPERUSDT','XCNUSDT'
  ],
  'REAL_WORLD':[
    'RLCUSDT','COTIUSDT','ACHUSDT','REQUSDT','POLCUSDT'
  ],
  'BIG_ALTS':  [
    'SOLUSDT','AVAXUSDT','DOTUSDT','NEARUSDT','MATICUSDT',
    'LTCUSDT','LINKUSDT','ATOMUSDT','UNIUSDT','AAVEUSDT',
    'XRPUSDT','ADAUSDT','FILUSDT','ARBUSDT','OPUSDT'
  ],
};

// Build reverse lookup: symbol → sector
const SYMBOL_SECTOR = {};
Object.entries(SECTORS).forEach(([sector, coins]) => {
  coins.forEach(sym => { SYMBOL_SECTOR[sym] = sector; });
});

const ALL_SYMBOLS = [...new Set(Object.values(SECTORS).flat())];

// Correlation pairs — 30 pairs covering all major relationships.
// When the ratio diverges, the laggard is a rotation candidate.
const CORR_PAIRS = [
  // L1 pairs
  ['BTCUSDT',  'ETHUSDT'],
  ['ETHUSDT',  'SOLUSDT'],
  ['SOLUSDT',  'AVAXUSDT'],
  ['AVAXUSDT', 'NEARUSDT'],
  ['DOTUSDT',  'NEARUSDT'],
  ['APTUSDT',  'SUIUSDT'],
  ['FTMUSDT',  'AVAXUSDT'],
  ['ALGOUSDT', 'NEARUSDT'],
  // L2 pairs
  ['ARBUSDT',  'OPUSDT'],
  ['MATICUSDT','ARBUSDT'],
  ['IMXUSDT',  'OPUSDT'],
  // DeFi pairs
  ['UNIUSDT',  'AAVEUSDT'],
  ['CRVUSDT',  'AAVEUSDT'],
  ['GMXUSDT',  'DYDXUSDT'],
  ['MKRUSDT',  'AAVEUSDT'],
  ['SUSHIUSDT','UNIUSDT'],
  // Gaming pairs
  ['SANDUSDT', 'MANAUSDT'],
  ['AXSUSDT',  'GALAUSDT'],
  ['APEUSDT',  'AXSUSDT'],
  ['ILVUSDT',  'AXSUSDT'],
  // Meme pairs
  ['DOGEUSDT', 'SHIBUSDT'],
  ['PEPEUSDT', 'FLOKIUSDT'],
  ['BONKUSDT', 'WIFUSDT'],
  // Payment pairs
  ['XRPUSDT',  'XLMUSDT'],
  ['LTCUSDT',  'BCHUSDT'],
  // AI pairs
  ['FETUSDT',  'AGIXUSDT'],
  ['FETUSDT',  'GRTUSDT'],
  ['RNDRUSDT', 'FETUSDT'],
  // Cosmos pairs
  ['ATOMUSDT', 'TIAUSDT'],
  ['ATOMUSDT', 'AKTUSDT'],
];

// ── In-memory state ───────────────────────────────────────────────────────────
// priceCache[symbol] = { c1h, c4h, c24h, vol1h, vol24h, price, change1h, change4h, change24h, volRatio }
let priceCache    = {};
let rotationCache = { signals: [], ts: null, scanning: false, coinCount: 0 };
let scanInProgress = false;

const ALERT_TTL_MS    = 15 * 60 * 1000;
const alertedSignals  = new Map();

function pruneAlerts() {
  const now = Date.now();
  for (const [k, ts] of alertedSignals) {
    if (now - ts > ALERT_TTL_MS) alertedSignals.delete(k);
  }
}

// ── Telegram ──────────────────────────────────────────────────────────────────
function sendTelegram(msg) {
  if (!TG_TOKEN || !TG_CHAT) return Promise.resolve();
  return new Promise(resolve => {
    const text   = encodeURIComponent(msg);
    const reqUrl = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage?chat_id=${TG_CHAT}&text=${text}&parse_mode=HTML`;
    https.get(reqUrl, res => {
      res.on('data', () => {}); res.on('end', resolve);
    }).on('error', () => resolve());
  });
}

// ── Binance fetch ─────────────────────────────────────────────────────────────
function fetchBinance(reqPath) {
  const endpoints = [
    'data-api.binance.vision',
    'api.binance.com',
    'api1.binance.com',
    'api2.binance.com',
  ];
  function tryEP(i) {
    if (i >= endpoints.length) return Promise.reject(new Error('All endpoints failed'));
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: endpoints[i], path: reqPath, method: 'GET',
        headers: { 'User-Agent': 'RotationScreener/1.0', 'Accept': 'application/json' },
        timeout: 15000,
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (Array.isArray(data) && data.length > 0) resolve(data);
            else tryEP(i + 1).then(resolve).catch(reject);
          } catch { tryEP(i + 1).then(resolve).catch(reject); }
        });
      });
      req.on('timeout', () => { req.destroy(); tryEP(i + 1).then(resolve).catch(reject); });
      req.on('error',   () => tryEP(i + 1).then(resolve).catch(reject));
      req.end();
    });
  }
  return tryEP(0);
}

async function fetchKlines(symbol, interval, limit = 50) {
  const raw = await fetchBinance(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return raw.map(k => ({
    time:   parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ── Sub-narrative tags ────────────────────────────────────────────────────────
// Coins that share a sub-narrative get a bonus when one pumps.
// e.g. NTRN pumps → ATOM/TIA/OSMO are closer than MATIC/ARB.
const SUB_NARRATIVE = {
  // Cosmos ecosystem
  COSMOS_ECO: ['ATOMUSDT','TIAUSDT','INJUSDT','AKTUSDT','OSMOУСDT','STRDUSDT','NTRNUSDT','EVMOSUSDT'],
  // Ethereum L2
  ETH_L2:     ['MATICUSDT','ARBUSDT','OPUSDT','METISUSDT','SKLUSDT','LRCUSDT','IMXUSDT','SCROLLUSDT'],
  // Bitcoin L2 / BTC ecosystem
  BTC_ECO:    ['STXUSDT','LDOUSDT','NTRNUSDT'],
  // Solana ecosystem
  SOL_ECO:    ['SOLUSDT','RAYUSDT','ORCAUSDT','BONKUSDT','WIFUSDT'],
  // AI / compute
  AI_COMPUTE: ['FETUSDT','AGIXUSDT','RNDRUSDT','OCEANUSDT','WLDUSDT','GRTUSDT','NMRUSDT'],
  // GameFi play-to-earn
  GAMEFI:     ['AXSUSDT','ILVUSDT','SLPUSDT','YGGUSDT','GALAUSDT','MBOXUSDT','ALICEUSDT'],
  // Metaverse / virtual worlds
  METAVERSE:  ['SANDUSDT','MANAUSDT','APEUSDT','GMTUSDT'],
  // DEX / AMM
  DEX:        ['UNIUSDT','SUSHIUSDT','CRVUSDT','BALUSDT','1INCHUSDT','CAKEUSDT'],
  // Lending / money markets
  LENDING:    ['AAVEUSDT','COMPUSDT','MKRUSDT','SNXUSDT','KNCUSDT'],
  // Perps / derivatives
  PERPS:      ['DYDXUSDT','GMXUSDT','SNXUSDT','PERPUSDT'],
  // Meme OG
  MEME_OG:    ['DOGEUSDT','SHIBUSDT'],
  // Meme new wave
  MEME_NEW:   ['PEPEUSDT','FLOKIUSDT','BONKUSDT','WIFUSDT','MEMEUSDT','TURBOUSDT'],
  // Payment / remittance
  REMITTANCE: ['XRPUSDT','XLMUSDT','NANOUSDT','QNTUSDT'],
  // Privacy
  PRIVACY:    ['XMRUSDT','ZECUSDT','DASHUSDT','ROSEUSDT'],
  // PoW legacy
  POW:        ['LTCUSDT','BCHUSDT','DASHUSDT','ZECUSDT','DGBUSDT'],
  // Oracle
  ORACLE:     ['LINKUSDT','BANDUSDT'],
  // Storage / data
  STORAGE:    ['FILUSDT','STORJUSDT','SCUSDT','OCEANUSDT'],
};

// Build reverse lookup: symbol → [sub-narratives]
const SYM_NARRATIVES = {};
Object.entries(SUB_NARRATIVE).forEach(([nar, coins]) => {
  coins.forEach(sym => {
    if (!SYM_NARRATIVES[sym]) SYM_NARRATIVES[sym] = [];
    SYM_NARRATIVES[sym].push(nar);
  });
});

// Shared narrative count between two symbols
function sharedNarratives(symA, symB) {
  const a = SYM_NARRATIVES[symA] || [];
  const b = SYM_NARRATIVES[symB] || [];
  return a.filter(n => b.includes(n)).length;
}

// ── Market cap tiers ──────────────────────────────────────────────────────────
// Rough tiers based on typical market cap. Money from small cap tends to
// rotate to small/mid cap first, not straight to mega cap.
// 1=mega  2=large  3=mid  4=small  5=micro
const CAP_TIER = {
  BTCUSDT:1, ETHUSDT:1, BNBUSDT:1, SOLUSDT:1, XRPUSDT:1,
  ADAUSDT:2, AVAXUSDT:2, DOGEUSDT:2, DOTUSDT:2, TRXUSDT:2,
  TONUSDT:2, MATICUSDT:2, LTCUSDT:2, LINKUSDT:2, UNIUSDT:2,
  NEARUSDT:3, APTUSDT:3, ARBUSDT:3, OPUSDT:3, ATOMUSDT:3,
  HBARUSDT:3, ICPUSDT:3, FILUSDT:3, INJUSDT:3, IMXUSDT:3,
  AAVEUSDT:3, TIAUSDT:3, RUNEUSDT:3, SUIUSDT:3, WLDUSDT:3,
  FTMUSDT:3, ALGOUSDT:3, EGLDUSDT:3, FLOWUSDT:3, KAVAUSDT:3,
  FETUSDT:4, GRTUSDT:4, SUSHIUSDT:4, DYDXUSDT:4, GMXUSDT:4,
  CRVUSDT:4, MKRUSDT:4, CAKEUSDT:4, SANDUSDT:4, MANAUSDT:4,
  AXSUSDT:4, SNXUSDT:4, COMPUSDT:4, LDOUSDT:4, ENSUSDT:4,
  STXUSDT:4, GALAUSDT:4, APEUSDT:4, GMTUSDT:4, AGIXUSDT:4,
  RNDRUSDT:4, YFIUSDT:4, BALUSDT:4, NTRNUSDT:5, SKLUSDT:5,
  METISUSDT:5, LRCUSDT:5, AKTUSDT:5, ILVUSDT:5, SLPUSDT:5,
  YGGUSDT:5, MBOXUSDT:5, ALICEUSDT:5, TLMUSDT:5, RAREUSDT:5,
  STORJUSDT:5, SCUSDT:5, AKROUSDT:5, NKNUSDT:5, IOTAUSDT:5,
  NANOUSDT:5, DGBUSDT:5, DCRUSDT:4, QNTUSDT:4, ZILUSDT:5,
  ONEUSDT:5, MINAUSDT:4, XTZUSDT:4, EOSUSDT:4, THETAUSDT:4,
  XMRUSDT:3, ZECUSDT:4, DASHUSDT:4, BCHUSDT:3, XLMUSDT:3,
  VETUSDT:4, SHIBUSDT:3, PEPEUSDT:3, FLOKIUSDT:4, BONKUSDT:4,
  WIFUSDT:4, MEMEUSDT:5, TURBOUSDT:5, OCEANUSDT:4, NMRUSDT:5,
  PHAUSDT:5, COTIUSDT:5, ACHUSDT:5, REQUSDT:5, RLCUSDT:5,
  BANDUSDT:4, KNCUSDT:4, XVSUSDT:5, EVMOSUSDT:5, STRDUSDT:5,
  SUPERUSDT:5, XCNUSDT:5, SCROLLUSDT:5,
};

function capTier(sym) { return CAP_TIER[sym] || 3; }

// Cap tier similarity score: same tier=100, 1 apart=60, 2 apart=20, 3+=0
function capTierScore(symA, symB) {
  const diff = Math.abs(capTier(symA) - capTier(symB));
  return [100, 60, 20, 0, 0][diff] || 0;
}

// ── Volume Profile (VP) calculation ──────────────────────────────────────────
// Calculates VAH, POC, VAL from 1h candles (same algorithm as VP screener).
// This is the key bridge between the two tools.
const VP_BINS = 36;

function calcVP(candles) {
  if (!candles || candles.length < 10) return null;
  let lo = Infinity, hi = -Infinity;
  candles.forEach(c => {
    if (c.high  > hi) hi = c.high;
    if (c.low   < lo) lo = c.low;
  });
  const range = hi - lo;
  if (range === 0) return null;

  const binSize = range / VP_BINS;
  const vol     = new Array(VP_BINS).fill(0);
  candles.forEach(c => {
    const typical = (c.high + c.low + c.close) / 3;
    const idx = Math.min(Math.floor((typical - lo) / binSize), VP_BINS - 1);
    vol[idx] += c.volume;
  });

  let pocIdx = 0;
  vol.forEach((v, i) => { if (v > vol[pocIdx]) pocIdx = i; });
  const poc = lo + (pocIdx + 0.5) * binSize;

  const totalVol = vol.reduce((a, b) => a + b, 0);
  const target   = totalVol * 0.70;
  let vaVol = vol[pocIdx], vaLo = pocIdx, vaHi = pocIdx;
  while (vaVol < target) {
    const nextLo = vaLo > 0         ? vol[vaLo - 1] : 0;
    const nextHi = vaHi < VP_BINS-1 ? vol[vaHi + 1] : 0;
    if (nextLo >= nextHi && vaLo > 0) { vaLo--; vaVol += nextLo; }
    else if (vaHi < VP_BINS - 1)      { vaHi++; vaVol += nextHi; }
    else break;
  }
  return {
    poc,
    vah: lo + (vaHi + 1) * binSize,
    val: lo + vaLo * binSize,
  };
}

// VP proximity score:
// price at/near VAL  → BEST  (100) — sitting at support, ready to bounce
// price near POC     → GOOD  (65)  — at equilibrium
// price near VAH     → OK    (40)  — near resistance
// price far from all → POOR  (15)
// price below VAL    → BAD   (5)   — broken structure, avoid
function vpProximityScore(price, vp) {
  if (!vp) return 30; // no data, neutral
  const distVAL = Math.abs(price - vp.val) / vp.val * 100; // % away from VAL
  const distPOC = Math.abs(price - vp.poc) / vp.poc * 100;
  const distVAH = Math.abs(price - vp.vah) / vp.vah * 100;

  // Below VAL = broken structure
  if (price < vp.val * 0.98) return 5;

  // At VAL (within 0.8%) = best rotation entry
  if (distVAL <= 0.8) return 100;
  if (distVAL <= 2.0) return 85;

  // At POC
  if (distPOC <= 0.8) return 65;
  if (distPOC <= 2.0) return 50;

  // At VAH — near resistance, not ideal entry
  if (distVAH <= 1.0) return 40;

  // Inside value area but not near a level
  if (price >= vp.val && price <= vp.vah) return 35;

  return 15;
}

// VP level label for display
function vpLevelLabel(price, vp) {
  if (!vp) return '—';
  const distVAL = Math.abs(price - vp.val) / vp.val * 100;
  const distPOC = Math.abs(price - vp.poc) / vp.poc * 100;
  const distVAH = Math.abs(price - vp.vah) / vp.vah * 100;
  if (price < vp.val * 0.98)  return 'BELOW VAL ⚠';
  if (distVAL <= 2.0) return `AT VAL 🎯`;
  if (distPOC <= 2.0) return `AT POC ◆`;
  if (distVAH <= 1.5) return `AT VAH 🔴`;
  if (price >= vp.val && price <= vp.vah) return 'IN VALUE';
  return 'ABOVE VAH';
}

// ── Momentum state ────────────────────────────────────────────────────────────
// A coin that has been FLAT for 3 days and now has some 1h action is better
// than one that already ran 20% — it has more "stored energy".
// Returns score 0-100. Higher = more flat/coiled = better rotation candidate.
function momentumStateScore(change1h, change4h, change24h) {
  // Already ran hard on 24h → lower score (less upside remaining)
  const ran24h = Math.abs(change24h);
  const ran4h  = Math.abs(change4h);

  let score = 70; // base

  // Big 24h move already happened → penalise
  if (ran24h > 15) score -= 40;
  else if (ran24h > 8) score -= 20;
  else if (ran24h > 4) score -= 8;
  else score += 15; // very flat 24h = stored energy

  // 4h flat but 1h starting to move = ideal
  if (ran4h < 1.5 && Math.abs(change1h) > 0.2) score += 15;

  // Already dumping on 4h = avoid
  if (change4h < -4) score -= 25;

  return Math.min(100, Math.max(0, score));
}

// ── THE MASTER SCORING ENGINE ─────────────────────────────────────────────────
// Combines all 6 factors into one 0-100 score.
//
// Factor                    Weight   What it measures
// ─────────────────────────────────────────────────────
// 1. Sub-narrative match      25%    Same ecosystem/use-case as leader
// 2. Cap tier similarity      20%    Money stays in same size bracket
// 3. Momentum state           20%    How coiled/flat the coin is
// 4. Volume dryness           15%    No volume yet = dry powder
// 5. VP proximity             12%    Price near VAL/POC = structural support
// 6. 4H trend not broken       8%    Not in active downtrend
//
function scoreCandidate(sym, leader, m, vp) {
  // Factor 1: Sub-narrative (0-100)
  const narCount  = sharedNarratives(sym, leader);
  const narScore  = narCount >= 2 ? 100 : narCount === 1 ? 65 : 20;

  // Factor 2: Cap tier similarity (0-100)
  const capScore  = capTierScore(sym, leader);

  // Factor 3: Momentum state (0-100)
  const momScore  = momentumStateScore(m.change1h, m.change4h, m.change24h);

  // Factor 4: Volume dryness (0-100)
  const volScore  = m.volRatio < 0.8  ? 100  // very quiet
                  : m.volRatio < 1.2  ? 80
                  : m.volRatio < 1.8  ? 45
                  : m.volRatio < 2.5  ? 20
                  : 5;                        // already spiked

  // Factor 5: VP proximity (0-100)
  const vpScore   = vpProximityScore(m.price, vp);

  // Factor 6: 4H trend health (0-100)
  const trendScore = m.change4h > 1   ? 100  // rising
                   : m.change4h > 0   ? 80
                   : m.change4h > -2  ? 55
                   : m.change4h > -5  ? 25
                   : 0;                       // strong downtrend

  // Weighted composite
  const composite = (
    narScore   * 0.25 +
    capScore   * 0.20 +
    momScore   * 0.20 +
    volScore   * 0.15 +
    vpScore    * 0.12 +
    trendScore * 0.08
  );

  return {
    score:       Math.round(composite),
    scoreBreakdown: {
      narrative:  Math.round(narScore),
      capTier:    Math.round(capScore),
      momentum:   Math.round(momScore),
      volDry:     Math.round(volScore),
      vpLevel:    Math.round(vpScore),
      trend:      Math.round(trendScore),
    },
    vpLabel: vp ? vpLevelLabel(m.price, vp) : '—',
    vp,
    narCount,
    capTierVal: capTier(sym),
  };
}

// ── Coin metric calculation ────────────────────────────────────────────────────
function calcMetrics(candles1h, candles4h, candles1d) {
  const last = candles1h[candles1h.length - 1];

  const open1h    = candles1h[candles1h.length - 2]?.close || candles1h[0].open;
  const change1h  = ((last.close - open1h) / open1h) * 100;

  const first4h   = candles4h[candles4h.length - 2]?.close || candles4h[0].open;
  const change4h  = ((last.close - first4h) / first4h) * 100;

  const first24h  = candles1d[candles1d.length - 2]?.close || candles1d[0].open;
  const change24h = ((last.close - first24h) / first24h) * 100;

  const recentVols = candles1h.slice(-21, -1).map(c => c.volume);
  const avgVol     = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const volRatio   = avgVol > 0 ? last.volume / avgVol : 1;
  const vol24h     = candles1h.slice(-24).reduce((a, c) => a + c.volume, 0);

  // VP uses the last 48 1h candles for a richer picture
  const vp = calcVP(candles1h);

  return {
    price: last.close,
    change1h, change4h, change24h,
    volRatio, vol24h,
    lastVol: last.volume,
    vp,  // ← VP levels stored on every coin
  };
}

// ── Signal generation ─────────────────────────────────────────────────────────

/**
 * SECTOR rotation: coin A pumped > threshold in 1h
 * → find sector peers that are lagging
 * → rank by 6-factor score (not just lag magnitude)
 */
function detectSectorRotation(metrics) {
  const signals = [];
  const PUMP_THRESHOLD = 0.4;

  Object.entries(SECTORS).forEach(([sector, coins]) => {
    const pumped = coins
      .filter(sym => metrics[sym] && metrics[sym].change1h >= PUMP_THRESHOLD)
      .sort((a, b) => metrics[b].change1h - metrics[a].change1h);

    if (pumped.length === 0) return;

    const leader     = pumped[0];
    const leaderGain = metrics[leader].change1h;

    coins.forEach(sym => {
      if (!metrics[sym] || sym === leader) return;
      if (metrics[sym].change1h > leaderGain * 0.7) return; // already moved

      const m   = metrics[sym];
      const lag = leaderGain - m.change1h;
      const { score, scoreBreakdown, vpLabel, vp, narCount, capTierVal } = scoreCandidate(sym, leader, m, m.vp);

      const narLabel = narCount >= 2 ? '🔥 SAME ECOSYSTEM'
                     : narCount === 1 ? '✓ RELATED'
                     : '○ BROAD SECTOR';

      signals.push({
        type:        'SECTOR',
        symbol:      sym,
        sector,
        leader,
        leaderGain:  parseFloat(leaderGain.toFixed(2)),
        ownChange1h: parseFloat(m.change1h.toFixed(2)),
        ownChange4h: parseFloat(m.change4h.toFixed(2)),
        change24h:   parseFloat(m.change24h.toFixed(2)),
        lag:         parseFloat(lag.toFixed(2)),
        price:       m.price,
        volRatio:    parseFloat(m.volRatio.toFixed(2)),
        volDry:      m.volRatio < 1.2,
        score,
        scoreBreakdown,
        vpLabel,
        vp,
        narLabel,
        narCount,
        capTierVal,
        narrative: `${leader.replace('USDT','')} +${leaderGain.toFixed(1)}% · ${sym.replace('USDT','')} lags ${lag.toFixed(1)}% · ${narLabel} · VP: ${vpLabel}`,
      });
    });
  });

  return signals;
}

/**
 * CORRELATION divergence: correlated pair spread opens up.
 * Laggard scored by 6-factor engine.
 */
function detectCorrelationDivergence(metrics) {
  const signals = [];

  CORR_PAIRS.forEach(([symA, symB]) => {
    const mA = metrics[symA];
    const mB = metrics[symB];
    if (!mA || !mB) return;

    const diff    = mA.change1h - mB.change1h;
    const absDiff = Math.abs(diff);
    if (absDiff < 0.3) return;

    const laggard  = diff > 0 ? symB : symA;
    const leader   = diff > 0 ? symA : symB;
    const mL       = metrics[laggard];
    const mLeader  = metrics[leader];

    if (mL.change4h < -8) return;

    const { score, scoreBreakdown, vpLabel, vp, narCount, capTierVal } = scoreCandidate(laggard, leader, mL, mL.vp);

    signals.push({
      type:        'CORR',
      symbol:      laggard,
      sector:      SYMBOL_SECTOR[laggard] || '—',
      leader,
      leaderGain:  parseFloat(mLeader.change1h.toFixed(2)),
      ownChange1h: parseFloat(mL.change1h.toFixed(2)),
      ownChange4h: parseFloat(mL.change4h.toFixed(2)),
      change24h:   parseFloat(mL.change24h.toFixed(2)),
      lag:         parseFloat(absDiff.toFixed(2)),
      price:       mL.price,
      volRatio:    parseFloat(mL.volRatio.toFixed(2)),
      volDry:      mL.volRatio < 1.2,
      score,
      scoreBreakdown,
      vpLabel,
      vp,
      narCount,
      capTierVal,
      narrative: `${leader.replace('USDT','')} +${mLeader.change1h.toFixed(1)}% · correlated ${laggard.replace('USDT','')} only ${mL.change1h.toFixed(1)}% · VP: ${vpLabel}`,
    });
  });

  return signals;
}

/**
 * VOLUME FLOW: sector peer absorbed volume spike.
 * Quiet coins in same sector scored by 6-factor engine.
 */
function detectVolumeFlow(metrics) {
  const signals = [];
  const VOL_SPIKE = 1.3;

  Object.entries(SECTORS).forEach(([sector, coins]) => {
    const volLeaders = coins
      .filter(sym => metrics[sym] && metrics[sym].volRatio >= VOL_SPIKE && metrics[sym].change1h > -1)
      .sort((a, b) => metrics[b].volRatio - metrics[a].volRatio);

    if (volLeaders.length === 0) return;
    const leader  = volLeaders[0];
    const mLeader = metrics[leader];

    coins.forEach(sym => {
      if (!metrics[sym] || sym === leader) return;
      const m = metrics[sym];
      if (m.volRatio > mLeader.volRatio * 0.8) return;
      if (m.change1h < -5) return;

      const { score, scoreBreakdown, vpLabel, vp, narCount, capTierVal } = scoreCandidate(sym, leader, m, m.vp);

      signals.push({
        type:        'VOLFLOW',
        symbol:      sym,
        sector,
        leader,
        leaderGain:  parseFloat(mLeader.change1h.toFixed(2)),
        leaderVol:   parseFloat(mLeader.volRatio.toFixed(2)),
        ownChange1h: parseFloat(m.change1h.toFixed(2)),
        ownChange4h: parseFloat(m.change4h.toFixed(2)),
        change24h:   parseFloat(m.change24h.toFixed(2)),
        lag:         parseFloat((mLeader.change1h - m.change1h).toFixed(2)),
        price:       m.price,
        volRatio:    parseFloat(m.volRatio.toFixed(2)),
        volDry:      m.volRatio < 1.2,
        score,
        scoreBreakdown,
        vpLabel,
        vp,
        narCount,
        capTierVal,
        narrative: `${leader.replace('USDT','')} vol ${mLeader.volRatio.toFixed(1)}x · ${sym.replace('USDT','')} quiet · VP: ${vpLabel}`,
      });
    });
  });

  return signals;
}

// ── Alert dedup ───────────────────────────────────────────────────────────────
function alertSignal(sig) {
  pruneAlerts();
  const key = `${sig.type}-${sig.symbol}-${sig.leader}`;
  if (alertedSignals.has(key)) return;
  alertedSignals.set(key, Date.now());

  const typeEmoji = { SECTOR: '🔄', CORR: '⚖️', VOLFLOW: '💰' }[sig.type] || '📊';
  const typeLabel = { SECTOR: 'SECTOR ROTATION', CORR: 'CORR DIVERGENCE', VOLFLOW: 'VOL FLOW' }[sig.type] || sig.type;
  const sb = sig.scoreBreakdown || {};

  const msg = [
    `${typeEmoji} <b>${typeLabel}</b>`,
    ``,
    `🎯 <b>${sig.symbol.replace('USDT','')}</b> ← lagging <b>${sig.leader.replace('USDT','')}</b>`,
    `💹 Leader +${sig.leaderGain}% | Own ${sig.ownChange1h > 0 ? '+' : ''}${sig.ownChange1h}%`,
    `📊 Lag: ${sig.lag}% | Vol: ${sig.volRatio}x`,
    `📍 VP Level: ${sig.vpLabel || '—'}`,
    `🏷 Sector: ${sig.sector}`,
    ``,
    `📐 Score Breakdown:`,
    `  Narrative: ${sb.narrative||'—'}%  Cap: ${sb.capTier||'—'}%`,
    `  Momentum:  ${sb.momentum||'—'}%  Vol: ${sb.volDry||'—'}%`,
    `  VP Level:  ${sb.vpLevel||'—'}%   Trend: ${sb.trend||'—'}%`,
    `💪 TOTAL: <b>${sig.score}%</b>`,
  ].join('\n');

  sendTelegram(msg).catch(console.error);
}

// ── Background scan ───────────────────────────────────────────────────────────
async function runScan() {
  if (scanInProgress) { console.log('[SCAN] Already running'); return; }
  scanInProgress = true;
  rotationCache.scanning = true;
  console.log(`[SCAN START] ${ALL_SYMBOLS.length} symbols`);

  const newMetrics = {};
  const CONCURRENCY = 4;

  for (let i = 0; i < ALL_SYMBOLS.length; i += CONCURRENCY) {
    const batch = ALL_SYMBOLS.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(async sym => {
      try {
        const [c1h, c4h, c1d] = await Promise.all([
          fetchKlines(sym, '1h', 50),  // 50 candles for VP calculation
          fetchKlines(sym, '4h', 10),
          fetchKlines(sym, '1d', 5),
        ]);
        newMetrics[sym] = calcMetrics(c1h, c4h, c1d);
      } catch (e) {
        console.log(`[WARN] ${sym}: ${e.message}`);
      }
    }));
    await new Promise(r => setTimeout(r, 400));
  }

  priceCache = newMetrics;

  // Generate all three signal types
  const sectorSigs = detectSectorRotation(newMetrics);
  const corrSigs   = detectCorrelationDivergence(newMetrics);
  const volSigs    = detectVolumeFlow(newMetrics);
  const all        = [...sectorSigs, ...corrSigs, ...volSigs]
    .sort((a, b) => b.score - a.score);

  // Dedup: if same symbol appears multiple times, keep highest score per type
  const seen = new Map();
  const deduped = [];
  for (const s of all) {
    const key = `${s.type}-${s.symbol}`;
    if (!seen.has(key)) { seen.set(key, true); deduped.push(s); }
  }

  // Alert top signals
  deduped.slice(0, 10).forEach(s => alertSignal(s));

  rotationCache = {
    signals:   deduped,
    metrics:   newMetrics,
    ts:        new Date().toISOString(),
    scanning:  false,
    coinCount: Object.keys(newMetrics).length,
  };
  scanInProgress = false;

  console.log(`[SCAN DONE] ${deduped.length} signals (sector:${sectorSigs.length} corr:${corrSigs.length} vol:${volSigs.length})`);

  sendTelegram([
    `🔄 <b>Rotation Scan Complete</b>`,
    `${Object.keys(newMetrics).length} coins · ${deduped.length} signals`,
    `🔄 Sector: ${sectorSigs.length} | ⚖️ Corr: ${corrSigs.length} | 💰 VolFlow: ${volSigs.length}`,
  ].join('\n')).catch(() => {});
}

// ── CORS + rate limit ─────────────────────────────────────────────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

const ipMap = new Map();
function isRateLimited(ip, limit = 30) {
  const now = Date.now();
  const e   = ipMap.get(ip) || { count: 0, reset: now + 60000 };
  if (now > e.reset) { e.count = 0; e.reset = now + 60000; }
  e.count++;
  ipMap.set(ip, e);
  return e.count > limit;
}
setInterval(() => { const now = Date.now(); for (const [ip, e] of ipMap) if (now > e.reset) ipMap.delete(ip); }, 5 * 60 * 1000);

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'rotation.html');
    if (!fs.existsSync(htmlPath)) { res.writeHead(404); return res.end('rotation.html not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(htmlPath));
  }

  // Current rotation signals + metrics
  if (pathname === '/api/rotation') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok:        true,
      signals:   rotationCache.signals   || [],
      metrics:   rotationCache.metrics   || {},
      ts:        rotationCache.ts        || new Date().toISOString(),
      scanning:  rotationCache.scanning  || false,
      coinCount: rotationCache.coinCount || 0,
    }));
  }

  // Trigger fresh scan
  if (pathname === '/api/trigger-scan') {
    if (isRateLimited(clientIP, 5)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, message: 'Too many requests' }));
    }
    if (scanInProgress) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, message: 'Already scanning' }));
    }
    runScan().catch(console.error);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, message: 'Scan started' }));
  }

  // Sector heat map data
  if (pathname === '/api/sectors') {
    // Aggregate metrics per sector
    const sectorSummary = {};
    Object.entries(SECTORS).forEach(([sector, coins]) => {
      const coinData = coins
        .filter(sym => rotationCache.metrics && rotationCache.metrics[sym])
        .map(sym => ({ sym, ...rotationCache.metrics[sym] }));
      if (coinData.length === 0) return;
      const avgChange1h = coinData.reduce((a, c) => a + c.change1h, 0) / coinData.length;
      const avgChange4h = coinData.reduce((a, c) => a + c.change4h, 0) / coinData.length;
      const maxVolRatio = Math.max(...coinData.map(c => c.volRatio));
      const leader      = coinData.sort((a, b) => b.change1h - a.change1h)[0];
      sectorSummary[sector] = { avgChange1h, avgChange4h, maxVolRatio, leader: leader.sym, coins: coinData.length };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, sectors: sectorSummary }));
  }

  if (pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, coinCount: rotationCache.coinCount, ts: rotationCache.ts, scanning: scanInProgress }));
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`ROTATION SCREENER on ${HOST}:${PORT}`);
  if (!TG_TOKEN) console.warn('[WARN] TG_TOKEN not set');
  sendTelegram('🟢 <b>ROTATION SCREENER ONLINE</b>').catch(() => {});
  setTimeout(() => runScan().catch(console.error), 3000);
  setInterval(() => runScan().catch(console.error), 10 * 60 * 1000); // every 10 min
});
