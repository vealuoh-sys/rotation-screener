/**
 * ROTATION SCREENER v4 — server.js
 * ════════════════════════════════════════════════════════════════
 * Improvement 1:  Timeframe alignment (1h + 4h must agree)
 * Improvement 2:  Candle structure check (higher lows, body quality)
 * Improvement 3:  Isolated pump detection (leader vs peer volume)
 * Improvement 4:  Hour-normalized volume baseline
 * Improvement 5:  Rolling correlation coefficient validation
 * Improvement 6:  Signal graveyard (failed signal tracking)
 * Improvement 7:  Refined regime sub-modes (6 modes)
 * Improvement 8:  Entry timing + confirmation candle detection
 * Improvement 9:  Whale Alert API integration (free tier)
 * Phase 4:        Futures confirmation + 24h liquidity filter
 * Phase 5:        Hit rate tracker
 * ════════════════════════════════════════════════════════════════
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const url   = require('url');

const PORT     = process.env.PORT || 3001;
const HOST     = '0.0.0.0';
const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_CHAT  = process.env.TG_CHAT  || '';
const WHALE_API_KEY = process.env.WHALE_API_KEY || ''; // free at whaleapi.io

const MIN_QUOTE_VOL_24H = 2_000_000; // $2M minimum daily volume

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

// ── Correlation pairs ─────────────────────────────────────────────────────────
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

// ── Sub-narratives ────────────────────────────────────────────────────────────
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

// ── Cap tiers ─────────────────────────────────────────────────────────────────
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

// ── In-memory state ───────────────────────────────────────────────────────────
let rotationCache = { signals:[],graveyard:[],ts:null,scanning:false,coinCount:0,regime:null };
let scanInProgress = false;
const ALERT_TTL_MS = 15*60*1000;
const alertedSignals = new Map();

// ── Improvement 6: Signal graveyard ──────────────────────────────────────────
// Tracks signals that fired and checks outcome. Failed = moved against by >1%
const graveyard = [];     // { signal, generatedAt, outcome, pctMove, resolved }
const MAX_GRAVEYARD = 50;

// ── Phase 5: Hit Rate Tracker ─────────────────────────────────────────────────
const hitTracker = new Map();

function recordSignal(sig) {
  const key = `${sig.symbol}-${sig.type}-${Date.now()}`;
  hitTracker.set(key, {
    sig:{ symbol:sig.symbol, price:sig.price, type:sig.type, score:sig.score, sector:sig.sector },
    generatedAt:Date.now(), outcomes:{},
  });
  // Also record in graveyard for explicit tracking
  graveyard.unshift({ symbol:sig.symbol, type:sig.type, score:sig.score,
    sector:sig.sector, entryPrice:sig.price, generatedAt:Date.now(),
    outcome:null, pctMove:null, stage:sig.breakout?.stage });
  if (graveyard.length > MAX_GRAVEYARD) graveyard.pop();
}

async function checkOutcomes(metrics) {
  const now = Date.now();
  // Update hit tracker
  for (const [key,entry] of hitTracker) {
    const age=now-entry.generatedAt, m=metrics[entry.sig.symbol];
    if (!m) continue;
    const pct=((m.price-entry.sig.price)/entry.sig.price)*100;
    if (age>=15*60*1000  && entry.outcomes['15m']===undefined) entry.outcomes['15m']=parseFloat(pct.toFixed(2));
    if (age>=60*60*1000  && entry.outcomes['1h'] ===undefined) entry.outcomes['1h'] =parseFloat(pct.toFixed(2));
    if (age>=4*60*60*1000 && entry.outcomes['4h']===undefined) entry.outcomes['4h'] =parseFloat(pct.toFixed(2));
    if (age>24*60*60*1000) hitTracker.delete(key);
  }
  // Update graveyard outcomes
  for (const entry of graveyard) {
    if (entry.outcome) continue;
    const age=now-entry.generatedAt, m=metrics[entry.symbol];
    if (!m) continue;
    const pct=((m.price-entry.entryPrice)/entry.entryPrice)*100;
    entry.pctMove=parseFloat(pct.toFixed(2));
    // Resolve after 4h: win if +1%, fail if -1%, pending otherwise
    if (age>=4*60*60*1000) {
      entry.outcome = pct >= 1 ? 'WIN' : pct <= -1 ? 'FAIL' : 'NEUTRAL';
      entry.resolvedAt = now;
    }
  }
}

function getHitRateStats() {
  const stats={ byType:{SECTOR:{total:0,win15m:0,win1h:0,win4h:0},CORR:{total:0,win15m:0,win1h:0,win4h:0},VOLFLOW:{total:0,win15m:0,win1h:0,win4h:0}}, overall:{total:0,win15m:0,win1h:0,win4h:0}, recent:[] };
  for (const [,entry] of hitTracker) {
    const {sig,outcomes,generatedAt}=entry;
    if (!stats.byType[sig.type]) stats.byType[sig.type]={total:0,win15m:0,win1h:0,win4h:0};
    stats.byType[sig.type].total++; stats.overall.total++;
    if (outcomes['15m']>0){ stats.byType[sig.type].win15m++; stats.overall.win15m++; }
    if (outcomes['1h'] >0){ stats.byType[sig.type].win1h++;  stats.overall.win1h++;  }
    if (outcomes['4h'] >0){ stats.byType[sig.type].win4h++;  stats.overall.win4h++;  }
    if (Date.now()-generatedAt<6*60*60*1000) stats.recent.push({symbol:sig.symbol,type:sig.type,score:sig.score,outcomes,generatedAt});
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
        headers:{'User-Agent':'RotationScreener/4.0','Accept':'application/json'},timeout:12000},res=>{
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

async function fetchKlines(symbol, interval, limit=60) {
  const raw=await fetchBinance(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return raw.map(k=>({
    time:parseInt(k[0]),open:parseFloat(k[1]),high:parseFloat(k[2]),
    low:parseFloat(k[3]),close:parseFloat(k[4]),volume:parseFloat(k[5]),
    quoteVol:parseFloat(k[7]),takerBuy:parseFloat(k[9]),takerBuyQuote:parseFloat(k[10]),
  }));
}

// ── Improvement 9: Whale Alert ────────────────────────────────────────────────
let whaleCache = { alerts:[], ts:0 };
async function fetchWhaleAlerts() {
  if (!WHALE_API_KEY) return [];
  if (Date.now()-whaleCache.ts < 5*60*1000) return whaleCache.alerts; // 5-min cache
  try {
    const data = await new Promise((resolve,reject)=>{
      const req=https.request({
        hostname:'api.whale-alert.io', method:'GET',
        path:`/v1/transactions?api_key=${WHALE_API_KEY}&min_value=1000000&limit=20`,
        headers:{'Accept':'application/json'}, timeout:8000,
      },res=>{
        const chunks=[];
        res.on('data',c=>chunks.push(c));
        res.on('end',()=>{ try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(); }});
      });
      req.on('error',reject); req.on('timeout',()=>{req.destroy();reject();});
      req.end();
    });
    const alerts=(data.transactions||[]).map(t=>({
      symbol:(t.symbol||'').toUpperCase()+'USDT',
      amount:t.amount_usd||0,
      from:t.from?.owner_type||'unknown',
      to:t.to?.owner_type||'unknown',
      bullish: t.to?.owner_type==='wallet' && t.from?.owner_type==='exchange', // exchange→wallet = bullish withdrawal
      bearish: t.from?.owner_type==='wallet' && t.to?.owner_type==='exchange', // wallet→exchange = bearish deposit
    }));
    whaleCache={ alerts, ts:Date.now() };
    return alerts;
  } catch { return []; }
}

function getWhaleSignal(symbol, whaleAlerts) {
  const sym=symbol.replace('USDT','').toLowerCase();
  const relevant=whaleAlerts.filter(a=>a.symbol===symbol||a.symbol===sym.toUpperCase()+'USDT');
  if (!relevant.length) return { whaleScore:50, whaleLabel:'NO DATA', whaleBullish:false };
  const bullish=relevant.filter(a=>a.bullish).length;
  const bearish=relevant.filter(a=>a.bearish).length;
  const score = bullish>bearish ? Math.min(100,60+bullish*15) : bearish>bullish ? Math.max(0,40-bearish*15) : 50;
  const label = bullish>bearish ? `🐋 ${bullish} WITHDRAWALS (BULLISH)` : bearish>bullish ? `🐋 ${bearish} DEPOSITS (BEARISH)` : '🐋 NEUTRAL';
  return { whaleScore:score, whaleLabel:label, whaleBullish:bullish>bearish };
}

// ── Phase 4: Futures ──────────────────────────────────────────────────────────
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
  if (!fut||fut.fundingRate===null) return { futuresScore:50, futuresLabel:'NO FUTURES DATA' };
  const fr=fut.fundingRate;
  let score=70;
  if (fr>0.10) score-=35; else if (fr>0.05) score-=15;
  else if (fr<-0.05) score-=20;
  else if (fr>=-0.01&&fr<=0.03) score+=20;
  const label=fr>0.10?`FR:${fr.toFixed(3)}% ⚠ CROWDED`:fr<-0.05?`FR:${fr.toFixed(3)}% ⚠ SHORT`:`FR:${fr.toFixed(3)}% ✓`;
  return { futuresScore:Math.min(100,Math.max(0,score)), futuresLabel:label, fundingRate:fr };
}

// ── EMA ───────────────────────────────────────────────────────────────────────
function calcEMA(candles, period) {
  if (candles.length<period) return candles[candles.length-1].close;
  let sum=0; for(let i=0;i<period;i++) sum+=candles[i].close;
  let ema=sum/period; const k=2/(period+1);
  for(let i=period;i<candles.length;i++) ema=candles[i].close*k+ema*(1-k);
  return ema;
}

// ── Improvement 5: Rolling Pearson Correlation ───────────────────────────────
// Validates CORR pairs actually moved together recently (last N candles)
function rollingCorrelation(candlesA, candlesB, period=14) {
  const n=Math.min(candlesA.length, candlesB.length, period);
  if (n<6) return 0;
  const a=candlesA.slice(-n).map(c=>c.close);
  const b=candlesB.slice(-n).map(c=>c.close);
  const meanA=a.reduce((s,v)=>s+v,0)/n;
  const meanB=b.reduce((s,v)=>s+v,0)/n;
  let num=0,dA=0,dB=0;
  for(let i=0;i<n;i++){
    const da=a[i]-meanA, db=b[i]-meanB;
    num+=da*db; dA+=da*da; dB+=db*db;
  }
  const denom=Math.sqrt(dA*dB);
  return denom===0?0:parseFloat((num/denom).toFixed(3));
}

// ── Improvement 7: Refined regime sub-modes ──────────────────────────────────
// 6 distinct modes based on BTC trend, ETH/BTC ratio, BTC dominance proxy
function assessRegime(btc1h, btc4h, eth4h) {
  const lastBtc=btc1h[btc1h.length-1].close;
  const lastBtc4=btc4h[btc4h.length-1].close;
  const lastEth4=eth4h[eth4h.length-1].close;

  const btcEma20_1h=calcEMA(btc1h,20), btcEma50_1h=calcEMA(btc1h,50);
  const btcEma20_4h=calcEMA(btc4h,20), btcEma50_4h=calcEMA(btc4h,50);

  const btcTrend1h=lastBtc>btcEma20_1h&&btcEma20_1h>btcEma50_1h?'UP':lastBtc<btcEma20_1h&&btcEma20_1h<btcEma50_1h?'DOWN':'NEUTRAL';
  const btcTrend4h=lastBtc4>btcEma20_4h&&btcEma20_4h>btcEma50_4h?'UP':lastBtc4<btcEma20_4h&&btcEma20_4h<btcEma50_4h?'DOWN':'NEUTRAL';

  const btcChange4h=((lastBtc4-btc4h[0].close)/btc4h[0].close)*100;
  const ethChange4h=((lastEth4-eth4h[0].close)/eth4h[0].close)*100;
  const ethBtcRatio=ethChange4h-btcChange4h; // positive = ETH outperforming
  const ethBtcTrend=ethBtcRatio>0.5?'RISING':ethBtcRatio<-0.5?'FALLING':'FLAT';

  // BTC making new highs in 4h window
  const btc4hHigh=Math.max(...btc4h.slice(0,-1).map(c=>c.high));
  const btcNewHigh=lastBtc4>btc4hHigh;

  // Determine sub-mode
  let subMode, altMultiplier, description;
  if (btcTrend4h==='UP'&&btcNewHigh&&ethBtcTrend!=='FALLING') {
    subMode='AGGRESSIVE_ALT'; altMultiplier=1.10;
    description='BTC new highs + ETH holding → High beta alts, aggressive rotation';
  } else if (btcTrend4h==='UP'&&!btcNewHigh&&ethBtcTrend==='RISING') {
    subMode='ETH_LED'; altMultiplier=1.05;
    description='ETH outperforming → DeFi/ETH ecosystem rotation favoured';
  } else if (btcTrend4h==='UP'&&!btcNewHigh) {
    subMode='RISK_ON'; altMultiplier=1.00;
    description='BTC uptrend consolidating → Mid-cap rotation only';
  } else if (btcTrend4h==='NEUTRAL'&&ethBtcTrend==='RISING') {
    subMode='ETH_ROTATION'; altMultiplier=0.90;
    description='BTC flat, ETH leading → ETH ecosystem only, avoid others';
  } else if (btcTrend4h==='NEUTRAL') {
    subMode='NEUTRAL'; altMultiplier=0.80;
    description='BTC choppy → Selective only, high score threshold';
  } else if (btcTrend4h==='DOWN'&&btcTrend1h==='DOWN') {
    subMode='RISK_OFF'; altMultiplier=0.50;
    description='BTC downtrend confirmed → Avoid alts, high caution';
  } else {
    subMode='CAUTION'; altMultiplier=0.65;
    description='Mixed signals → Only multi-confirmed high-score signals';
  }

  const regime=subMode==='RISK_OFF'||subMode==='CAUTION'?'RISK_OFF':
    subMode==='NEUTRAL'||subMode==='ETH_ROTATION'?'NEUTRAL':'RISK_ON';

  return {
    regime, subMode, altMultiplier, description,
    btcTrend1h, btcTrend4h, ethBtcTrend, btcNewHigh,
    btcPrice:lastBtc,
    btcEma20:parseFloat(btcEma20_1h.toFixed(2)),
    btcEma50:parseFloat(btcEma50_1h.toFixed(2)),
    btcChange4h:parseFloat(btcChange4h.toFixed(2)),
    ethChange4h:parseFloat(ethChange4h.toFixed(2)),
    ethBtcRatio:parseFloat(ethBtcRatio.toFixed(2)),
  };
}

// ── Volume Profile ────────────────────────────────────────────────────────────
const VP_BINS=36;
function calcVP(candles) {
  if (!candles||candles.length<10) return null;
  let lo=Infinity,hi=-Infinity;
  candles.forEach(c=>{ if(c.high>hi)hi=c.high; if(c.low<lo)lo=c.low; });
  const range=hi-lo; if(!range) return null;
  const binSize=range/VP_BINS, vol=new Array(VP_BINS).fill(0);
  candles.forEach(c=>{ const t=(c.high+c.low+c.close)/3; vol[Math.min(Math.floor((t-lo)/binSize),VP_BINS-1)]+=c.volume; });
  let pocIdx=0; vol.forEach((v,i)=>{ if(v>vol[pocIdx])pocIdx=i; });
  const poc=lo+(pocIdx+0.5)*binSize, tv=vol.reduce((a,b)=>a+b,0);
  let vaVol=vol[pocIdx],vaLo=pocIdx,vaHi=pocIdx;
  while(vaVol<tv*0.70){
    const nL=vaLo>0?vol[vaLo-1]:0,nH=vaHi<VP_BINS-1?vol[vaHi+1]:0;
    if(nL>=nH&&vaLo>0){vaLo--;vaVol+=nL;}else if(vaHi<VP_BINS-1){vaHi++;vaVol+=nH;}else break;
  }
  return {poc,vah:lo+(vaHi+1)*binSize,val:lo+vaLo*binSize};
}

function vpProximityScore(price,vp) {
  if(!vp)return 30;
  const dL=Math.abs(price-vp.val)/vp.val*100,dP=Math.abs(price-vp.poc)/vp.poc*100,dH=Math.abs(price-vp.vah)/vp.vah*100;
  if(price<vp.val*0.98)return 5;
  if(dL<=0.8)return 100;if(dL<=2.0)return 85;
  if(dP<=0.8)return 65;if(dP<=2.0)return 50;
  if(dH<=1.0)return 40;
  return price>=vp.val&&price<=vp.vah?35:15;
}
function vpLevelLabel(price,vp) {
  if(!vp)return'—';
  const dL=Math.abs(price-vp.val)/vp.val*100,dP=Math.abs(price-vp.poc)/vp.poc*100,dH=Math.abs(price-vp.vah)/vp.vah*100;
  if(price<vp.val*0.98)return'BELOW VAL ⚠';
  if(dL<=2.0)return'AT VAL 🎯';if(dP<=2.0)return'AT POC ◆';if(dH<=1.5)return'AT VAH 🔴';
  if(price>=vp.val&&price<=vp.vah)return'IN VALUE';return'ABOVE VAH';
}

// ── Improvement 1: Timeframe alignment ───────────────────────────────────────
// Both 1h and 4h must show similar direction for the rotation to be valid.
// Returns score 0-100 and a boolean for whether they're aligned.
function timeframeAlignment(change1h, change4h, volRatio1h) {
  // Both pointing same direction = aligned
  const aligned = (change1h>0&&change4h>-1) || (change1h<-0.5&&change4h<-0.5);
  // 4h not in strong downtrend while 1h shows rotation
  const noConflict = !(change1h>0.5 && change4h<-3);
  let score=50;
  if (aligned) score+=30;
  if (noConflict) score+=20;
  if (change4h>0&&change1h>0) score+=10; // both positive = strongest
  if (change4h<-3) score-=30; // 4h strong downtrend = suppress
  return { tfScore:Math.min(100,Math.max(0,score)), tfAligned:aligned&&noConflict };
}

// ── Improvement 2: Candle structure check ────────────────────────────────────
// Checks if the laggard is forming higher lows (accumulation) not lower highs (distribution).
function candleStructureScore(candles1h) {
  const last5=candles1h.slice(-5);
  if(last5.length<3) return { structScore:50, structLabel:'INSUFFICIENT DATA' };

  const last=last5[last5.length-1];
  const prev=last5[last5.length-2];
  const prev2=last5[last5.length-3];

  // Higher lows pattern
  const higherLows=last.low>prev.low&&prev.low>prev2.low;
  // Current candle bullish body
  const bullishBody=last.close>last.open;
  // Closing in upper half of range
  const range=last.high-last.low;
  const closePos=range>0?(last.close-last.low)/range:0.5;
  const closingHigh=closePos>0.6;
  // No massive wicks up (rejection)
  const upperWick=last.high-Math.max(last.open,last.close);
  const noRejection=range>0?upperWick/range<0.4:true;
  // Volume on last 3 candles not declining (accumulation)
  const volExpanding=last5.length>=3&&last5[last5.length-1].volume>=last5[last5.length-2].volume*0.8;

  let score=40;
  if(higherLows)  score+=25;
  if(bullishBody) score+=15;
  if(closingHigh) score+=10;
  if(noRejection) score+=10;
  if(!volExpanding) score-=10;

  const label=score>=80?'STRONG ACCUM 💪':score>=60?'MILD ACCUM':score>=40?'NEUTRAL':'DISTRIBUTING ⚠';
  return { structScore:Math.min(100,Math.max(0,score)), structLabel:label, higherLows, bullishBody };
}

// ── Improvement 3: Isolated pump detection ───────────────────────────────────
// Checks if peers in the sector also showed volume — if only one coin moved
// with zero peer activity, it was likely news-driven (don't chase rotation).
function isIsolatedPump(leader, sectorCoins, metrics) {
  const leaderMetrics=metrics[leader];
  if(!leaderMetrics) return { isolated:false, peerActivity:0 };
  const peers=sectorCoins.filter(s=>s!==leader&&metrics[s]);
  if(peers.length===0) return { isolated:false, peerActivity:0 };
  // How many peers showed above-average volume?
  const activepeers=peers.filter(s=>metrics[s].volRatio>1.3).length;
  const peerActivity=parseFloat((activepeers/peers.length*100).toFixed(0));
  // If leader has huge vol spike but NO peers active = isolated
  const isolated=leaderMetrics.volRatio>2.5&&activepeers===0;
  return { isolated, peerActivity, activepeers, totalPeers:peers.length };
}

// ── Improvement 4: Hour-normalized volume ────────────────────────────────────
// Instead of comparing to plain 20-candle average, compare to same hour
// across last 7 days. Requires 168+ candles (7 days of 1h data).
function hourNormalizedVolRatio(candles1h) {
  if(candles1h.length<48) {
    // Fall back to plain ratio if not enough history
    const last=candles1h[candles1h.length-1];
    const avg=candles1h.slice(-21,-1).reduce((a,c)=>a+c.volume,0)/20;
    return { hnVolRatio:avg>0?parseFloat((last.volume/avg).toFixed(2)):1, normalized:false };
  }
  const last=candles1h[candles1h.length-1];
  const currentHour=new Date(last.time).getUTCHours();
  // Find same hour across past 7 days
  const sameHourCandles=candles1h.slice(0,-1).filter(c=>new Date(c.time).getUTCHours()===currentHour);
  if(sameHourCandles.length<3) {
    const avg=candles1h.slice(-21,-1).reduce((a,c)=>a+c.volume,0)/20;
    return { hnVolRatio:avg>0?parseFloat((last.volume/avg).toFixed(2)):1, normalized:false };
  }
  const avgSameHour=sameHourCandles.reduce((a,c)=>a+c.volume,0)/sameHourCandles.length;
  return { hnVolRatio:avgSameHour>0?parseFloat((last.volume/avgSameHour).toFixed(2)):1, normalized:true };
}

// ── Improvement 8: Entry timing ───────────────────────────────────────────────
// Checks if the current candle is confirming entry or still needs to confirm.
// A confirmation candle = current 1h candle closed above previous high.
function entryTiming(candles1h, vp) {
  const last=candles1h[candles1h.length-1];
  const prev=candles1h[candles1h.length-2];
  const prev2=candles1h[candles1h.length-3];

  // Confirmation: closed above previous candle's high
  const confirmationCandle=last.close>prev.high;
  // Early entry: price at/near VAL and turning up
  const atSupport=vp&&Math.abs(last.close-vp.val)/vp.val<0.02;
  // Still forming: current candle not yet closed bullishly
  const forming=last.close<=prev.high&&last.close>prev.low;
  // Time-based: how many candles since signal could have fired
  const candlesSinceBreak=prev.close<=(vp?.val||last.close*1.01)&&last.close>(vp?.val||0)?1:0;

  let timing, timingScore;
  if (confirmationCandle&&last.close>last.open) {
    timing='CONFIRMED ✓'; timingScore=90;
  } else if (atSupport&&last.close>last.open) {
    timing='EARLY ENTRY'; timingScore=80;
  } else if (forming) {
    timing='WAIT — FORMING'; timingScore=50;
  } else {
    timing='WAIT — NO SETUP'; timingScore=30;
  }

  // Invalidation: if price has already run 3%+ from potential entry, it's late
  const alreadyRan=prev2&&((last.close-prev2.low)/prev2.low*100)>3;
  if(alreadyRan&&timing==='CONFIRMED ✓') { timing='LATE ENTRY ⚠'; timingScore=40; }

  return { timing, timingScore, confirmationCandle, atSupport };
}

// ── Improvement 3: Breakout stage detection ──────────────────────────────────
function detectBreakoutStage(c1h,c4h,c1d,vp) {
  const price=c1h[c1h.length-1].close;
  const ema20=calcEMA(c1h,20), ema50=calcEMA(c1h,50);
  const p4hHigh=c4h.slice(0,-1).reduce((m,c)=>Math.max(m,c.high),-Infinity);
  const p4hLow =c4h.slice(0,-1).reduce((m,c)=>Math.min(m,c.low),Infinity);
  const pdHigh =c1d.length>=2?c1d[c1d.length-2].high:c1d[0].high;
  const pdLow  =c1d.length>=2?c1d[c1d.length-2].low :c1d[0].low;
  const resLevels=[p4hHigh,pdHigh,vp?.vah].filter(l=>l&&l>price);
  const supLevels=[p4hLow,pdLow,vp?.val,vp?.poc].filter(l=>l&&l<price);
  const nearestRes=resLevels.length>0?Math.min(...resLevels):null;
  const nearestSup=supLevels.length>0?Math.max(...supLevels):null;
  let stage,stageColor;
  if(price<ema20&&price<ema50&&price<(vp?.val||Infinity))               {stage='BELOW_STRUCTURE';stageColor='#FF5E3A';}
  else if(price>=(vp?.val||0)&&price<=ema20&&price<=(vp?.poc||Infinity)){stage='ACCUMULATION';   stageColor='#00FFB2';}
  else if(price>ema20&&price<=p4hHigh&&price<=(vp?.vah||Infinity))     {stage='PRE_BREAKOUT';   stageColor='#FFD700';}
  else if(price>p4hHigh&&price<=pdHigh)                                 {stage='BREAKOUT_CONFIRMED';stageColor='#00BFFF';}
  else if(price>pdHigh)                                                  {stage='CHASE_RISK';     stageColor='#FF9500';}
  else                                                                    {stage='IN_RANGE';       stageColor='#B8D4E8';}
  return {
    stage,stageColor,
    ema20:parseFloat(ema20.toFixed(6)),ema50:parseFloat(ema50.toFixed(6)),
    p4hHigh:parseFloat(p4hHigh.toFixed(6)),pdHigh:parseFloat(pdHigh.toFixed(6)),
    nearestRes:nearestRes?parseFloat(nearestRes.toFixed(6)):null,
    nearestSup:nearestSup?parseFloat(nearestSup.toFixed(6)):null,
    invalidation:nearestSup?parseFloat((nearestSup*0.99).toFixed(6)):null,
    doNotChaseAbove:nearestRes?parseFloat((nearestRes*0.995).toFixed(6)):null,
  };
}

// ── Volume quality ────────────────────────────────────────────────────────────
function assessVolumeQuality(c1h) {
  const last3=c1h.slice(-3),last=last3[last3.length-1];
  const buyRatio=last.volume>0?last.takerBuy/last.volume:0.5;
  const body=Math.abs(last.close-last.open),range=last.high-last.low;
  const bodyRatio=range>0?body/range:0;
  const closePos=range>0?(last.close-last.low)/range:0.5;
  const expanding=last3.length===3&&last3[1].volume>last3[0].volume&&last3[2].volume>last3[1].volume;
  let q=40;
  if(buyRatio>0.6)q+=20;if(bodyRatio>0.6)q+=15;if(closePos>0.7)q+=15;if(expanding)q+=10;
  return {
    buyRatio:parseFloat(buyRatio.toFixed(2)),bodyRatio:parseFloat(bodyRatio.toFixed(2)),
    closePos:parseFloat(closePos.toFixed(2)),expanding,volQuality:Math.min(100,q),
    volQualityLabel:q>=80?'STRONG 💪':q>=60?'GOOD ✓':q>=40?'AVERAGE':'WEAK ⚠',
  };
}

// ── Relative strength vs BTC ──────────────────────────────────────────────────
function relStrengthVsBTC(coinC1h,coinC4h,btcC1h,btcC4h) {
  const rs1h=coinC1h-btcC1h, rs4h=coinC4h-btcC4h;
  return { rs1h:parseFloat(rs1h.toFixed(2)), rs4h:parseFloat(rs4h.toFixed(2)), rsScore:Math.min(100,Math.max(0,50+rs1h*5+rs4h*3)) };
}

// ── Momentum state ────────────────────────────────────────────────────────────
function momentumStateScore(c1h,c4h,c24h) {
  let s=70; const r=Math.abs(c24h);
  if(r>15)s-=40;else if(r>8)s-=20;else if(r>4)s-=8;else s+=15;
  if(Math.abs(c4h)<1.5&&Math.abs(c1h)>0.2)s+=15;
  if(c4h<-4)s-=25;
  return Math.min(100,Math.max(0,s));
}

// ── MASTER SCORING ENGINE v4 ──────────────────────────────────────────────────
// 12 factors now. Timeframe alignment + candle structure replace simpler proxies.
//
// Factor                     Weight  Source
// ──────────────────────────────────────────
// 1. Sub-narrative match       18%   ecosystem/use-case
// 2. Cap tier similarity       15%   market cap bracket
// 3. Momentum state            12%   24h/4h/1h combined
// 4. VP proximity              11%   price near VAL/POC
// 5. Timeframe alignment        9%   1h + 4h agree (NEW)
// 6. Candle structure           9%   higher lows, body (NEW)
// 7. Vol dryness (HN)           8%   hour-normalized vol (NEW)
// 8. Relative strength vs BTC   7%   outperforming market
// 9. Volume quality             5%   buy ratio, close pos
// 10. 4H trend health           4%   not in downtrend
// 11. Entry timing              2%   confirmation candle (NEW)
// (Regime multiplier + isolated pump penalty applied after)
function scoreCandidate(sym,leader,m,regime,btcC1h,btcC4h,isolated) {
  const narCount=sharedNarratives(sym,leader);
  const narScore =narCount>=2?100:narCount===1?65:20;
  const capScore =capTierScore(sym,leader);
  const momScore =momentumStateScore(m.change1h,m.change4h,m.change24h);
  const vpScore  =vpProximityScore(m.price,m.vp);
  const {tfScore,tfAligned}=m.tfData||{tfScore:50,tfAligned:true};
  const structScore=m.structData?.structScore||50;
  const volScore =m.hnVolRatio<0.8?100:m.hnVolRatio<1.2?80:m.hnVolRatio<1.8?45:m.hnVolRatio<2.5?20:5;
  const {rsScore}=relStrengthVsBTC(m.change1h,m.change4h,btcC1h||0,btcC4h||0);
  const vqScore  =m.volQuality?.volQuality||50;
  const trendScore=m.change4h>1?100:m.change4h>0?80:m.change4h>-2?55:m.change4h>-5?25:0;
  const timingScore=m.entryData?.timingScore||50;

  const composite=(
    narScore   *0.18+
    capScore   *0.15+
    momScore   *0.12+
    vpScore    *0.11+
    tfScore    *0.09+
    structScore*0.09+
    volScore   *0.08+
    rsScore    *0.07+
    vqScore    *0.05+
    trendScore *0.04+
    timingScore*0.02
  );

  // Regime multiplier
  let finalScore=composite*(regime?.altMultiplier||1.0);

  // Improvement 3: isolated pump penalty — if leader moved alone, reduce confidence
  if(isolated) finalScore*=0.65;

  // Timeframe conflict = hard cap at 55
  if(!tfAligned) finalScore=Math.min(finalScore,55);

  return {
    score:Math.min(100,Math.max(0,Math.round(finalScore))),
    scoreBreakdown:{
      narrative:Math.round(narScore), capTier:Math.round(capScore),
      momentum:Math.round(momScore),  vpLevel:Math.round(vpScore),
      tfAlign:Math.round(tfScore),    structure:Math.round(structScore),
      volDry:Math.round(volScore),    relStrength:Math.round(rsScore),
      volQuality:Math.round(vqScore), trend:Math.round(trendScore),
      timing:Math.round(timingScore),
    },
    vpLabel:m.vp?vpLevelLabel(m.price,m.vp):'—',
    vp:m.vp, narCount, capTierVal:capTier(sym),
    rs1h:m.rsData?.rs1h||0, rs4h:m.rsData?.rs4h||0,
    tfAligned,
  };
}

// ── Build signal object ───────────────────────────────────────────────────────
function buildSignal(baseType,sym,leader,sector,metrics,regime,isolated,whaleAlerts) {
  const m=metrics[sym], ml=metrics[leader], btcM=metrics['BTCUSDT'];
  const lag=ml.change1h-m.change1h;

  const scored=scoreCandidate(sym,leader,m,regime,btcM?.change1h||0,btcM?.change4h||0,isolated);
  const {score,scoreBreakdown,vpLabel,vp,narCount,capTierVal,rs1h,rs4h,tfAligned}=scored;

  const breakout=detectBreakoutStage(m.c1h,m.c4h,m.c1d,m.vp);
  const catchUpPct=parseFloat(lag.toFixed(2));
  const riskPct=breakout.invalidation?((m.price-breakout.invalidation)/m.price*100):Math.abs(m.change4h)||2;
  const rr=riskPct>0?parseFloat((catchUpPct/riskPct).toFixed(1)):null;
  const narLabel=narCount>=2?'🔥 SAME ECOSYSTEM':narCount===1?'✓ RELATED':'○ BROAD SECTOR';
  const whale=getWhaleSignal(sym,whaleAlerts);

  return {
    type:baseType, symbol:sym, sector, leader,
    leaderGain:parseFloat(ml.change1h.toFixed(2)),
    ownChange1h:parseFloat(m.change1h.toFixed(2)),
    ownChange4h:parseFloat(m.change4h.toFixed(2)),
    change24h:parseFloat(m.change24h.toFixed(2)),
    lag:parseFloat(lag.toFixed(2)), price:m.price,
    volRatio:parseFloat((m.hnVolRatio||m.volRatio||1).toFixed(2)),
    hnNormalized:m.hnNormalized||false,
    quoteVol24h:Math.round(m.quoteVol24h),
    volDry:(m.hnVolRatio||m.volRatio||1)<1.2,
    score, scoreBreakdown, vpLabel, vp,
    narLabel, narCount, capTierVal, rs1h, rs4h, tfAligned,
    breakout, catchUpPct, rr,
    volQuality:m.volQuality,
    structData:m.structData,
    entryData:m.entryData,
    isolated,
    whale,
    generatedAt:Date.now(),
    narrative:`${leader.replace('USDT','')} +${ml.change1h.toFixed(1)}% · ${sym.replace('USDT','')} lags ${lag.toFixed(1)}% · ${narLabel} · ${breakout.stage} · VP:${vpLabel}${tfAligned?'':' · ⚠TF CONFLICT'}${isolated?' · ⚠ISOLATED PUMP':''}`,
  };
}

// ── Signal detectors ──────────────────────────────────────────────────────────
function detectSectorRotation(metrics,regime,whaleAlerts) {
  const signals=[];
  Object.entries(SECTORS).forEach(([sector,coins])=>{
    const pumped=coins.filter(s=>metrics[s]&&metrics[s].change1h>=0.4).sort((a,b)=>metrics[b].change1h-metrics[a].change1h);
    if(!pumped.length) return;
    const leader=pumped[0];
    // Improvement 3: check if leader pumped in isolation
    const {isolated}=isIsolatedPump(leader,coins,metrics);
    coins.forEach(sym=>{
      if(!metrics[sym]||sym===leader) return;
      if(metrics[sym].change1h>metrics[leader].change1h*0.7) return;
      if(metrics[sym].quoteVol24h<MIN_QUOTE_VOL_24H) return;
      signals.push(buildSignal('SECTOR',sym,leader,sector,metrics,regime,isolated,whaleAlerts));
    });
  });
  return signals;
}

function detectCorrelationDivergence(metrics,regime,whaleAlerts) {
  const signals=[];
  CORR_PAIRS.forEach(([symA,symB])=>{
    const mA=metrics[symA],mB=metrics[symB]; if(!mA||!mB) return;
    const diff=mA.change1h-mB.change1h, absDiff=Math.abs(diff);
    if(absDiff<0.3) return;
    const laggard=diff>0?symB:symA, leader=diff>0?symA:symB;
    if(metrics[laggard].change4h<-8) return;
    if(metrics[laggard].quoteVol24h<MIN_QUOTE_VOL_24H) return;
    // Improvement 5: validate rolling correlation
    const corrCoeff=rollingCorrelation(mA.c1h,mB.c1h,14);
    if(corrCoeff<0.4) return; // correlation has broken down — skip
    signals.push(buildSignal('CORR',laggard,leader,SYMBOL_SECTOR[laggard]||'—',metrics,regime,false,whaleAlerts));
  });
  return signals;
}

function detectVolumeFlow(metrics,regime,whaleAlerts) {
  const signals=[];
  Object.entries(SECTORS).forEach(([sector,coins])=>{
    const vl=coins.filter(s=>metrics[s]&&metrics[s].volRatio>=1.3&&metrics[s].change1h>-1).sort((a,b)=>metrics[b].volRatio-metrics[a].volRatio);
    if(!vl.length) return;
    const leader=vl[0];
    const {isolated}=isIsolatedPump(leader,coins,metrics);
    coins.forEach(sym=>{
      if(!metrics[sym]||sym===leader) return;
      if(metrics[sym].volRatio>metrics[leader].volRatio*0.8) return;
      if(metrics[sym].change1h<-5) return;
      if(metrics[sym].quoteVol24h<MIN_QUOTE_VOL_24H) return;
      signals.push(buildSignal('VOLFLOW',sym,leader,sector,metrics,regime,isolated,whaleAlerts));
    });
  });
  return signals;
}

// ── Alert ─────────────────────────────────────────────────────────────────────
function pruneAlerts(){const n=Date.now();for(const[k,t]of alertedSignals)if(n-t>ALERT_TTL_MS)alertedSignals.delete(k);}
function alertSignal(sig,regime){
  pruneAlerts();
  const key=`${sig.type}-${sig.symbol}-${sig.leader}`;
  if(alertedSignals.has(key)) return;
  alertedSignals.set(key,Date.now());
  const re={RISK_ON:'🟢',RISK_OFF:'🔴',NEUTRAL:'🟡'}[regime?.regime]||'⚪';
  const sb=sig.scoreBreakdown||{};
  sendTelegram([
    `${sig.confirmed?'⚡':'🔄'} <b>${sig.confirmed?'MULTI-CONFIRMED':'ROTATION'}</b> ${re} <b>${regime?.subMode||'—'}</b>`,
    `🎯 <b>${sig.symbol.replace('USDT','')}</b> ← <b>${sig.leader.replace('USDT','')}</b>`,
    `📊 +${sig.leaderGain}% → own ${sig.ownChange1h>=0?'+':''}${sig.ownChange1h}% | lag ${sig.lag}%`,
    `📐 Stage: <b>${sig.breakout?.stage}</b> | Entry: ${sig.entryData?.timing||'—'}`,
    `📈 TF Aligned: ${sig.tfAligned?'✓ YES':'⚠ NO'} | VP: ${sig.vpLabel}`,
    `🐋 Whale: ${sig.whale?.whaleLabel||'—'}`,
    `${sig.isolated?'⚠ ISOLATED PUMP — reduced confidence':sig.structData?.structLabel||''}`,
    `💪 Score: <b>${sig.score}%</b>`,
    `🎯 R/R: ${sig.rr||'—'}x | Catch-up: +${sig.catchUpPct}%`,
    `🚫 Invalidation: $${sig.breakout?.invalidation||'—'}`,
    `⛔ Max entry: $${sig.breakout?.doNotChaseAbove||'—'}`,
  ].join('\n')).catch(console.error);
}

// ── Background scan ───────────────────────────────────────────────────────────
async function runScan() {
  if(scanInProgress){console.log('[SCAN] Already running');return;}
  scanInProgress=true; rotationCache.scanning=true;
  console.log(`[SCAN START] ${ALL_SYMBOLS.length} symbols`);

  // Phase 1: Regime
  let regime=null;
  try {
    const [b1h,b4h,e4h]=await Promise.all([
      fetchKlines('BTCUSDT','1h',60),
      fetchKlines('BTCUSDT','4h',20),
      fetchKlines('ETHUSDT','4h',20),
    ]);
    regime=assessRegime(b1h,b4h,e4h);
    console.log(`[REGIME] ${regime.subMode} | mult:${regime.altMultiplier}`);
  } catch(e){console.log('[WARN] Regime:',e.message);}

  // Improvement 9: fetch whale alerts once for all signals
  const whaleAlerts=await fetchWhaleAlerts();
  console.log(`[WHALE] ${whaleAlerts.length} alerts fetched`);

  // Scan all coins with extra history for hour-normalization
  const newMetrics={};
  for(let i=0;i<ALL_SYMBOLS.length;i+=4){
    const batch=ALL_SYMBOLS.slice(i,i+4);
    await Promise.allSettled(batch.map(async sym=>{
      try {
        const [c1h,c4h,c1d]=await Promise.all([
          fetchKlines(sym,'1h',168), // 7 days for hour-normalized vol
          fetchKlines(sym,'4h',20),
          fetchKlines(sym,'1d',5),
        ]);
        const last=c1h[c1h.length-1];
        const open1h =c1h[c1h.length-2]?.close||c1h[0].open;
        const first4h=c4h[c4h.length-2]?.close||c4h[0].open;
        const first24h=c1d[c1d.length-2]?.close||c1d[0].open;
        const change1h =((last.close-open1h) /open1h) *100;
        const change4h =((last.close-first4h)/first4h)*100;
        const change24h=((last.close-first24h)/first24h)*100;

        // Plain vol ratio (fallback)
        const recentVols=c1h.slice(-21,-1).map(c=>c.volume);
        const avgVol=recentVols.reduce((a,b)=>a+b,0)/recentVols.length;
        const volRatio=avgVol>0?last.volume/avgVol:1;

        // Improvement 4: hour-normalized volume
        const {hnVolRatio,normalized}=hourNormalizedVolRatio(c1h);

        const quoteVol24h=c1h.slice(-24).reduce((a,c)=>a+c.quoteVol,0);
        if(quoteVol24h<MIN_QUOTE_VOL_24H*0.5) return;

        const vp=calcVP(c1h);
        const volQuality=assessVolumeQuality(c1h);

        // Improvement 1: TF alignment
        const tfData=timeframeAlignment(change1h,change4h,volRatio);
        // Improvement 2: candle structure
        const structData=candleStructureScore(c1h);
        // Improvement 8: entry timing
        const entryData=entryTiming(c1h,vp);
        // RS
        const btcRef=newMetrics['BTCUSDT'];
        const rsData=btcRef?relStrengthVsBTC(change1h,change4h,btcRef.change1h,btcRef.change4h):{rs1h:0,rs4h:0,rsScore:50};

        newMetrics[sym]={
          price:last.close,change1h,change4h,change24h,
          volRatio,hnVolRatio,hnNormalized:normalized,
          quoteVol24h,vp,volQuality,
          tfData,structData,entryData,rsData,
          c1h,c4h,c1d,
        };
      } catch(e){console.log(`[WARN] ${sym}:${e.message}`);}
    }));
    await new Promise(r=>setTimeout(r,350));
  }

  // Check outcomes of past signals
  await checkOutcomes(newMetrics);

  // Generate signals
  const sS=detectSectorRotation(newMetrics,regime,whaleAlerts);
  const cS=detectCorrelationDivergence(newMetrics,regime,whaleAlerts);
  const vS=detectVolumeFlow(newMetrics,regime,whaleAlerts);
  const all=[...sS,...cS,...vS].sort((a,b)=>b.score-a.score);

  // Dedup by symbol — keep best, merge types
  const bySymbol=new Map();
  for(const s of all){if(!bySymbol.has(s.symbol))bySymbol.set(s.symbol,[]);bySymbol.get(s.symbol).push(s);}
  const deduped=[];
  for(const[,sigs]of bySymbol){
    sigs.sort((a,b)=>b.score-a.score);
    const best={...sigs[0]};
    const allTypes=[...new Set(sigs.map(s=>s.type))];
    const confirmed=allTypes.length>1;
    if(confirmed) best.score=Math.min(100,best.score+8);
    best.confirmedTypes=allTypes; best.confirmed=confirmed;
    best.allNarratives=sigs.map(s=>`[${s.type}] ${s.narrative}`);
    if(confirmed) best.narrative=`⚡ MULTI-CONFIRMED (${allTypes.join('+')}): ${best.narrative}`;
    deduped.push(best);
  }
  deduped.sort((a,b)=>b.score-a.score);

  // Phase 4: Futures for top 15
  await Promise.allSettled(deduped.slice(0,15).map(async sig=>{
    try {
      const fut=await fetchFuturesData(sig.symbol);
      const {futuresScore,futuresLabel,fundingRate}=scoreFutures(fut);
      sig.futuresScore=futuresScore; sig.futuresLabel=futuresLabel; sig.fundingRate=fundingRate;
      if(fundingRate!==null&&fundingRate>0.1) sig.score=Math.max(0,sig.score-10);
    } catch{sig.futuresLabel='—';}
  }));

  // Record for hit tracking + graveyard
  deduped.slice(0,25).forEach(s=>recordSignal(s));

  // Alert top 8
  deduped.slice(0,8).forEach(s=>alertSignal(s,regime));

  // Sector summary
  const sectorSummary={};
  Object.entries(SECTORS).forEach(([sector,coins])=>{
    const cd=coins.filter(s=>newMetrics[s]).map(s=>({sym:s,...newMetrics[s]}));
    if(!cd.length) return;
    const avg1h=cd.reduce((a,c)=>a+c.change1h,0)/cd.length;
    const avg4h=cd.reduce((a,c)=>a+c.change4h,0)/cd.length;
    const maxVol=Math.max(...cd.map(c=>c.volRatio));
    const ldr=cd.sort((a,b)=>b.change1h-a.change1h)[0];
    sectorSummary[sector]={avgChange1h:parseFloat(avg1h.toFixed(3)),avgChange4h:parseFloat(avg4h.toFixed(3)),maxVolRatio:parseFloat(maxVol.toFixed(2)),leader:ldr.sym,coins:cd.length};
  });

  // Strip raw candle arrays from metrics before caching (save memory)
  const lightMetrics={};
  for(const[sym,m]of Object.entries(newMetrics)){
    const {c1h,c4h,c1d,...rest}=m; // eslint-disable-line no-unused-vars
    lightMetrics[sym]=rest;
  }

  rotationCache={
    signals:deduped, metrics:lightMetrics, sectors:sectorSummary,
    regime, hitStats:getHitRateStats(),
    graveyard:graveyard.slice(0,30),
    ts:new Date().toISOString(), scanning:false,
    coinCount:Object.keys(newMetrics).length,
  };
  scanInProgress=false;
  console.log(`[SCAN DONE] ${Object.keys(newMetrics).length} coins, ${deduped.length} signals | ${regime?.subMode||'—'}`);
  sendTelegram([
    `🔄 <b>Rotation Scan v4 Complete</b>`,
    `📊 Regime: <b>${regime?.subMode||'—'}</b> (×${regime?.altMultiplier||1})`,
    `${Object.keys(newMetrics).length} coins · ${deduped.length} signals`,
    `🔄${sS.length} ⚖️${cS.length} 💰${vS.length}`,
  ].join('\n')).catch(()=>{});
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function setCORS(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
}
const ipMap=new Map();
function isRateLimited(ip,limit=30){
  const n=Date.now(),e=ipMap.get(ip)||{count:0,reset:n+60000};
  if(n>e.reset){e.count=0;e.reset=n+60000;}
  e.count++;ipMap.set(ip,e);return e.count>limit;
}
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
    return res.end(JSON.stringify({
      ok:true,signals:rotationCache.signals||[],metrics:rotationCache.metrics||{},
      sectors:rotationCache.sectors||{},regime:rotationCache.regime||null,
      hitStats:rotationCache.hitStats||null,graveyard:rotationCache.graveyard||[],
      ts:rotationCache.ts||new Date().toISOString(),
      scanning:rotationCache.scanning||false,coinCount:rotationCache.coinCount||0,
    }));
  }
  if(pn==='/api/trigger-scan'){
    if(isRateLimited(clientIP,5)){res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:false,message:'Too many requests'}));}
    if(scanInProgress){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:false,message:'Already scanning'}));}
    runScan().catch(console.error);
    res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,message:'Scan started'}));
  }
  if(pn==='/api/sectors'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,sectors:rotationCache.sectors||{}}));}
  if(pn==='/api/hitstats'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,...getHitRateStats()}));}
  if(pn==='/api/graveyard'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,graveyard:graveyard.slice(0,30)}));}
  if(pn==='/api/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,coinCount:rotationCache.coinCount,ts:rotationCache.ts,scanning:scanInProgress,regime:rotationCache.regime?.subMode}));}
  res.writeHead(404);res.end('Not found');
});

server.listen(PORT,HOST,()=>{
  console.log(`ROTATION SCREENER v4 on ${HOST}:${PORT}`);
  if(!TG_TOKEN)console.warn('[WARN] TG_TOKEN not set');
  if(!WHALE_API_KEY)console.warn('[WARN] WHALE_API_KEY not set — whale alerts disabled');
  sendTelegram('🟢 <b>ROTATION SCREENER v4 ONLINE</b>\n12-factor scoring · Whale alerts · Hour-normalized vol').catch(()=>{});
  setTimeout(()=>runScan().catch(console.error),3000);
  setInterval(()=>runScan().catch(console.error),10*60*1000);
});
