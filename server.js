/**
 * ROTATION SCREENER v5 — server.js
 * ════════════════════════════════════════════════════════════════
 * NEW in v5:
 *  #1  Live signal invalidation  — price polls every 60s, removes dead signals
 *  #2  Top 3 Picks engine        — highest conviction filter + scoring
 *  #3  BTC funding rate          — in regime, hard warning above 0.05%
 *  #4  Session awareness         — US/Europe/Asia/Off-hours + auto threshold
 *  #5  Bybit cross-confirmation  — validates top signals on second exchange
 *  #6  Historical backtest       — /api/backtest runs 30-day replay on demand
 *
 * Carried from v4:
 *  TF alignment, candle structure, isolated pump detection,
 *  hour-normalized volume, rolling correlation, graveyard,
 *  6 regime sub-modes, entry timing, whale alerts, futures
 * ════════════════════════════════════════════════════════════════
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT          = process.env.PORT     || 3001;
const HOST          = '0.0.0.0';
const TG_TOKEN      = process.env.TG_TOKEN || '';
const TG_CHAT       = process.env.TG_CHAT  || '';
const WHALE_API_KEY = process.env.WHALE_API_KEY || '';

const MIN_QUOTE_VOL_24H = 2_000_000;

// ── Sectors ───────────────────────────────────────────────────────────────────
const SECTORS = {
  'L1_MAJOR':  ['BTCUSDT','ETHUSDT','SOLUSDT','AVAXUSDT','DOTUSDT','BNBUSDT','ADAUSDT','TRXUSDT','HBARUSDT','TONUSDT'],
  'L1_ALT':    ['NEARUSDT','APTUSDT','SUIUSDT','ALGOUSDT','EGLDUSDT','ICPUSDT','FTMUSDT','ONEUSDT','KAVAUSDT','FLOWUSDT','MINAUSDT','XTZUSDT','EOSUSDT','THETAUSDT'],
  'L2':        ['MATICUSDT','ARBUSDT','OPUSDT','IMXUSDT','STXUSDT','METISUSDT','SKLUSDT','LRCUSDT','NTRNUSDT'],
  'DEFI':      ['UNIUSDT','AAVEUSDT','CRVUSDT','MKRUSDT','SNXUSDT','COMPUSDT','SUSHIUSDT','DYDXUSDT','GMXUSDT','CAKEUSDT','BALUSDT','YFIUSDT','1INCHUSDT','RUNEUSDT','KNCUSDT'],
  'AI_DATA':   ['FETUSDT','GRTUSDT','INJUSDT','WLDUSDT','AGIXUSDT','OCEANUSDT','NMRUSDT','RNDRUSDT'],
  'GAMING':    ['AXSUSDT','SANDUSDT','MANAUSDT','GALAUSDT','GMTUSDT','APEUSDT','ILVUSDT','SLPUSDT','YGGUSDT','ALICEUSDT','TLMUSDT','RAREUSDT'],
  'INFRA':     ['LINKUSDT','FILUSDT','LDOUSDT','ENSUSDT','STORJUSDT','AKROUSDT','IOTAUSDT'],
  'PAYMENTS':  ['XRPUSDT','XLMUSDT','LTCUSDT','VETUSDT','ZECUSDT','DASHUSDT','BCHUSDT','QNTUSDT'],
  'COSMOS':    ['ATOMUSDT','TIAUSDT','RUNEUSDT','INJUSDT','AKTUSDT'],
  'MEME':      ['DOGEUSDT','SHIBUSDT','PEPEUSDT','FLOKIUSDT','BONKUSDT','WIFUSDT','MEMEUSDT'],
  'PRIVACY':   ['XMRUSDT','ZECUSDT','ROSEUSDT'],
  'ORACLE':    ['LINKUSDT','BANDUSDT'],
  'BIG_ALTS':  ['SOLUSDT','AVAXUSDT','DOTUSDT','NEARUSDT','MATICUSDT','LTCUSDT','LINKUSDT','ATOMUSDT','UNIUSDT','AAVEUSDT','XRPUSDT','ADAUSDT','FILUSDT','ARBUSDT','OPUSDT'],
};

const SYMBOL_SECTOR = {};
Object.entries(SECTORS).forEach(([s,coins]) => coins.forEach(sym => { SYMBOL_SECTOR[sym]=s; }));
const ALL_SYMBOLS = [...new Set(Object.values(SECTORS).flat())];

const CORR_PAIRS = [
  ['BTCUSDT','ETHUSDT'],['ETHUSDT','SOLUSDT'],['SOLUSDT','AVAXUSDT'],
  ['AVAXUSDT','NEARUSDT'],['DOTUSDT','NEARUSDT'],['APTUSDT','SUIUSDT'],
  ['FTMUSDT','AVAXUSDT'],['ARBUSDT','OPUSDT'],['MATICUSDT','ARBUSDT'],
  ['IMXUSDT','OPUSDT'],['UNIUSDT','AAVEUSDT'],['CRVUSDT','AAVEUSDT'],
  ['GMXUSDT','DYDXUSDT'],['SUSHIUSDT','UNIUSDT'],['SANDUSDT','MANAUSDT'],
  ['AXSUSDT','GALAUSDT'],['APEUSDT','AXSUSDT'],['DOGEUSDT','SHIBUSDT'],
  ['PEPEUSDT','FLOKIUSDT'],['BONKUSDT','WIFUSDT'],['XRPUSDT','XLMUSDT'],
  ['FETUSDT','AGIXUSDT'],['FETUSDT','GRTUSDT'],['RNDRUSDT','FETUSDT'],
  ['ATOMUSDT','TIAUSDT'],['LTCUSDT','BCHUSDT'],
];

const SUB_NARRATIVE = {
  COSMOS_ECO: ['ATOMUSDT','TIAUSDT','INJUSDT','AKTUSDT','NTRNUSDT'],
  ETH_L2:     ['MATICUSDT','ARBUSDT','OPUSDT','METISUSDT','SKLUSDT','LRCUSDT','IMXUSDT'],
  SOL_ECO:    ['SOLUSDT','BONKUSDT','WIFUSDT'],
  AI_COMPUTE: ['FETUSDT','AGIXUSDT','RNDRUSDT','OCEANUSDT','WLDUSDT','GRTUSDT','NMRUSDT'],
  GAMEFI:     ['AXSUSDT','ILVUSDT','SLPUSDT','YGGUSDT','GALAUSDT','ALICEUSDT'],
  METAVERSE:  ['SANDUSDT','MANAUSDT','APEUSDT','GMTUSDT'],
  DEX:        ['UNIUSDT','SUSHIUSDT','CRVUSDT','BALUSDT','1INCHUSDT','CAKEUSDT'],
  LENDING:    ['AAVEUSDT','COMPUSDT','MKRUSDT','SNXUSDT','KNCUSDT'],
  PERPS:      ['DYDXUSDT','GMXUSDT','SNXUSDT'],
  MEME_OG:    ['DOGEUSDT','SHIBUSDT'],
  MEME_NEW:   ['PEPEUSDT','FLOKIUSDT','BONKUSDT','WIFUSDT','MEMEUSDT'],
  REMITTANCE: ['XRPUSDT','XLMUSDT','QNTUSDT'],
  PRIVACY:    ['XMRUSDT','ZECUSDT','DASHUSDT','ROSEUSDT'],
  STORAGE:    ['FILUSDT','STORJUSDT','OCEANUSDT'],
};
const SYM_NARRATIVES = {};
Object.entries(SUB_NARRATIVE).forEach(([nar,coins]) => {
  coins.forEach(sym => { if (!SYM_NARRATIVES[sym]) SYM_NARRATIVES[sym]=[]; SYM_NARRATIVES[sym].push(nar); });
});
function sharedNarratives(a,b) {
  return (SYM_NARRATIVES[a]||[]).filter(n=>(SYM_NARRATIVES[b]||[]).includes(n)).length;
}

const CAP_TIER = {
  BTCUSDT:1,ETHUSDT:1,BNBUSDT:1,SOLUSDT:1,XRPUSDT:1,
  ADAUSDT:2,AVAXUSDT:2,DOGEUSDT:2,DOTUSDT:2,TRXUSDT:2,TONUSDT:2,MATICUSDT:2,LTCUSDT:2,LINKUSDT:2,UNIUSDT:2,
  NEARUSDT:3,APTUSDT:3,ARBUSDT:3,OPUSDT:3,ATOMUSDT:3,HBARUSDT:3,ICPUSDT:3,FILUSDT:3,INJUSDT:3,IMXUSDT:3,
  AAVEUSDT:3,TIAUSDT:3,RUNEUSDT:3,SUIUSDT:3,WLDUSDT:3,FTMUSDT:3,ALGOUSDT:3,EGLDUSDT:3,
  FETUSDT:4,GRTUSDT:4,SUSHIUSDT:4,DYDXUSDT:4,GMXUSDT:4,CRVUSDT:4,MKRUSDT:4,CAKEUSDT:4,
  SANDUSDT:4,MANAUSDT:4,AXSUSDT:4,SNXUSDT:4,COMPUSDT:4,LDOUSDT:4,ENSUSDT:4,STXUSDT:4,
  GALAUSDT:4,APEUSDT:4,GMTUSDT:4,AGIXUSDT:4,RNDRUSDT:4,YFIUSDT:4,BALUSDT:4,
  SHIBUSDT:3,PEPEUSDT:3,XLMUSDT:3,BCHUSDT:3,XMRUSDT:3,
  NTRNUSDT:5,SKLUSDT:5,METISUSDT:5,LRCUSDT:5,AKTUSDT:5,ILVUSDT:5,SLPUSDT:5,
  YGGUSDT:5,ALICEUSDT:5,TLMUSDT:5,RAREUSDT:5,STORJUSDT:5,AKROUSDT:5,IOTAUSDT:5,
  ZECUSDT:4,DASHUSDT:4,VETUSDT:4,FLOKIUSDT:4,BONKUSDT:4,WIFUSDT:4,MEMEUSDT:5,
  OCEANUSDT:4,NMRUSDT:5,ROSEUSDT:5,BANDUSDT:4,KNCUSDT:4,QNTUSDT:4,
};
function capTier(sym) { return CAP_TIER[sym]||3; }
function capTierScore(a,b) { return [100,60,20,0,0][Math.abs(capTier(a)-capTier(b))]||0; }

// ── State ─────────────────────────────────────────────────────────────────────
let rotationCache  = { signals:[],graveyard:[],top3:[],ts:null,scanning:false,coinCount:0,regime:null,session:null,btcFunding:null };
let scanInProgress = false;
const ALERT_TTL_MS = 15*60*1000;
const alertedSignals = new Map();

// ── #1 Live signal invalidation ───────────────────────────────────────────────
// Stores active signals with their entry price and invalidation level.
// Polled every 60s. If price drops below invalidation → move to graveyard as INVALIDATED.
const activeSignalPrices = new Map(); // symbol → { price, invalidation, signalKey }

function startLivePricePoller() {
  setInterval(async () => {
    if (!rotationCache.signals.length) return;
    const symbols = [...new Set(rotationCache.signals.slice(0,20).map(s=>s.symbol))];
    try {
      const prices = await fetchBatchPrices(symbols);
      let anyInvalidated = false;
      rotationCache.signals = rotationCache.signals.filter(sig => {
        const currentPrice = prices[sig.symbol];
        if (!currentPrice || !sig.breakout?.invalidation) return true;
        if (currentPrice < sig.breakout.invalidation) {
          // Invalidated — move to graveyard
          const pctMove = ((currentPrice - sig.price) / sig.price * 100);
          graveyard.unshift({
            symbol: sig.symbol, type: sig.type, score: sig.score,
            sector: sig.sector, entryPrice: sig.price,
            generatedAt: sig.generatedAt, outcome: 'INVALIDATED',
            pctMove: parseFloat(pctMove.toFixed(2)),
            stage: sig.breakout?.stage, resolvedAt: Date.now(),
          });
          console.log(`[INVALIDATED] ${sig.symbol} price $${currentPrice} < invalidation $${sig.breakout.invalidation}`);
          anyInvalidated = true;
          return false;
        }
        // Update current price on signal for freshness
        sig.currentPrice = currentPrice;
        sig.livePctMove  = parseFloat(((currentPrice - sig.price) / sig.price * 100).toFixed(2));
        return true;
      });
      if (anyInvalidated) rotationCache.top3 = computeTop3(rotationCache.signals, rotationCache.regime, rotationCache.session);
    } catch {}
  }, 60_000);
}

async function fetchBatchPrices(symbols) {
  // Binance /api/v3/ticker/price supports multiple symbols
  const prices = {};
  try {
    const data = await fetchBinance(`/api/v3/ticker/price`);
    if (Array.isArray(data)) {
      data.forEach(t => { if (symbols.includes(t.symbol)) prices[t.symbol] = parseFloat(t.price); });
    }
  } catch {}
  return prices;
}

// ── Graveyard ─────────────────────────────────────────────────────────────────
const graveyard = [];
const MAX_GRAVEYARD = 60;

function recordSignal(sig) {
  const key = `${sig.symbol}-${sig.type}-${Date.now()}`;
  hitTracker.set(key, {
    sig:{ symbol:sig.symbol, price:sig.price, type:sig.type, score:sig.score, sector:sig.sector },
    generatedAt:Date.now(), outcomes:{},
  });
  graveyard.unshift({
    symbol:sig.symbol, type:sig.type, score:sig.score, sector:sig.sector,
    entryPrice:sig.price, generatedAt:Date.now(), outcome:null, pctMove:null,
    stage:sig.breakout?.stage,
  });
  if (graveyard.length > MAX_GRAVEYARD) graveyard.pop();
}

async function checkOutcomes(metrics) {
  const now = Date.now();
  for (const [key,entry] of hitTracker) {
    const age=now-entry.generatedAt, m=metrics[entry.sig.symbol];
    if (!m) continue;
    const pct=((m.price-entry.sig.price)/entry.sig.price)*100;
    if (age>=15*60*1000  && entry.outcomes['15m']===undefined) entry.outcomes['15m']=parseFloat(pct.toFixed(2));
    if (age>=60*60*1000  && entry.outcomes['1h'] ===undefined) entry.outcomes['1h'] =parseFloat(pct.toFixed(2));
    if (age>=4*60*60*1000 && entry.outcomes['4h']===undefined) entry.outcomes['4h'] =parseFloat(pct.toFixed(2));
    if (age>24*60*60*1000) hitTracker.delete(key);
  }
  for (const entry of graveyard) {
    if (entry.outcome && entry.outcome!==null) continue;
    const age=now-entry.generatedAt, m=metrics[entry.symbol];
    if (!m) continue;
    const pct=((m.price-entry.entryPrice)/entry.entryPrice)*100;
    entry.pctMove=parseFloat(pct.toFixed(2));
    if (age>=4*60*60*1000) {
      entry.outcome = pct>=1?'WIN':pct<=-1?'FAIL':'NEUTRAL';
      entry.resolvedAt=now;
    }
  }
}

// ── Hit tracker ───────────────────────────────────────────────────────────────
const hitTracker = new Map();
function getHitRateStats() {
  const stats={ byType:{SECTOR:{total:0,win15m:0,win1h:0,win4h:0},CORR:{total:0,win15m:0,win1h:0,win4h:0},VOLFLOW:{total:0,win15m:0,win1h:0,win4h:0}}, overall:{total:0,win15m:0,win1h:0,win4h:0} };
  for (const [,entry] of hitTracker) {
    const {sig,outcomes}=entry;
    if (!stats.byType[sig.type]) stats.byType[sig.type]={total:0,win15m:0,win1h:0,win4h:0};
    stats.byType[sig.type].total++; stats.overall.total++;
    if (outcomes['15m']>0){ stats.byType[sig.type].win15m++; stats.overall.win15m++; }
    if (outcomes['1h'] >0){ stats.byType[sig.type].win1h++;  stats.overall.win1h++;  }
    if (outcomes['4h'] >0){ stats.byType[sig.type].win4h++;  stats.overall.win4h++;  }
  }
  return stats;
}

// ── Telegram ──────────────────────────────────────────────────────────────────
function sendTelegram(msg) {
  if (!TG_TOKEN||!TG_CHAT) return Promise.resolve();
  return new Promise(resolve=>{
    https.get(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage?chat_id=${TG_CHAT}&text=${encodeURIComponent(msg)}&parse_mode=HTML`,
      res=>{ res.on('data',()=>{}); res.on('end',resolve); }).on('error',()=>resolve());
  });
}

// ── Binance fetch ─────────────────────────────────────────────────────────────
function fetchBinance(reqPath, isFutures=false) {
  const eps = isFutures
    ? ['fapi.binance.com']
    : ['data-api.binance.vision','api.binance.com','api1.binance.com','api2.binance.com'];
  function tryEP(i) {
    if (i>=eps.length) return Promise.reject(new Error('All endpoints failed'));
    return new Promise((resolve,reject)=>{
      const req=https.request({hostname:eps[i],path:reqPath,method:'GET',
        headers:{'User-Agent':'RotationScreener/5.0','Accept':'application/json'},timeout:12000},res=>{
        const chunks=[];
        res.on('data',c=>chunks.push(c));
        res.on('end',()=>{
          try {
            const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (Array.isArray(data)&&data.length>0) resolve(data);
            else if (data&&typeof data==='object'&&!data.code) resolve(data);
            else tryEP(i+1).then(resolve).catch(reject);
          } catch { tryEP(i+1).then(resolve).catch(reject); }
        });
      });
      req.on('timeout',()=>{ req.destroy(); tryEP(i+1).then(resolve).catch(reject); });
      req.on('error',()=>tryEP(i+1).then(resolve).catch(reject));
      req.end();
    });
  }
  return tryEP(0);
}

// ── #5 Bybit cross-confirmation ───────────────────────────────────────────────
// Checks if Bybit also shows elevated volume on the same coin.
// No API key needed — Bybit public endpoint.
async function fetchBybitVolume(symbol) {
  return new Promise((resolve)=>{
    const bybitSym = symbol; // Bybit uses same symbol format
    const req = https.request({
      hostname:'api.bybit.com',
      path:`/v5/market/tickers?category=spot&symbol=${bybitSym}`,
      method:'GET', headers:{'Accept':'application/json'}, timeout:8000,
    }, res=>{
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',()=>{
        try {
          const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const ticker=data?.result?.list?.[0];
          if (ticker) {
            resolve({
              price:parseFloat(ticker.lastPrice||0),
              vol24h:parseFloat(ticker.volume24h||0),
              turnover24h:parseFloat(ticker.turnover24h||0),
              change24h:parseFloat(ticker.price24hPcnt||0)*100,
            });
          } else resolve(null);
        } catch { resolve(null); }
      });
    });
    req.on('error',()=>resolve(null));
    req.on('timeout',()=>{ req.destroy(); resolve(null); });
    req.end();
  });
}

// Compare Bybit volume to Binance volume. Returns cross-confirmed flag.
async function crossConfirmBybit(sig, binanceMetrics) {
  try {
    const bybit = await fetchBybitVolume(sig.symbol);
    if (!bybit) return { crossConfirmed:false, bybitLabel:'NO BYBIT DATA' };
    const binanceM = binanceMetrics[sig.symbol];
    // Both showing positive price action = stronger
    const bothPositive = sig.ownChange1h > 0 && bybit.change24h > 0;
    // Bybit volume above average (proxy: turnover > $1M in 24h)
    const bybitActive = bybit.turnover24h > 1_000_000;
    const crossConfirmed = bothPositive && bybitActive;
    const label = crossConfirmed
      ? `✅ BYBIT CONFIRMS — ${(bybit.turnover24h/1e6).toFixed(1)}M vol`
      : `○ Bybit: ${(bybit.turnover24h/1e6).toFixed(1)}M vol`;
    return { crossConfirmed, bybitLabel:label, bybitPrice:bybit.price, bybitChange:bybit.change24h };
  } catch { return { crossConfirmed:false, bybitLabel:'BYBIT ERROR' }; }
}

// ── #4 Session awareness ──────────────────────────────────────────────────────
// Returns current trading session based on UTC hour.
// Each session has a different minimum score threshold.
function getMarketSession() {
  const h = new Date().getUTCHours();
  if (h>=13&&h<16) return { session:'US_PREMARKET',  label:'🇺🇸 US PRE-MARKET',  color:'#FFD700', minScore:35, description:'Institutional flow starting — good rotation window' };
  if (h>=16&&h<20) return { session:'EU_US_OVERLAP', label:'🌍 EU/US OVERLAP',   color:'#00FFB2', minScore:30, description:'Highest volume window — best rotation conditions' };
  if (h>=20&&h<23) return { session:'US_MARKET',     label:'🇺🇸 US MARKET',      color:'#00BFFF', minScore:32, description:'US session peak — strong rotation signals' };
  if (h>=8&&h<13)  return { session:'EUROPE',        label:'🇪🇺 EUROPE',         color:'#CF8FFF', minScore:40, description:'European session — moderate rotation' };
  if (h>=2&&h<8)   return { session:'ASIA',          label:'🌏 ASIA',            color:'#FFB040', minScore:45, description:'Asia session — different rotation patterns, be selective' };
  return                  { session:'OFF_HOURS',     label:'🌙 OFF-HOURS',       color:'#6A9AB0', minScore:65, description:'Low volume — only trade very high confidence signals' };
}

// ── #3 BTC funding rate ───────────────────────────────────────────────────────
let btcFundingCache = { rate:null, ts:0 };

async function fetchBTCFunding() {
  if (Date.now()-btcFundingCache.ts < 5*60*1000) return btcFundingCache;
  try {
    const data = await fetchBinance('/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1', true);
    const rate = Array.isArray(data)&&data.length>0 ? parseFloat(data[0].fundingRate)*100 : null;
    btcFundingCache = { rate, ts:Date.now(),
      label: rate===null ? '—'
           : rate>0.1  ? `${rate.toFixed(3)}% 🔴 CROWDED LONGS`
           : rate>0.05 ? `${rate.toFixed(3)}% ⚠ ELEVATED`
           : rate<-0.05? `${rate.toFixed(3)}% ⚠ CROWDED SHORTS`
           : `${rate.toFixed(3)}% ✅ CLEAN`,
      danger: rate!==null && (rate>0.05||rate<-0.05),
    };
    return btcFundingCache;
  } catch { return btcFundingCache; }
}

// ── Altcoin futures ───────────────────────────────────────────────────────────
async function fetchFuturesData(symbol) {
  try {
    const [oiRes,frRes]=await Promise.allSettled([
      fetchBinance(`/fapi/v1/openInterest?symbol=${symbol}`,true),
      fetchBinance(`/fapi/v1/fundingRate?symbol=${symbol}&limit=3`,true),
    ]);
    const oi=oiRes.status==='fulfilled'?parseFloat(oiRes.value.openInterest||0):null;
    const frArr=frRes.status==='fulfilled'&&Array.isArray(frRes.value)?frRes.value:[];
    const fr=frArr.length>0?parseFloat(frArr[frArr.length-1].fundingRate||0)*100:null;
    return { oi, fundingRate:fr };
  } catch { return { oi:null,fundingRate:null }; }
}

function scoreFutures(fut) {
  if (!fut||fut.fundingRate===null) return { futuresScore:50, futuresLabel:'NO DATA' };
  const fr=fut.fundingRate;
  let score=70;
  if (fr>0.10)score-=35; else if (fr>0.05)score-=15;
  else if (fr<-0.05)score-=20;
  else if (fr>=-0.01&&fr<=0.03)score+=20;
  const label=fr>0.10?`FR:${fr.toFixed(3)}% ⚠ CROWDED`:fr<-0.05?`FR:${fr.toFixed(3)}% ⚠ SHORT`:`FR:${fr.toFixed(3)}% ✓`;
  return { futuresScore:Math.min(100,Math.max(0,score)), futuresLabel:label, fundingRate:fr };
}

// ── Whale alerts ──────────────────────────────────────────────────────────────
let whaleCache = { alerts:[], ts:0 };
async function fetchWhaleAlerts() {
  if (!WHALE_API_KEY) return [];
  if (Date.now()-whaleCache.ts<5*60*1000) return whaleCache.alerts;
  try {
    const data=await new Promise((resolve,reject)=>{
      const req=https.request({hostname:'api.whale-alert.io',method:'GET',
        path:`/v1/transactions?api_key=${WHALE_API_KEY}&min_value=1000000&limit=20`,
        headers:{'Accept':'application/json'},timeout:8000},res=>{
        const chunks=[];
        res.on('data',c=>chunks.push(c));
        res.on('end',()=>{ try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch{reject();}});
      });
      req.on('error',reject); req.on('timeout',()=>{req.destroy();reject();}); req.end();
    });
    const alerts=(data.transactions||[]).map(t=>({
      symbol:(t.symbol||'').toUpperCase()+'USDT',
      amount:t.amount_usd||0,
      bullish:t.to?.owner_type==='wallet'&&t.from?.owner_type==='exchange',
      bearish:t.from?.owner_type==='wallet'&&t.to?.owner_type==='exchange',
    }));
    whaleCache={alerts,ts:Date.now()};
    return alerts;
  } catch { return []; }
}

function getWhaleSignal(symbol,whaleAlerts) {
  const relevant=whaleAlerts.filter(a=>a.symbol===symbol);
  if(!relevant.length) return {whaleScore:50,whaleLabel:'NO DATA',whaleBullish:false};
  const bull=relevant.filter(a=>a.bullish).length, bear=relevant.filter(a=>a.bearish).length;
  const score=bull>bear?Math.min(100,60+bull*15):bear>bull?Math.max(0,40-bear*15):50;
  const label=bull>bear?`🐋 ${bull} WITHDRAWALS (BULLISH)`:bear>bull?`🐋 ${bear} DEPOSITS (BEARISH)`:'🐋 NEUTRAL';
  return {whaleScore:score,whaleLabel:label,whaleBullish:bull>bear};
}

// ── EMA ───────────────────────────────────────────────────────────────────────
function calcEMA(candles,period) {
  if (candles.length<period) return candles[candles.length-1].close;
  let sum=0; for(let i=0;i<period;i++) sum+=candles[i].close;
  let ema=sum/period; const k=2/(period+1);
  for(let i=period;i<candles.length;i++) ema=candles[i].close*k+ema*(1-k);
  return ema;
}

// ── Rolling correlation ───────────────────────────────────────────────────────
function rollingCorrelation(cA,cB,period=14) {
  const n=Math.min(cA.length,cB.length,period); if(n<6) return 0;
  const a=cA.slice(-n).map(c=>c.close), b=cB.slice(-n).map(c=>c.close);
  const mA=a.reduce((s,v)=>s+v,0)/n, mB=b.reduce((s,v)=>s+v,0)/n;
  let num=0,dA=0,dB=0;
  for(let i=0;i<n;i++){const da=a[i]-mA,db=b[i]-mB;num+=da*db;dA+=da*da;dB+=db*db;}
  const denom=Math.sqrt(dA*dB); return denom===0?0:parseFloat((num/denom).toFixed(3));
}

// ── #7 Regime (6 sub-modes) ───────────────────────────────────────────────────
function assessRegime(btc1h,btc4h,eth4h,btcFunding) {
  const lastBtc=btc1h[btc1h.length-1].close, lastBtc4=btc4h[btc4h.length-1].close, lastEth4=eth4h[eth4h.length-1].close;
  const btcEma20_1h=calcEMA(btc1h,20), btcEma50_1h=calcEMA(btc1h,50);
  const btcEma20_4h=calcEMA(btc4h,20), btcEma50_4h=calcEMA(btc4h,50);
  const btcTrend1h=lastBtc>btcEma20_1h&&btcEma20_1h>btcEma50_1h?'UP':lastBtc<btcEma20_1h&&btcEma20_1h<btcEma50_1h?'DOWN':'NEUTRAL';
  const btcTrend4h=lastBtc4>btcEma20_4h&&btcEma20_4h>btcEma50_4h?'UP':lastBtc4<btcEma20_4h&&btcEma20_4h<btcEma50_4h?'DOWN':'NEUTRAL';
  const btcChange4h=((lastBtc4-btc4h[0].close)/btc4h[0].close)*100;
  const ethChange4h=((lastEth4-eth4h[0].close)/eth4h[0].close)*100;
  const ethBtcRatio=ethChange4h-btcChange4h;
  const ethBtcTrend=ethBtcRatio>0.5?'RISING':ethBtcRatio<-0.5?'FALLING':'FLAT';
  const btc4hHigh=Math.max(...btc4h.slice(0,-1).map(c=>c.high));
  const btcNewHigh=lastBtc4>btc4hHigh;
  const frDanger=btcFunding?.rate!=null&&(btcFunding.rate>0.05||btcFunding.rate<-0.05);

  let subMode,altMultiplier,description;
  if (btcTrend4h==='UP'&&btcNewHigh&&ethBtcTrend!=='FALLING'&&!frDanger) {subMode='AGGRESSIVE_ALT';altMultiplier=1.10;description='BTC new highs + funding clean → Aggressive alt rotation, high beta alts work';}
  else if (btcTrend4h==='UP'&&!btcNewHigh&&ethBtcTrend==='RISING'&&!frDanger) {subMode='ETH_LED';altMultiplier=1.05;description='ETH outperforming → DeFi/ETH ecosystem rotation favoured';}
  else if (btcTrend4h==='UP'&&!frDanger) {subMode='RISK_ON';altMultiplier=1.00;description='BTC uptrend consolidating → Mid-cap rotation, be selective';}
  else if (btcTrend4h==='UP'&&frDanger) {subMode='FUNDING_WARNING';altMultiplier=0.75;description='BTC trending but funding crowded → Reduce size, longs at risk of flush';}
  else if (btcTrend4h==='NEUTRAL'&&ethBtcTrend==='RISING') {subMode='ETH_ROTATION';altMultiplier=0.90;description='BTC flat, ETH leading → ETH ecosystem only';}
  else if (btcTrend4h==='NEUTRAL') {subMode='NEUTRAL';altMultiplier=0.80;description='BTC choppy → Selective signals only, raise score threshold';}
  else if (btcTrend4h==='DOWN'&&btcTrend1h==='DOWN') {subMode='RISK_OFF';altMultiplier=0.50;description='BTC confirmed downtrend → Avoid alts entirely';}
  else {subMode='CAUTION';altMultiplier=0.65;description='Mixed signals → Only multi-confirmed top-score signals';}

  const regime=subMode==='RISK_OFF'||subMode==='CAUTION'?'RISK_OFF':subMode==='NEUTRAL'||subMode==='ETH_ROTATION'||subMode==='FUNDING_WARNING'?'NEUTRAL':'RISK_ON';
  return {
    regime,subMode,altMultiplier,description,
    btcTrend1h,btcTrend4h,ethBtcTrend,btcNewHigh,frDanger,
    btcPrice:lastBtc,
    btcEma20:parseFloat(btcEma20_1h.toFixed(2)),
    btcEma50:parseFloat(btcEma50_1h.toFixed(2)),
    btcChange4h:parseFloat(btcChange4h.toFixed(2)),
    ethChange4h:parseFloat(ethChange4h.toFixed(2)),
    ethBtcRatio:parseFloat(ethBtcRatio.toFixed(2)),
    btcFundingRate:btcFunding?.rate??null,
    btcFundingLabel:btcFunding?.label||'—',
    btcFundingDanger:frDanger,
  };
}

// ── VP ────────────────────────────────────────────────────────────────────────
const VP_BINS=36;
function calcVP(candles) {
  if (!candles||candles.length<10) return null;
  let lo=Infinity,hi=-Infinity;
  candles.forEach(c=>{ if(c.high>hi)hi=c.high; if(c.low<lo)lo=c.low; });
  const range=hi-lo; if(!range) return null;
  const binSize=range/VP_BINS,vol=new Array(VP_BINS).fill(0);
  candles.forEach(c=>{ const t=(c.high+c.low+c.close)/3; vol[Math.min(Math.floor((t-lo)/binSize),VP_BINS-1)]+=c.volume; });
  let pocIdx=0; vol.forEach((v,i)=>{ if(v>vol[pocIdx])pocIdx=i; });
  const poc=lo+(pocIdx+0.5)*binSize,tv=vol.reduce((a,b)=>a+b,0);
  let vaVol=vol[pocIdx],vaLo=pocIdx,vaHi=pocIdx;
  while(vaVol<tv*0.70){const nL=vaLo>0?vol[vaLo-1]:0,nH=vaHi<VP_BINS-1?vol[vaHi+1]:0;if(nL>=nH&&vaLo>0){vaLo--;vaVol+=nL;}else if(vaHi<VP_BINS-1){vaHi++;vaVol+=nH;}else break;}
  return {poc,vah:lo+(vaHi+1)*binSize,val:lo+vaLo*binSize};
}
function vpProximityScore(price,vp){if(!vp)return 30;const dL=Math.abs(price-vp.val)/vp.val*100,dP=Math.abs(price-vp.poc)/vp.poc*100,dH=Math.abs(price-vp.vah)/vp.vah*100;if(price<vp.val*0.98)return 5;if(dL<=0.8)return 100;if(dL<=2.0)return 85;if(dP<=0.8)return 65;if(dP<=2.0)return 50;if(dH<=1.0)return 40;return price>=vp.val&&price<=vp.vah?35:15;}
function vpLevelLabel(price,vp){if(!vp)return'—';const dL=Math.abs(price-vp.val)/vp.val*100,dP=Math.abs(price-vp.poc)/vp.poc*100,dH=Math.abs(price-vp.vah)/vp.vah*100;if(price<vp.val*0.98)return'BELOW VAL ⚠';if(dL<=2.0)return'AT VAL 🎯';if(dP<=2.0)return'AT POC ◆';if(dH<=1.5)return'AT VAH 🔴';if(price>=vp.val&&price<=vp.vah)return'IN VALUE';return'ABOVE VAH';}

// ── Breakout stage ────────────────────────────────────────────────────────────
function detectBreakoutStage(c1h,c4h,c1d,vp){const price=c1h[c1h.length-1].close,ema20=calcEMA(c1h,20),ema50=calcEMA(c1h,50);const p4hHigh=c4h.slice(0,-1).reduce((m,c)=>Math.max(m,c.high),-Infinity),p4hLow=c4h.slice(0,-1).reduce((m,c)=>Math.min(m,c.low),Infinity),pdHigh=c1d.length>=2?c1d[c1d.length-2].high:c1d[0].high,pdLow=c1d.length>=2?c1d[c1d.length-2].low:c1d[0].low;const resLevels=[p4hHigh,pdHigh,vp?.vah].filter(l=>l&&l>price),supLevels=[p4hLow,pdLow,vp?.val,vp?.poc].filter(l=>l&&l<price);const nearestRes=resLevels.length>0?Math.min(...resLevels):null,nearestSup=supLevels.length>0?Math.max(...supLevels):null;let stage,stageColor;if(price<ema20&&price<ema50&&price<(vp?.val||Infinity)){stage='BELOW_STRUCTURE';stageColor='#FF5E3A';}else if(price>=(vp?.val||0)&&price<=ema20&&price<=(vp?.poc||Infinity)){stage='ACCUMULATION';stageColor='#00FFB2';}else if(price>ema20&&price<=p4hHigh&&price<=(vp?.vah||Infinity)){stage='PRE_BREAKOUT';stageColor='#FFD700';}else if(price>p4hHigh&&price<=pdHigh){stage='BREAKOUT_CONFIRMED';stageColor='#00BFFF';}else if(price>pdHigh){stage='CHASE_RISK';stageColor='#FF9500';}else{stage='IN_RANGE';stageColor='#B8D4E8';}return{stage,stageColor,ema20:parseFloat(ema20.toFixed(6)),ema50:parseFloat(ema50.toFixed(6)),p4hHigh:parseFloat(p4hHigh.toFixed(6)),pdHigh:parseFloat(pdHigh.toFixed(6)),nearestRes:nearestRes?parseFloat(nearestRes.toFixed(6)):null,nearestSup:nearestSup?parseFloat(nearestSup.toFixed(6)):null,invalidation:nearestSup?parseFloat((nearestSup*0.99).toFixed(6)):null,doNotChaseAbove:nearestRes?parseFloat((nearestRes*0.995).toFixed(6)):null};}

// ── Volume quality ────────────────────────────────────────────────────────────
function assessVolumeQuality(c1h){const last3=c1h.slice(-3),last=last3[last3.length-1];const buyRatio=last.volume>0?last.takerBuy/last.volume:0.5,body=Math.abs(last.close-last.open),range=last.high-last.low,bodyRatio=range>0?body/range:0,closePos=range>0?(last.close-last.low)/range:0.5,expanding=last3.length===3&&last3[1].volume>last3[0].volume&&last3[2].volume>last3[1].volume;let q=40;if(buyRatio>0.6)q+=20;if(bodyRatio>0.6)q+=15;if(closePos>0.7)q+=15;if(expanding)q+=10;return{buyRatio:parseFloat(buyRatio.toFixed(2)),bodyRatio:parseFloat(bodyRatio.toFixed(2)),closePos:parseFloat(closePos.toFixed(2)),expanding,volQuality:Math.min(100,q),volQualityLabel:q>=80?'STRONG 💪':q>=60?'GOOD ✓':q>=40?'AVERAGE':'WEAK ⚠'};}

// ── Candle structure ──────────────────────────────────────────────────────────
function candleStructureScore(c1h){const last5=c1h.slice(-5);if(last5.length<3)return{structScore:50,structLabel:'INSUFFICIENT'};const last=last5[last5.length-1],prev=last5[last5.length-2],prev2=last5[last5.length-3];const higherLows=last.low>prev.low&&prev.low>prev2.low,bullishBody=last.close>last.open,range=last.high-last.low,closePos=range>0?(last.close-last.low)/range:0.5,closingHigh=closePos>0.6,upperWick=last.high-Math.max(last.open,last.close),noRejection=range>0?upperWick/range<0.4:true,volExpanding=last5.length>=3&&last5[last5.length-1].volume>=last5[last5.length-2].volume*0.8;let score=40;if(higherLows)score+=25;if(bullishBody)score+=15;if(closingHigh)score+=10;if(noRejection)score+=10;if(!volExpanding)score-=10;const label=score>=80?'STRONG ACCUM 💪':score>=60?'MILD ACCUM':score>=40?'NEUTRAL':'DISTRIBUTING ⚠';return{structScore:Math.min(100,Math.max(0,score)),structLabel:label,higherLows,bullishBody};}

// ── TF alignment ──────────────────────────────────────────────────────────────
function timeframeAlignment(c1h,c4h){const aligned=(c1h>0&&c4h>-1)||(c1h<-0.5&&c4h<-0.5),noConflict=!(c1h>0.5&&c4h<-3);let score=50;if(aligned)score+=30;if(noConflict)score+=20;if(c4h>0&&c1h>0)score+=10;if(c4h<-3)score-=30;return{tfScore:Math.min(100,Math.max(0,score)),tfAligned:aligned&&noConflict};}

// ── Hour-normalized volume ────────────────────────────────────────────────────
function hourNormalizedVolRatio(c1h){if(c1h.length<48){const last=c1h[c1h.length-1],avg=c1h.slice(-21,-1).reduce((a,c)=>a+c.volume,0)/20;return{hnVolRatio:avg>0?parseFloat((last.volume/avg).toFixed(2)):1,normalized:false};}const last=c1h[c1h.length-1],currentHour=new Date(last.time).getUTCHours(),sameHour=c1h.slice(0,-1).filter(c=>new Date(c.time).getUTCHours()===currentHour);if(sameHour.length<3){const avg=c1h.slice(-21,-1).reduce((a,c)=>a+c.volume,0)/20;return{hnVolRatio:avg>0?parseFloat((last.volume/avg).toFixed(2)):1,normalized:false};}const avgH=sameHour.reduce((a,c)=>a+c.volume,0)/sameHour.length;return{hnVolRatio:avgH>0?parseFloat((last.volume/avgH).toFixed(2)):1,normalized:true};}

// ── Isolated pump ─────────────────────────────────────────────────────────────
function isIsolatedPump(leader,sectorCoins,metrics){const lm=metrics[leader];if(!lm)return{isolated:false,peerActivity:0};const peers=sectorCoins.filter(s=>s!==leader&&metrics[s]);if(!peers.length)return{isolated:false,peerActivity:0};const active=peers.filter(s=>metrics[s].volRatio>1.3).length;return{isolated:lm.volRatio>2.5&&active===0,peerActivity:parseFloat((active/peers.length*100).toFixed(0)),activepeers:active,totalPeers:peers.length};}

// ── Entry timing ──────────────────────────────────────────────────────────────
function entryTiming(c1h,vp){const last=c1h[c1h.length-1],prev=c1h[c1h.length-2],prev2=c1h[c1h.length-3];const confirmationCandle=last.close>prev.high,atSupport=vp&&Math.abs(last.close-vp.val)/vp.val<0.02,forming=last.close<=prev.high&&last.close>prev.low,alreadyRan=prev2&&((last.close-prev2.low)/prev2.low*100)>3;let timing,timingScore;if(confirmationCandle&&last.close>last.open){timing='CONFIRMED ✓';timingScore=90;}else if(atSupport&&last.close>last.open){timing='EARLY ENTRY';timingScore=80;}else if(forming){timing='WAIT — FORMING';timingScore=50;}else{timing='WAIT — NO SETUP';timingScore=30;}if(alreadyRan&&timing==='CONFIRMED ✓'){timing='LATE ENTRY ⚠';timingScore=40;}return{timing,timingScore,confirmationCandle,atSupport};}

// ── RS vs BTC ─────────────────────────────────────────────────────────────────
function relStrengthVsBTC(c1h,c4h,b1h,b4h){const rs1h=c1h-b1h,rs4h=c4h-b4h;return{rs1h:parseFloat(rs1h.toFixed(2)),rs4h:parseFloat(rs4h.toFixed(2)),rsScore:Math.min(100,Math.max(0,50+rs1h*5+rs4h*3))};}

// ── Momentum ──────────────────────────────────────────────────────────────────
function momentumStateScore(c1h,c4h,c24h){let s=70;const r=Math.abs(c24h);if(r>15)s-=40;else if(r>8)s-=20;else if(r>4)s-=8;else s+=15;if(Math.abs(c4h)<1.5&&Math.abs(c1h)>0.2)s+=15;if(c4h<-4)s-=25;return Math.min(100,Math.max(0,s));}

// ── Master scorer ─────────────────────────────────────────────────────────────
function scoreCandidate(sym,leader,m,regime,btcC1h,btcC4h,isolated){
  const narCount=sharedNarratives(sym,leader);
  const narScore=narCount>=2?100:narCount===1?65:20;
  const capScore=capTierScore(sym,leader);
  const momScore=momentumStateScore(m.change1h,m.change4h,m.change24h);
  const vpScore=vpProximityScore(m.price,m.vp);
  const {tfScore,tfAligned}=m.tfData||{tfScore:50,tfAligned:true};
  const structScore=m.structData?.structScore||50;
  const volScore=m.hnVolRatio<0.8?100:m.hnVolRatio<1.2?80:m.hnVolRatio<1.8?45:m.hnVolRatio<2.5?20:5;
  const {rsScore,rs1h,rs4h}=relStrengthVsBTC(m.change1h,m.change4h,btcC1h||0,btcC4h||0);
  const vqScore=m.volQuality?.volQuality||50;
  const trendScore=m.change4h>1?100:m.change4h>0?80:m.change4h>-2?55:m.change4h>-5?25:0;
  const timingScore=m.entryData?.timingScore||50;
  const composite=narScore*0.18+capScore*0.15+momScore*0.12+vpScore*0.11+tfScore*0.09+structScore*0.09+volScore*0.08+rsScore*0.07+vqScore*0.05+trendScore*0.04+timingScore*0.02;
  let finalScore=composite*(regime?.altMultiplier||1.0);
  if(isolated)finalScore*=0.65;
  if(!tfAligned)finalScore=Math.min(finalScore,55);
  return{score:Math.min(100,Math.max(0,Math.round(finalScore))),scoreBreakdown:{narrative:Math.round(narScore),capTier:Math.round(capScore),momentum:Math.round(momScore),vpLevel:Math.round(vpScore),tfAlign:Math.round(tfScore),structure:Math.round(structScore),volDry:Math.round(volScore),relStrength:Math.round(rsScore),volQuality:Math.round(vqScore),trend:Math.round(trendScore),timing:Math.round(timingScore)},vpLabel:m.vp?vpLevelLabel(m.price,m.vp):'—',vp:m.vp,narCount,capTierVal:capTier(sym),rs1h,rs4h,tfAligned};}

// ── Build signal ──────────────────────────────────────────────────────────────
function buildSignal(baseType,sym,leader,sector,metrics,regime,isolated,whaleAlerts){
  const m=metrics[sym],ml=metrics[leader],btcM=metrics['BTCUSDT'];
  const lag=ml.change1h-m.change1h;
  const scored=scoreCandidate(sym,leader,m,regime,btcM?.change1h||0,btcM?.change4h||0,isolated);
  const {score,scoreBreakdown,vpLabel,vp,narCount,capTierVal,rs1h,rs4h,tfAligned}=scored;
  const breakout=detectBreakoutStage(m.c1h,m.c4h,m.c1d,m.vp);
  const catchUpPct=parseFloat(lag.toFixed(2));
  const riskPct=breakout.invalidation?((m.price-breakout.invalidation)/m.price*100):Math.abs(m.change4h)||2;
  const rr=riskPct>0?parseFloat((catchUpPct/riskPct).toFixed(1)):null;
  const narLabel=narCount>=2?'🔥 SAME ECOSYSTEM':narCount===1?'✓ RELATED':'○ BROAD SECTOR';
  const whale=getWhaleSignal(sym,whaleAlerts);
  return{type:baseType,symbol:sym,sector,leader,leaderGain:parseFloat(ml.change1h.toFixed(2)),ownChange1h:parseFloat(m.change1h.toFixed(2)),ownChange4h:parseFloat(m.change4h.toFixed(2)),change24h:parseFloat(m.change24h.toFixed(2)),lag:parseFloat(lag.toFixed(2)),price:m.price,volRatio:parseFloat((m.hnVolRatio||m.volRatio||1).toFixed(2)),hnNormalized:m.hnNormalized||false,quoteVol24h:Math.round(m.quoteVol24h||0),volDry:(m.hnVolRatio||m.volRatio||1)<1.2,score,scoreBreakdown,vpLabel,vp,narLabel,narCount,capTierVal,rs1h,rs4h,tfAligned,breakout,catchUpPct,rr,volQuality:m.volQuality,structData:m.structData,entryData:m.entryData,isolated,whale,generatedAt:Date.now(),currentPrice:m.price,livePctMove:0,narrative:`${leader.replace('USDT','')} +${ml.change1h.toFixed(1)}% · ${sym.replace('USDT','')} lags ${lag.toFixed(1)}% · ${narLabel} · ${breakout.stage} · VP:${vpLabel}${tfAligned?'':' · ⚠TF CONFLICT'}${isolated?' · ⚠ISOLATED':''}`};}

// ── Detectors ─────────────────────────────────────────────────────────────────
function detectSectorRotation(metrics,regime,whaleAlerts){const signals=[];Object.entries(SECTORS).forEach(([sector,coins])=>{const pumped=coins.filter(s=>metrics[s]&&metrics[s].change1h>=0.4).sort((a,b)=>metrics[b].change1h-metrics[a].change1h);if(!pumped.length)return;const leader=pumped[0];const{isolated}=isIsolatedPump(leader,coins,metrics);coins.forEach(sym=>{if(!metrics[sym]||sym===leader)return;if(metrics[sym].change1h>metrics[leader].change1h*0.7)return;if(metrics[sym].quoteVol24h<MIN_QUOTE_VOL_24H)return;signals.push(buildSignal('SECTOR',sym,leader,sector,metrics,regime,isolated,whaleAlerts));});});return signals;}
function detectCorrelationDivergence(metrics,regime,whaleAlerts){const signals=[];CORR_PAIRS.forEach(([symA,symB])=>{const mA=metrics[symA],mB=metrics[symB];if(!mA||!mB)return;const diff=mA.change1h-mB.change1h,absDiff=Math.abs(diff);if(absDiff<0.3)return;const laggard=diff>0?symB:symA,leader=diff>0?symA:symB;if(metrics[laggard].change4h<-8)return;if(metrics[laggard].quoteVol24h<MIN_QUOTE_VOL_24H)return;const corrCoeff=rollingCorrelation(mA.c1h,mB.c1h,14);if(corrCoeff<0.4)return;signals.push(buildSignal('CORR',laggard,leader,SYMBOL_SECTOR[laggard]||'—',metrics,regime,false,whaleAlerts));});return signals;}
function detectVolumeFlow(metrics,regime,whaleAlerts){const signals=[];Object.entries(SECTORS).forEach(([sector,coins])=>{const vl=coins.filter(s=>metrics[s]&&metrics[s].volRatio>=1.3&&metrics[s].change1h>-1).sort((a,b)=>metrics[b].volRatio-metrics[a].volRatio);if(!vl.length)return;const leader=vl[0];const{isolated}=isIsolatedPump(leader,coins,metrics);coins.forEach(sym=>{if(!metrics[sym]||sym===leader)return;if(metrics[sym].volRatio>metrics[leader].volRatio*0.8)return;if(metrics[sym].change1h<-5)return;if(metrics[sym].quoteVol24h<MIN_QUOTE_VOL_24H)return;signals.push(buildSignal('VOLFLOW',sym,leader,sector,metrics,regime,isolated,whaleAlerts));});});return signals;}

// ── #2 Top 3 Picks engine ─────────────────────────────────────────────────────
// Rules: must be ACCUMULATION or PRE_BREAKOUT, TF aligned, not isolated,
// multi-confirmed OR score>78, sorted by score × freshness × regime mult.
function computeTop3(signals, regime, session) {
  const sessionMinScore = session?.minScore || 40;
  const eligible = signals.filter(s=>
    (s.breakout?.stage==='ACCUMULATION'||s.breakout?.stage==='PRE_BREAKOUT'||s.breakout?.stage==='BREAKOUT_CONFIRMED') &&
    s.tfAligned && !s.isolated &&
    (s.confirmed||s.score>=78) &&
    s.score >= sessionMinScore
  );
  // Freshness multiplier
  const freshnessScore = s => {
    const ageMin = (Date.now() - s.generatedAt) / 60000;
    const fm = ageMin<10?1.0:ageMin<45?0.85:0.6;
    // Cross-confirmed bonus
    const cc = s.bybitData?.crossConfirmed ? 1.10 : 1.0;
    // Whale bonus
    const wb = s.whale?.whaleBullish ? 1.05 : 1.0;
    return s.score * fm * cc * wb;
  };
  return eligible.sort((a,b)=>freshnessScore(b)-freshnessScore(a)).slice(0,3).map(s=>({
    symbol:    s.symbol,
    leader:    s.leader,
    score:     s.score,
    type:      s.type,
    confirmed: s.confirmed,
    confirmedTypes: s.confirmedTypes,
    stage:     s.breakout?.stage,
    stageColor:s.breakout?.stageColor,
    vpLabel:   s.vpLabel,
    entryTiming:s.entryData?.timing,
    catchUpPct:s.catchUpPct,
    rr:        s.rr,
    invalidation:s.breakout?.invalidation,
    doNotChaseAbove:s.breakout?.doNotChaseAbove,
    price:     s.price,
    ownChange1h:s.ownChange1h,
    leaderGain: s.leaderGain,
    lag:       s.lag,
    narLabel:  s.narLabel,
    bybitConfirmed: s.bybitData?.crossConfirmed||false,
    whaleBullish:   s.whale?.whaleBullish||false,
    fundingLabel:   s.futuresLabel||'—',
    generatedAt:    s.generatedAt,
    freshnessScore: parseFloat(freshnessScore(s).toFixed(1)),
    whyThisOne: buildWhyText(s),
  }));
}

function buildWhyText(s) {
  const reasons = [];
  if (s.confirmed) reasons.push(`⚡ ${s.confirmedTypes?.length} algorithms agree`);
  if (s.bybitData?.crossConfirmed) reasons.push('✅ Bybit confirms');
  if (s.whale?.whaleBullish) reasons.push('🐋 Whale withdrawals (bullish)');
  if (s.vpLabel?.includes('VAL')) reasons.push('🎯 Sitting at VAL support');
  if (s.vpLabel?.includes('POC')) reasons.push('◆ At POC magnet');
  if (s.entryData?.confirmationCandle) reasons.push('✓ Confirmation candle printed');
  if (s.structData?.higherLows) reasons.push('📈 Higher lows forming');
  if (s.narCount>=2) reasons.push('🔥 Same ecosystem as leader');
  if (!reasons.length) reasons.push('Strong multi-factor score');
  return reasons.slice(0,3).join(' · ');
}

// ── #6 Historical backtest ────────────────────────────────────────────────────
// Fetches 30 days of 4h candles and replays signal logic on past data.
// Returns array of { date, signals fired, outcomes after 1 candle (4h) }
let backtestRunning = false;
let backtestCache   = null;

async function runBacktest(symbols = ['BTCUSDT','ETHUSDT','SOLUSDT','ARBUSDT','OPUSDT','NEARUSDT','FETUSDT','ATOMUSDT']) {
  if (backtestRunning) return { running:true };
  backtestRunning = true;
  console.log('[BACKTEST] Starting 30-day replay...');
  const results = [];
  try {
    // Fetch 30d of 4h candles for each symbol
    const allCandles = {};
    await Promise.allSettled(symbols.map(async sym => {
      try {
        const raw = await fetchBinance(`/api/v3/klines?symbol=${sym}&interval=4h&limit=180`);
        allCandles[sym] = raw.map(k=>({
          time:parseInt(k[0]), open:parseFloat(k[1]), high:parseFloat(k[2]),
          low:parseFloat(k[3]), close:parseFloat(k[4]), volume:parseFloat(k[5]),
          quoteVol:parseFloat(k[7]), takerBuy:parseFloat(k[9]), takerBuyQuote:parseFloat(k[10]),
        }));
      } catch {}
    }));

    // Slide a window of 20 candles across history, detect signals, check next candle
    const btcCandles = allCandles['BTCUSDT'] || [];
    const minLen = Math.min(...Object.values(allCandles).map(c=>c.length));

    for (let i = 20; i < minLen - 1; i++) {
      const windowMetrics = {};
      for (const [sym, candles] of Object.entries(allCandles)) {
        const w = candles.slice(i-20, i+1);
        if (w.length < 10) continue;
        const last = w[w.length-1], prev = w[w.length-2];
        const change1h = ((last.close - prev.close) / prev.close) * 100;
        const change4h = w.length>5 ? ((last.close - w[w.length-5].close) / w[w.length-5].close) * 100 : 0;
        const change24h = w.length>7 ? ((last.close - w[w.length-7].close) / w[w.length-7].close) * 100 : 0;
        const vols = w.slice(-21,-1).map(c=>c.volume);
        const avgVol = vols.reduce((a,b)=>a+b,0)/vols.length;
        const volRatio = avgVol>0 ? last.volume/avgVol : 1;
        const vp = calcVP(w);
        windowMetrics[sym] = { price:last.close, change1h, change4h, change24h, volRatio, hnVolRatio:volRatio, quoteVol24h:999_999_999, vp, volQuality:{volQuality:50}, tfData:{tfScore:70,tfAligned:true}, structData:{structScore:60}, entryData:{timingScore:60}, c1h:w, c4h:w, c1d:w };
      }
      // Detect sector signals at this point in time
      const sigs = detectSectorRotation(windowMetrics, {altMultiplier:1.0}, []);
      if (sigs.length > 0) {
        // Check outcome: did the coin's price increase in the next candle?
        const outcomes = sigs.slice(0,5).map(sig => {
          const nextCandle = allCandles[sig.symbol]?.[i+1];
          if (!nextCandle) return null;
          const pctMove = ((nextCandle.close - sig.price) / sig.price) * 100;
          return { symbol:sig.symbol, score:sig.score, stage:sig.breakout?.stage, pctMove:parseFloat(pctMove.toFixed(2)), win:pctMove>0.5 };
        }).filter(Boolean);
        if (outcomes.length > 0) {
          results.push({ date:new Date(btcCandles[i]?.time||Date.now()).toISOString().slice(0,13), signalCount:sigs.length, outcomes, winRate:Math.round(outcomes.filter(o=>o.win).length/outcomes.length*100) });
        }
      }
    }
  } catch (e) { console.log('[BACKTEST] Error:', e.message); }
  backtestRunning = false;
  // Aggregate stats
  const totalSignals = results.reduce((a,r)=>a+r.signalCount,0);
  const allOutcomes  = results.flatMap(r=>r.outcomes);
  const winRate      = allOutcomes.length>0 ? Math.round(allOutcomes.filter(o=>o.win).length/allOutcomes.length*100) : 0;
  const byStage = {};
  allOutcomes.forEach(o=>{ if(!byStage[o.stage])byStage[o.stage]={total:0,wins:0}; byStage[o.stage].total++; if(o.win)byStage[o.stage].wins++; });
  backtestCache = { completed:true, ts:new Date().toISOString(), totalSignals, totalOutcomes:allOutcomes.length, overallWinRate:winRate, byStage, recentResults:results.slice(-20) };
  console.log(`[BACKTEST] Done. ${totalSignals} signals, ${winRate}% win rate`);
  return backtestCache;
}

// ── Alert ─────────────────────────────────────────────────────────────────────
function pruneAlerts(){const n=Date.now();for(const[k,t]of alertedSignals)if(n-t>ALERT_TTL_MS)alertedSignals.delete(k);}
function alertSignal(sig,regime,session){
  pruneAlerts();
  const key=`${sig.type}-${sig.symbol}-${sig.leader}`;
  if(alertedSignals.has(key))return;
  alertedSignals.set(key,Date.now());
  const re={RISK_ON:'🟢',RISK_OFF:'🔴',NEUTRAL:'🟡'}[regime?.regime]||'⚪';
  const sb=sig.scoreBreakdown||{};
  sendTelegram([
    `${sig.confirmed?'⚡':'🔄'} <b>${sig.confirmed?'MULTI-CONFIRMED':'ROTATION'}</b> ${re} <b>${regime?.subMode||'—'}</b> ${session?.label||''}`,
    `🎯 <b>${sig.symbol.replace('USDT','')}</b> ← <b>${sig.leader.replace('USDT','')}</b>`,
    `📊 +${sig.leaderGain}% → own ${sig.ownChange1h>=0?'+':''}${sig.ownChange1h}% | lag ${sig.lag}%`,
    `📐 Stage: <b>${sig.breakout?.stage}</b> | Entry: ${sig.entryData?.timing||'—'}`,
    `${sig.bybitData?.crossConfirmed?'✅ BYBIT CONFIRMED':''}${sig.whale?.whaleBullish?' 🐋 WHALE BULLISH':''}`,
    `💪 Score: <b>${sig.score}%</b> | R/R: ${sig.rr||'—'}x`,
    `🚫 Invalidation: $${sig.breakout?.invalidation||'—'}`,
  ].filter(Boolean).join('\n')).catch(console.error);
}

// ── Alert top 3 ───────────────────────────────────────────────────────────────
function alertTop3(top3, regime, session) {
  if (!top3.length) return;
  const msg = [
    `🏆 <b>TOP 3 PICKS</b> ${session?.label||''} ${regime?.subMode||''}`,
    '',
    ...top3.map((s,i)=>`${['🥇','🥈','🥉'][i]} <b>${s.symbol.replace('USDT','')}</b> ${s.score}% · ${s.stage} · ${s.entryTiming||'—'}\n   ${s.whyThisOne}`),
  ].join('\n');
  sendTelegram(msg).catch(()=>{});
}

// ── Background scan ───────────────────────────────────────────────────────────
async function runScan() {
  if (scanInProgress){console.log('[SCAN] Already running');return;}
  scanInProgress=true; rotationCache.scanning=true;
  console.log(`[SCAN START] ${ALL_SYMBOLS.length} symbols`);

  // Session + BTC funding
  const session = getMarketSession();
  const btcFunding = await fetchBTCFunding();
  console.log(`[SESSION] ${session.session} | minScore:${session.minScore}`);

  // Regime
  let regime=null;
  try {
    const [b1h,b4h,e4h]=await Promise.all([fetchKlines('BTCUSDT','1h',60),fetchKlines('BTCUSDT','4h',20),fetchKlines('ETHUSDT','4h',20)]);
    regime=assessRegime(b1h,b4h,e4h,btcFunding);
    console.log(`[REGIME] ${regime.subMode} mult:${regime.altMultiplier} frDanger:${regime.frDanger}`);
  } catch(e){console.log('[WARN] Regime:',e.message);}

  // Whale alerts
  const whaleAlerts=await fetchWhaleAlerts();

  // Scan coins
  const newMetrics={};
  for(let i=0;i<ALL_SYMBOLS.length;i+=4){
    const batch=ALL_SYMBOLS.slice(i,i+4);
    await Promise.allSettled(batch.map(async sym=>{
      try {
        const [c1h,c4h,c1d]=await Promise.all([fetchKlines(sym,'1h',168),fetchKlines(sym,'4h',20),fetchKlines(sym,'1d',5)]);
        const last=c1h[c1h.length-1],open1h=c1h[c1h.length-2]?.close||c1h[0].open;
        const first4h=c4h[c4h.length-2]?.close||c4h[0].open,first24h=c1d[c1d.length-2]?.close||c1d[0].open;
        const change1h=((last.close-open1h)/open1h)*100,change4h=((last.close-first4h)/first4h)*100,change24h=((last.close-first24h)/first24h)*100;
        const rv=c1h.slice(-21,-1).map(c=>c.volume),avgVol=rv.reduce((a,b)=>a+b,0)/rv.length,volRatio=avgVol>0?last.volume/avgVol:1;
        const quoteVol24h=c1h.slice(-24).reduce((a,c)=>a+c.quoteVol,0);
        if(quoteVol24h<MIN_QUOTE_VOL_24H*0.5)return;
        const vp=calcVP(c1h),volQuality=assessVolumeQuality(c1h);
        const tfData=timeframeAlignment(change1h,change4h,volRatio);
        const structData=candleStructureScore(c1h);
        const entryData=entryTiming(c1h,vp);
        const {hnVolRatio,normalized}=hourNormalizedVolRatio(c1h);
        const btcRef=newMetrics['BTCUSDT'];
        const rsData=btcRef?relStrengthVsBTC(change1h,change4h,btcRef.change1h,btcRef.change4h):{rs1h:0,rs4h:0,rsScore:50};
        newMetrics[sym]={price:last.close,change1h,change4h,change24h,volRatio,hnVolRatio,hnNormalized:normalized,quoteVol24h,vp,volQuality,tfData,structData,entryData,rsData,c1h,c4h,c1d};
      } catch(e){console.log(`[WARN] ${sym}:${e.message}`);}
    }));
    await new Promise(r=>setTimeout(r,350));
  }

  await checkOutcomes(newMetrics);

  const sS=detectSectorRotation(newMetrics,regime,whaleAlerts);
  const cS=detectCorrelationDivergence(newMetrics,regime,whaleAlerts);
  const vS=detectVolumeFlow(newMetrics,regime,whaleAlerts);
  const all=[...sS,...cS,...vS].sort((a,b)=>b.score-a.score);

  // Dedup by symbol
  const bySymbol=new Map();
  for(const s of all){if(!bySymbol.has(s.symbol))bySymbol.set(s.symbol,[]);bySymbol.get(s.symbol).push(s);}
  const deduped=[];
  for(const[,sigs]of bySymbol){
    sigs.sort((a,b)=>b.score-a.score);
    const best={...sigs[0]};
    const allTypes=[...new Set(sigs.map(s=>s.type))],confirmed=allTypes.length>1;
    if(confirmed)best.score=Math.min(100,best.score+8);
    best.confirmedTypes=allTypes;best.confirmed=confirmed;
    best.allNarratives=sigs.map(s=>`[${s.type}] ${s.narrative}`);
    if(confirmed)best.narrative=`⚡ MULTI-CONFIRMED (${allTypes.join('+')}): ${best.narrative}`;
    deduped.push(best);
  }
  deduped.sort((a,b)=>b.score-a.score);

  // Futures for top 15
  await Promise.allSettled(deduped.slice(0,15).map(async sig=>{
    try {
      const fut=await fetchFuturesData(sig.symbol);
      const {futuresScore,futuresLabel,fundingRate}=scoreFutures(fut);
      sig.futuresScore=futuresScore;sig.futuresLabel=futuresLabel;sig.fundingRate=fundingRate;
      if(fundingRate!==null&&fundingRate>0.1)sig.score=Math.max(0,sig.score-10);
    } catch{sig.futuresLabel='—';}
  }));

  // #5 Bybit cross-confirmation for top 10
  await Promise.allSettled(deduped.slice(0,10).map(async sig=>{
    try { sig.bybitData=await crossConfirmBybit(sig,newMetrics); } catch{}
  }));

  // Record
  deduped.slice(0,25).forEach(s=>recordSignal(s));

  // Top 3 picks
  const top3 = computeTop3(deduped, regime, session);

  // Alert
  deduped.slice(0,8).forEach(s=>alertSignal(s,regime,session));
  if (top3.length) alertTop3(top3, regime, session);

  // Sector summary
  const sectorSummary={};
  Object.entries(SECTORS).forEach(([sector,coins])=>{
    const cd=coins.filter(s=>newMetrics[s]).map(s=>({sym:s,...newMetrics[s]}));
    if(!cd.length)return;
    const a1=cd.reduce((a,c)=>a+c.change1h,0)/cd.length,a4=cd.reduce((a,c)=>a+c.change4h,0)/cd.length;
    const maxVol=Math.max(...cd.map(c=>c.volRatio)),ldr=cd.sort((a,b)=>b.change1h-a.change1h)[0];
    sectorSummary[sector]={avgChange1h:parseFloat(a1.toFixed(3)),avgChange4h:parseFloat(a4.toFixed(3)),maxVolRatio:parseFloat(maxVol.toFixed(2)),leader:ldr.sym,coins:cd.length};
  });

  // Strip raw candles
  const lightMetrics={};
  for(const[sym,m]of Object.entries(newMetrics)){const{c1h,c4h,c1d,...rest}=m;lightMetrics[sym]=rest;}

  rotationCache={signals:deduped,metrics:lightMetrics,sectors:sectorSummary,regime,session,top3,hitStats:getHitRateStats(),graveyard:graveyard.slice(0,40),ts:new Date().toISOString(),scanning:false,coinCount:Object.keys(newMetrics).length,btcFunding};
  scanInProgress=false;
  console.log(`[SCAN DONE] ${Object.keys(newMetrics).length} coins, ${deduped.length} signals, top3:${top3.length} | ${regime?.subMode} | ${session.session}`);
  sendTelegram([`🔄 <b>Rotation v5 Complete</b>`,`📊 ${regime?.subMode||'—'} | ${session.label}`,`${Object.keys(newMetrics).length} coins · ${deduped.length} sigs · Top3:${top3.length}`].join('\n')).catch(()=>{});
}

async function fetchKlines(symbol,interval,limit=60){const raw=await fetchBinance(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);return raw.map(k=>({time:parseInt(k[0]),open:parseFloat(k[1]),high:parseFloat(k[2]),low:parseFloat(k[3]),close:parseFloat(k[4]),volume:parseFloat(k[5]),quoteVol:parseFloat(k[7]),takerBuy:parseFloat(k[9]),takerBuyQuote:parseFloat(k[10])}));}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function setCORS(res){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');}
const ipMap=new Map();
function isRateLimited(ip,lim=30){const n=Date.now(),e=ipMap.get(ip)||{count:0,reset:n+60000};if(n>e.reset){e.count=0;e.reset=n+60000;}e.count++;ipMap.set(ip,e);return e.count>lim;}
setInterval(()=>{const n=Date.now();for(const[ip,e]of ipMap)if(n>e.reset)ipMap.delete(ip);},5*60*1000);

const server=http.createServer(async(req,res)=>{
  setCORS(res);
  if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
  const parsed=url.parse(req.url,true),pn=parsed.pathname;
  const clientIP=req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown';

  if(pn==='/'||pn==='/index.html'){
    const hp=path.join(__dirname,'rotation.html');
    if(!fs.existsSync(hp)){res.writeHead(404);return res.end('rotation.html not found');}
    res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});
    return res.end(fs.readFileSync(hp));
  }
  if(pn==='/api/rotation'){
    res.writeHead(200,{'Content-Type':'application/json'});
    return res.end(JSON.stringify({ok:true,signals:rotationCache.signals||[],metrics:rotationCache.metrics||{},sectors:rotationCache.sectors||{},regime:rotationCache.regime||null,session:rotationCache.session||null,top3:rotationCache.top3||[],hitStats:rotationCache.hitStats||null,graveyard:rotationCache.graveyard||[],btcFunding:rotationCache.btcFunding||null,ts:rotationCache.ts||new Date().toISOString(),scanning:rotationCache.scanning||false,coinCount:rotationCache.coinCount||0}));
  }
  if(pn==='/api/trigger-scan'){
    if(isRateLimited(clientIP,5)){res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:false,message:'Too many requests'}));}
    if(scanInProgress){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:false,message:'Already scanning'}));}
    runScan().catch(console.error);
    res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,message:'Scan started'}));
  }
  if(pn==='/api/sectors'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,sectors:rotationCache.sectors||{}}));}
  if(pn==='/api/hitstats'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,...getHitRateStats()}));}
  if(pn==='/api/graveyard'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,graveyard:graveyard.slice(0,40)}));}
  if(pn==='/api/top3'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,top3:rotationCache.top3||[]}));}
  if(pn==='/api/backtest'){
    if(backtestRunning){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:false,running:true,message:'Backtest in progress…'}));}
    if(backtestCache){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,...backtestCache}));}
    runBacktest().then(result=>{}).catch(console.error);
    res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,running:true,message:'Backtest started, check back in 60s'}));
  }
  if(pn==='/api/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,coinCount:rotationCache.coinCount,ts:rotationCache.ts,scanning:scanInProgress,regime:rotationCache.regime?.subMode,session:rotationCache.session?.session,btcFunding:rotationCache.btcFunding?.rate}));}
  res.writeHead(404);res.end('Not found');
});

server.listen(PORT,HOST,()=>{
  console.log(`ROTATION SCREENER v5 on ${HOST}:${PORT}`);
  if(!TG_TOKEN)console.warn('[WARN] TG_TOKEN not set');
  if(!WHALE_API_KEY)console.warn('[WARN] WHALE_API_KEY not set');
  sendTelegram('🟢 <b>ROTATION SCREENER v5 ONLINE</b>\nLive invalidation · Top 3 · BTC FR · Sessions · Bybit · Backtest').catch(()=>{});
  setTimeout(()=>runScan().catch(console.error),3000);
  setInterval(()=>runScan().catch(console.error),10*60*1000);
  startLivePricePoller(); // #1 live invalidation every 60s
});
