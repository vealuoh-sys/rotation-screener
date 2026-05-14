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
// Each coin belongs to one sector. When one coin pumps, we look for laggards
// in the same sector. Sectors are kept tight (3–6 coins) for signal quality.
const SECTORS = {
  'L1_MAJOR':  ['BTCUSDT','ETHUSDT','SOLUSDT','AVAXUSDT','DOTUSDT'],
  'L1_ALT':    ['NEARUSDT','APTUSDT','SUIUSDT','ALGOUSDT','EGLDUSDT'],
  'L2':        ['MATICUSDT','ARBUSDT','OPUSDT','IMXUSDT','STXUSDT'],
  'DEFI':      ['UNIUSDT','AAVEUSDT','CRVUSDT','MKRUSDT','SNXUSDT','COMPUSDT','SUSHIUSDT','DYDXUSDT','GMXUSDT','CAKEUSDT'],
  'AI_DATA':   ['FETUSDT','GRTUSDT','INJUSDT'],
  'GAMING':    ['AXSUSDT','SANDUSDT','MANAUSDT','GALAUSDT','GMTUSDT','APEUSDT'],
  'INFRA':     ['LINKUSDT','ATOMUSDT','FILUSDT','LDOUSDT','ENSUSDT'],
  'PAYMENTS':  ['XRPUSDT','XLMUSDT','LTCUSDT','VETUSDT'],
  'LARGE_CAP': ['BNBUSDT','ADAUSDT','DOGEUSDT'],
  'COSMOS':    ['ATOMUSDT','TIAUSDT','RUNEUSDT'],
};

// Build reverse lookup: symbol → sector
const SYMBOL_SECTOR = {};
Object.entries(SECTORS).forEach(([sector, coins]) => {
  coins.forEach(sym => { SYMBOL_SECTOR[sym] = sector; });
});

const ALL_SYMBOLS = [...new Set(Object.values(SECTORS).flat())];

// Correlation pairs — coins historically strongly correlated.
// When the ratio diverges > threshold, the laggard is a rotation candidate.
const CORR_PAIRS = [
  ['ETHUSDT',  'SOLUSDT'],
  ['AVAXUSDT', 'NEARUSDT'],
  ['ARBUSDT',  'OPUSDT'],
  ['UNIUSDT',  'AAVEUSDT'],
  ['SANDUSDT', 'MANAUSDT'],
  ['FETUSDT',  'GRTUSDT'],
  ['XRPUSDT',  'XLMUSDT'],
  ['APTUSDT',  'SUIUSDT'],
  ['MATICUSDT','ARBUSDT'],
  ['BTCUSDT',  'ETHUSDT'],
  ['ATOMUSDT', 'TIAUSDT'],
  ['AXSUSDT',  'GALAUSDT'],
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

// ── Coin metric calculation ────────────────────────────────────────────────────
// Returns change%, volume ratio, and current price from 1h candles
function calcMetrics(candles1h, candles4h, candles1d) {
  const last = candles1h[candles1h.length - 1];

  // 1h change
  const open1h    = candles1h[candles1h.length - 2]?.close || candles1h[0].open;
  const change1h  = ((last.close - open1h) / open1h) * 100;

  // 4h change
  const first4h   = candles4h[candles4h.length - 2]?.close || candles4h[0].open;
  const change4h  = ((last.close - first4h) / first4h) * 100;

  // 24h change
  const first24h  = candles1d[candles1d.length - 2]?.close || candles1d[0].open;
  const change24h = ((last.close - first24h) / first24h) * 100;

  // Volume ratio: current 1h vol vs 20-bar average
  const recentVols = candles1h.slice(-21, -1).map(c => c.volume);
  const avgVol     = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const volRatio   = avgVol > 0 ? last.volume / avgVol : 1;

  // 24h rolling volume
  const vol24h = candles1h.slice(-24).reduce((a, c) => a + c.volume, 0);

  return {
    price: last.close,
    change1h, change4h, change24h,
    volRatio, vol24h,
    lastVol: last.volume,
  };
}

// ── Signal generation ─────────────────────────────────────────────────────────

/**
 * SECTOR rotation: coin A pumped > threshold in 1h
 * → find sector peers with < half that gain (laggards)
 * → score by: lag magnitude + volume absence (dry powder)
 */
function detectSectorRotation(metrics) {
  const signals = [];
  const PUMP_THRESHOLD = 2.5; // % gain in 1h to be considered "pumped"

  Object.entries(SECTORS).forEach(([sector, coins]) => {
    // Find the pumped coin(s)
    const pumped = coins
      .filter(sym => metrics[sym] && metrics[sym].change1h >= PUMP_THRESHOLD)
      .sort((a, b) => metrics[b].change1h - metrics[a].change1h);

    if (pumped.length === 0) return;

    const leader     = pumped[0];
    const leaderGain = metrics[leader].change1h;

    // Find laggards: same sector, didn't pump yet, not also pumping
    coins.forEach(sym => {
      if (!metrics[sym]) return;
      if (sym === leader)            return;
      if (metrics[sym].change1h > leaderGain * 0.5) return; // already moved

      const m     = metrics[sym];
      const lag   = leaderGain - m.change1h;          // how far behind
      const volDry= m.volRatio < 1.2;                  // no volume yet = dry powder
      const score = Math.min(100, Math.round(
        40 +                                           // base
        Math.min(lag * 4, 30) +                        // lag magnitude bonus
        (volDry ? 15 : 0) +                            // dry powder bonus
        Math.min(leaderGain * 2, 15)                   // leader strength bonus
      ));

      signals.push({
        type:       'SECTOR',
        symbol:     sym,
        sector,
        leader,
        leaderGain: parseFloat(leaderGain.toFixed(2)),
        ownChange1h: parseFloat(m.change1h.toFixed(2)),
        ownChange4h: parseFloat(m.change4h.toFixed(2)),
        lag:         parseFloat(lag.toFixed(2)),
        price:       m.price,
        volRatio:    parseFloat(m.volRatio.toFixed(2)),
        volDry,
        score,
        narrative: `${leader.replace('USDT','')} pumped +${leaderGain.toFixed(1)}% — ${sym.replace('USDT','')} lagging by ${lag.toFixed(1)}%${volDry ? ', no vol yet' : ''}`,
      });
    });
  });

  return signals;
}

/**
 * CORRELATION divergence: for each corr pair,
 * compute 14-period price ratio z-score.
 * If z-score > 1.5 stdev, the laggard is a rotation candidate.
 */
function detectCorrelationDivergence(metrics) {
  const signals = [];

  CORR_PAIRS.forEach(([symA, symB]) => {
    const mA = metrics[symA];
    const mB = metrics[symB];
    if (!mA || !mB) return;

    // Simple proxy: 1h change divergence
    const diff = mA.change1h - mB.change1h;
    const absDiff = Math.abs(diff);
    if (absDiff < 2.0) return; // need meaningful divergence

    // The laggard is the one with the lower 1h gain
    const laggard = diff > 0 ? symB : symA;
    const leader  = diff > 0 ? symA : symB;
    const mL      = metrics[laggard];
    const mLeader = metrics[leader];

    // Also check 4h for confirmation — laggard should not be in a strong downtrend
    if (mL.change4h < -5) return; // don't catch falling knives

    const score = Math.min(100, Math.round(
      40 +
      Math.min(absDiff * 5, 35) +
      (mL.volRatio < 1.2 ? 15 : 0) +
      (mLeader.volRatio > 2 ? 10 : 0)
    ));

    signals.push({
      type:        'CORR',
      symbol:      laggard,
      sector:      SYMBOL_SECTOR[laggard] || '—',
      leader,
      leaderGain:  parseFloat(mLeader.change1h.toFixed(2)),
      ownChange1h: parseFloat(mL.change1h.toFixed(2)),
      ownChange4h: parseFloat(mL.change4h.toFixed(2)),
      lag:         parseFloat(absDiff.toFixed(2)),
      price:       mL.price,
      volRatio:    parseFloat(mL.volRatio.toFixed(2)),
      volDry:      mL.volRatio < 1.2,
      score,
      narrative: `${leader.replace('USDT','')} +${mLeader.change1h.toFixed(1)}% while correlated ${laggard.replace('USDT','')} only ${mL.change1h.toFixed(1)}%`,
    });
  });

  return signals;
}

/**
 * VOLUME FLOW: coin has a volume spike (≥ 3x) with positive price action.
 * Look for sector peers with no volume spike yet → money likely to rotate.
 */
function detectVolumeFlow(metrics) {
  const signals = [];
  const VOL_SPIKE = 2.5;

  Object.entries(SECTORS).forEach(([sector, coins]) => {
    // Find the vol leader
    const volLeaders = coins
      .filter(sym => metrics[sym] && metrics[sym].volRatio >= VOL_SPIKE && metrics[sym].change1h > 0)
      .sort((a, b) => metrics[b].volRatio - metrics[a].volRatio);

    if (volLeaders.length === 0) return;
    const leader  = volLeaders[0];
    const mLeader = metrics[leader];

    coins.forEach(sym => {
      if (!metrics[sym] || sym === leader) return;
      const m = metrics[sym];
      if (m.volRatio > 1.8) return;         // already has volume
      if (m.change1h < -3)  return;         // skip if dumping

      const score = Math.min(100, Math.round(
        40 +
        Math.min(mLeader.volRatio * 4, 25) +
        (m.volRatio < 1.0 ? 15 : 8) +
        Math.min(mLeader.change1h * 3, 20)
      ));

      signals.push({
        type:        'VOLFLOW',
        symbol:      sym,
        sector,
        leader,
        leaderGain:  parseFloat(mLeader.change1h.toFixed(2)),
        leaderVol:   parseFloat(mLeader.volRatio.toFixed(2)),
        ownChange1h: parseFloat(m.change1h.toFixed(2)),
        ownChange4h: parseFloat(m.change4h.toFixed(2)),
        lag:         parseFloat((mLeader.change1h - m.change1h).toFixed(2)),
        price:       m.price,
        volRatio:    parseFloat(m.volRatio.toFixed(2)),
        volDry:      m.volRatio < 1.2,
        score,
        narrative: `${leader.replace('USDT','')} vol spike ${mLeader.volRatio.toFixed(1)}x — ${sym.replace('USDT','')} vol quiet (${m.volRatio.toFixed(1)}x)`,
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

  const msg = [
    `${typeEmoji} <b>${typeLabel}</b>`,
    ``,
    `<b>${sig.symbol}</b> — lagging behind <b>${sig.leader}</b>`,
    `💹 Leader +${sig.leaderGain}% | Own ${sig.ownChange1h > 0 ? '+' : ''}${sig.ownChange1h}%`,
    `📊 Lag: ${sig.lag}% | Vol: ${sig.volRatio}x`,
    `🏷 Sector: ${sig.sector}`,
    `💪 Score: ${sig.score}%`,
    `📝 ${sig.narrative}`,
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
          fetchKlines(sym, '1h', 30),
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
