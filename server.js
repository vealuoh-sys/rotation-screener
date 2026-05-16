/**
 * ROTATION SCREENER v3 — server.js
 * ═══════════════════════════════════════════════════════
 * Phase 1: BTC/ETH Market Regime + Signal Age Timer
 * Phase 2: Relative Strength vs BTC + Volume Quality
 * Phase 3: Breakout Labels + Risk Box (invalidation, R/R)
 * Phase 4: Futures confirmation (top signals) + 24h volume filter
 * Phase 5: Hit Rate Tracker (in-memory)
 * ═══════════════════════════════════════════════════════
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

// Minimum 24h USDT quote volume — filters illiquid coins (Phase 4)
const MIN_QUOTE_VOL_24H = 2_000_000;

// ── Sectors ───────────────────────────────────────────────────────────────────
const SECTORS = {
  'L1_MAJOR':  ['BTCUSDT','ETHUSDT','SOLUSDT','AVAXUSDT','DOTUSDT','BNBUSDT','ADAUSDT','TRXUSDT','HBARUSDT','TONUSDT'],
  'L1_ALT':    ['NEARUSDT','APTUSDT','SUIUSDT','ALGOUSDT','EGLDUSDT','ICPUSDT','FTMUSDT','ONEUSDT','ZILUSDT','KAVAUSDT','FLOWUSDT','MINAUSDT','XTZUSDT','EOSUSDT','THETAUSDT'],
  'L2':        ['MATICUSDT','ARBUSDT','OPUSDT','IMXUSDT','STXUSDT','METISUSDT','SKLUSDT','LRCUSDT','NTRNUSDT'],
  'DEFI':      ['UNIUSDT','AAVEUSDT','CRVUSDT','MKRUSDT','SNXUSDT','COMPUSDT','SUSHIUSDT','DYDXUSDT','GMXUSDT','CAKEUSDT','BALUSDT','YFIUSDT','1INCHUSDT','RUNEUSDT','KNCUSDT'],
  'AI_DATA':   ['FETUSDT','GRTUSDT','INJUSDT','WLDUSDT','AGIXUSDT','OCEANUSDT','NMRUSDT','PHAUSDT','RNDRUSDT'],
  'GAMING':    ['AXSUSDT','SANDUSDT','MANAUSDT','GALAUSDT','GMTUSDT','APEUSDT','ILVUSDT','SLPUSDT','YGGUSDT','MBOXUSDT','ALICEUSDT','TLMUSDT','RAREUSDT'],
  'INFRA':     ['LINKUSDT','FILUSDT','LDOUSDT','ENSUSDT','STORJUSDT','SCUSDT','AKROUSDT','NKNUSDT','XVSUSDT','IOTAUSDT'],
  'PAYMENTS':  ['XRPUSDT','XLMUSDT','LTCUSDT','VETUSDT','NANOUSDT','ZECUSDT','DASHUSDT','BCHUSDT','DGBUSDT','QNTUSDT'],
  'COSMOS':    ['ATOMUSDT','TIAUSDT','RUNEUSDT','INJUSDT','AKTUSDT','EVMOSUSDT'],
  'MEME':      ['DOGEUSDT','SHIBUSDT','PEPEUSDT','FLOKIUSDT','BONKUSDT','WIFUSDT','MEMEUSDT'],
  'EXCHANGE':  ['BNBUSDT','CAKEUSDT','DYDXUSDT'],
  'PRIVACY':   ['XMRUSDT','ZECUSDT','ROSEUSDT','PHAUSDT'],
  'ORACLE':    ['LINKUSDT','BANDUSDT'],
  'NFT':       ['ENSUSDT','RAREUSDT','SUPERUSDT'],
  'REAL_WORLD':['RLCUSDT','COTIUSDT','ACHUSDT','REQUSDT'],
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
  ['ATOMUSDT','TIAUSDT'],['ATOMUSDT','AKTUSDT'],['LTCUSDT','BCHUSDT'],
];

// ── Sub-narratives ────────────────────────────────────────────────────────────
const SUB_NARRATIVE = {
  COSMOS_ECO: ['ATOMUSDT','TIAUSDT','INJUSDT','AKTUSDT','NTRNUSDT','EVMOSUSDT'],
  ETH_L2:     ['MATICUSDT','ARBUSDT','OPUSDT','METISUSDT','SKLUSDT','LRCUSDT','IMXUSDT'],
  BTC_ECO:    ['STXUSDT','LDOUSDT'],
  SOL_ECO:    ['SOLUSDT','BONKUSDT','WIFUSDT'],
  AI_COMPUTE: ['FETUSDT','AGIXUSDT','RNDRUSDT','OCEANUSDT','WLDUSDT','GRTUSDT','NMRUSDT'],
  GAMEFI:     ['AXSUSDT','ILVUSDT','SLPUSDT','YGGUSDT','GALAUSDT','MBOXUSDT','ALICEUSDT'],
  METAVERSE:  ['SANDUSDT','MANAUSDT','APEUSDT','GMTUSDT'],
  DEX:        ['UNIUSDT','SUSHIUSDT','CRVUSDT','BALUSDT','1INCHUSDT','CAKEUSDT'],
  LENDING:    ['AAVEUSDT','COMPUSDT','MKRUSDT','SNXUSDT','KNCUSDT'],
  PERPS:      ['DYDXUSDT','GMXUSDT','SNXUSDT'],
  MEME_OG:    ['DOGEUSDT','SHIBUSDT'],
  MEME_NEW:   ['PEPEUSDT','FLOKIUSDT','BONKUSDT','WIFUSDT','MEMEUSDT'],
  REMITTANCE: ['XRPUSDT','XLMUSDT','NANOUSDT','QNTUSDT'],
  PRIVACY:    ['XMRUSDT','ZECUSDT','DASHUSDT','ROSEUSDT'],
  POW:        ['LTCUSDT','BCHUSDT','DASHUSDT','ZECUSDT','DGBUSDT'],
  ORACLE:     ['LINKUSDT','BANDUSDT'],
  STORAGE:    ['FILUSDT','STORJUSDT','SCUSDT','OCEANUSDT'],
};
const SYM_NARRATIVES = {};
Object.entries(SUB_NARRATIVE).forEach(([nar,coins]) => {
  coins.forEach(sym => { if (!SYM_NARRATIVES[sym]) SYM_NARRATIVES[sym]=[]; SYM_NARRATIVES[sym].push(nar); });
});
function sharedNarratives(a,b) {
  const na=SYM_NARRATIVES[a]||[], nb=SYM_NARRATIVES[b]||[];
  return na.filter(n=>nb.includes(n)).length;
}

// ── Cap tiers ─────────────────────────────────────────────────────────────────
const CAP_TIER = {
  BTCUSDT:1,ETHUSDT:1,BNBUSDT:1,SOLUSDT:1,XRPUSDT:1,
  ADAUSDT:2,AVAXUSDT:2,DOGEUSDT:2,DOTUSDT:2,TRXUSDT:2,TONUSDT:2,MATICUSDT:2,LTCUSDT:2,LINKUSDT:2,UNIUSDT:2,
  NEARUSDT:3,APTUSDT:3,ARBUSDT:3,OPUSDT:3,ATOMUSDT:3,HBARUSDT:3,ICPUSDT:3,FILUSDT:3,INJUSDT:3,IMXUSDT:3,
  AAVEUSDT:3,TIAUSDT:3,RUNEUSDT:3,SUIUSDT:3,WLDUSDT:3,FTMUSDT:3,ALGOUSDT:3,EGLDUSDT:3,FLOWUSDT:3,
  FETUSDT:4,GRTUSDT:4,SUSHIUSDT:4,DYDXUSDT:4,GMXUSDT:4,CRVUSDT:4,MKRUSDT:4,CAKEUSDT:4,SANDUSDT:4,
  MANAUSDT:4,AXSUSDT:4,SNXUSDT:4,COMPUSDT:4,LDOUSDT:4,ENSUSDT:4,STXUSDT:4,GALAUSDT:4,APEUSDT:4,
  GMTUSDT:4,AGIXUSDT:4,RNDRUSDT:4,YFIUSDT:4,BALUSDT:4,SHIBUSDT:3,PEPEUSDT:3,XLMUSDT:3,BCHUSDT:3,XMRUSDT:3,
  NTRNUSDT:5,SKLUSDT:5,METISUSDT:5,LRCUSDT:5,AKTUSDT:5,ILVUSDT:5,SLPUSDT:5,YGGUSDT:5,MBOXUSDT:5,
  ALICEUSDT:5,TLMUSDT:5,RAREUSDT:5,STORJUSDT:5,SCUSDT:5,AKROUSDT:5,NKNUSDT:5,IOTAUSDT:5,NANOUSDT:5,
  DGBUSDT:5,QNTUSDT:4,ZILUSDT:5,ONEUSDT:5,MINAUSDT:4,XTZUSDT:4,EOSUSDT:4,THETAUSDT:4,ZECUSDT:4,
  DASHUSDT:4,VETUSDT:4,FLOKIUSDT:4,BONKUSDT:4,WIFUSDT:4,MEMEUSDT:5,OCEANUSDT:4,NMRUSDT:5,PHAUSDT:5,
  COTIUSDT:5,ACHUSDT:5,REQUSDT:5,RLCUSDT:5,BANDUSDT:4,KNCUSDT:4,XVSUSDT:5,EVMOSUSDT:5,SUPERUSDT:5,
};
function capTier(sym) { return CAP_TIER[sym]||3; }
function capTierScore(a,b) { return [100,60,20,0,0][Math.abs(capTier(a)-capTier(b))]||0; }

// ── State ─────────────────────────────────────────────────────────────────────
let rotationCache  = { signals:[],ts:null,scanning:false,coinCount:0,regime:null };
let scanInProgress = false;
const ALERT_TTL_MS = 15*60*1000;
const alertedSignals = new Map();

// ── Phase 5: Hit Rate Tracker ─────────────────────────────────────────────────
const hitTracker = new Map();

function recordSignal(sig) {
  const key = `${sig.symbol}-${sig.type}-${Date.now()}`;
  hitTracker.set(key, {
    sig: { symbol:sig.symbol, price:sig.price, type:sig.type, score:sig.score, sector:sig.sector },
    generatedAt: Date.now(), outcomes: {},
  });
}

async function checkOutcomes(metrics) {
  const now = Date.now();
  for (const [key,entry] of hitTracker) {
    const age = now - entry.generatedAt;
    const m   = metrics[entry.sig.symbol];
    if (!m) continue;
    const pct = ((m.price - entry.sig.price) / entry.sig.price) * 100;
    if (age >= 15*60*1000  && entry.outcomes['15m']===undefined) entry.outcomes['15m'] = parseFloat(pct.toFixed(2));
    if (age >= 60*60*1000  && entry.outcomes['1h'] ===undefined) entry.outcomes['1h']  = parseFloat(pct.toFixed(2));
    if (age >= 4*60*60*1000 && entry.outcomes['4h']===undefined) entry.outcomes['4h']  = parseFloat(pct.toFixed(2));
    if (age > 24*60*60*1000) hitTracker.delete(key);
  }
}

function getHitRateStats() {
  const stats = { byType:{SECTOR:{},CORR:{},VOLFLOW:{}}, bySector:{}, overall:{total:0,win15m:0,win1h:0,win4h:0}, recent:[] };
  for (const [,entry] of hitTracker) {
    const { sig, outcomes, generatedAt } = entry;
    if (!stats.byType[sig.type]) stats.byType[sig.type]={total:0,win15m:0,win1h:0,win4h:0};
    if (!stats.bySector[sig.sector]) stats.bySector[sig.sector]={total:0,win15m:0,win1h:0,win4h:0};
    ['total','win15m','win1h','win4h'].forEach(k => {
      const isWin = k==='total' ? true : outcomes[k.replace('win','')]!==undefined && outcomes[k.replace('win','')]>0;
      if (k==='total'||isWin) { stats.byType[sig.type][k]=(stats.byType[sig.type][k]||0)+1; stats.bySector[sig.sector][k]=(stats.bySector[sig.sector][k]||0)+1; stats.overall[k]=(stats.overall[k]||0)+1; }
    });
    if (Date.now()-generatedAt < 6*60*60*1000) stats.recent.push({symbol:sig.symbol,type:sig.type,score:sig.score,outcomes,generatedAt});
  }
  return stats;
}

// ── Telegram ──────────────────────────────────────────────────────────────────
function sendTelegram(msg) {
  if (!TG_TOKEN||!TG_CHAT) return Promise.resolve();
  return new Promise(resolve => {
    https.get(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage?chat_id=${TG_CHAT}&text=${encodeURIComponent(msg)}&parse_mode=HTML`, res=>{
      res.on('data',()=>{}); res.on('end',resolve);
    }).on('error',()=>resolve());
  });
}

// ── Binance fetch ─────────────────────────────────────────────────────────────
function fetchBinance(reqPath, isFutures=false) {
  const eps = isFutures ? ['fapi.binance.com'] : ['data-api.binance.vision','api.binance.com','api1.binance.com','api2.binance.com'];
  function tryEP(i) {
    if (i>=eps.length) return Promise.reject(new Error('All endpoints failed'));
    return new Promise((resolve,reject) => {
      const req = https.request({ hostname:eps[i], path:reqPath, method:'GET', headers:{'User-Agent':'RotationScreener/3.0','Accept':'application/json'}, timeout:12000 }, res => {
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
      req.on('timeout',()=>{req.destroy();tryEP(i+1).then(resolve).catch(reject);});
      req.on('error',()=>tryEP(i+1).then(resolve).catch(reject));
      req.end();
    });
  }
  return tryEP(0);
}

async function fetchKlines(symbol, interval, limit=60) {
  const raw = await fetchBinance(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  return raw.map(k=>({
    time:parseInt(k[0]), open:parseFloat(k[1]), high:parseFloat(k[2]),
    low:parseFloat(k[3]), close:parseFloat(k[4]), volume:parseFloat(k[5]),
    quoteVol:parseFloat(k[7]), takerBuy:parseFloat(k[9]), takerBuyQuote:parseFloat(k[10]),
  }));
}

// ── Phase 4: Futures ──────────────────────────────────────────────────────────
async function fetchFuturesData(symbol) {
  try {
    const [oiRes, frRes] = await Promise.allSettled([
      fetchBinance(`/fapi/v1/openInterest?symbol=${symbol}`, true),
      fetchBinance(`/fapi/v1/fundingRate?symbol=${symbol}&limit=3`, true),
    ]);
    const oi = oiRes.status==='fulfilled' ? parseFloat(oiRes.value.openInterest||0) : null;
    const frArr = frRes.status==='fulfilled'&&Array.isArray(frRes.value) ? frRes.value : [];
    const fr = frArr.length>0 ? parseFloat(frArr[frArr.length-1].fundingRate||0)*100 : null;
    return { oi, fundingRate:fr };
  } catch { return { oi:null, fundingRate:null }; }
}

function scoreFutures(fut) {
  if (!fut||fut.fundingRate===null) return { futuresScore:50, futuresLabel:'NO FUTURES DATA' };
  const fr = fut.fundingRate;
  let score = 70;
  if (fr > 0.10) score -= 35;
  else if (fr > 0.05) score -= 15;
  else if (fr < -0.05) score -= 20;
  else if (fr >= -0.01 && fr <= 0.03) score += 20;
  const label = fr>0.10 ? `FR:${fr.toFixed(3)}% ⚠ CROWDED LONG`
              : fr<-0.05 ? `FR:${fr.toFixed(3)}% ⚠ CROWDED SHORT`
              : `FR:${fr.toFixed(3)}% ✓ CLEAN`;
  return { futuresScore:Math.min(100,Math.max(0,score)), futuresLabel:label, fundingRate:fr };
}

// ── EMA ───────────────────────────────────────────────────────────────────────
function calcEMA(candles, period) {
  if (candles.length<period) return candles[candles.length-1].close;
  let sum=0;
  for (let i=0;i<period;i++) sum+=candles[i].close;
  let ema=sum/period;
  const k=2/(period+1);
  for (let i=period;i<candles.length;i++) ema=candles[i].close*k+ema*(1-k);
  return ema;
}

// ── Phase 1: Market Regime ────────────────────────────────────────────────────
function assessRegime(btc1h, btc4h, eth4h) {
  const lastBtc1h = btc1h[btc1h.length-1].close;
  const lastBtc4h = btc4h[btc4h.length-1].close;
  const lastEth4h = eth4h[eth4h.length-1].close;
  const btcEma20_1h = calcEMA(btc1h,20);
  const btcEma50_1h = calcEMA(btc1h,50);
  const btcEma20_4h = calcEMA(btc4h,20);
  const btcEma50_4h = calcEMA(btc4h,50);
  const btcTrend1h = lastBtc1h>btcEma20_1h&&btcEma20_1h>btcEma50_1h?'UP':lastBtc1h<btcEma20_1h&&btcEma20_1h<btcEma50_1h?'DOWN':'NEUTRAL';
  const btcTrend4h = lastBtc4h>btcEma20_4h&&btcEma20_4h>btcEma50_4h?'UP':lastBtc4h<btcEma20_4h&&btcEma20_4h<btcEma50_4h?'DOWN':'NEUTRAL';
  const btcChange4h = ((lastBtc4h-btc4h[0].close)/btc4h[0].close)*100;
  const ethChange4h = ((lastEth4h-eth4h[0].close)/eth4h[0].close)*100;
  const ethBtcTrend = ethChange4h>btcChange4h+0.5?'RISING':ethChange4h<btcChange4h-0.5?'FALLING':'FLAT';
  let regime, altMultiplier;
  if (btcTrend4h==='UP'&&btcTrend1h!=='DOWN') { regime='RISK_ON';  altMultiplier=1.00; }
  else if (btcTrend4h==='DOWN'&&btcTrend1h==='DOWN') { regime='RISK_OFF'; altMultiplier=0.60; }
  else { regime='NEUTRAL'; altMultiplier=0.85; }
  return { regime, altMultiplier, btcTrend1h, btcTrend4h, ethBtcTrend,
    btcPrice:lastBtc1h, btcEma20:parseFloat(btcEma20_1h.toFixed(2)), btcEma50:parseFloat(btcEma50_1h.toFixed(2)),
    btcChange4h:parseFloat(btcChange4h.toFixed(2)), ethChange4h:parseFloat(ethChange4h.toFixed(2)) };
}

// ── VP ────────────────────────────────────────────────────────────────────────
const VP_BINS = 36;
function calcVP(candles) {
  if (!candles||candles.length<10) return null;
  let lo=Infinity,hi=-Infinity;
  candles.forEach(c=>{ if(c.high>hi) hi=c.high; if(c.low<lo) lo=c.low; });
  const range=hi-lo; if (!range) return null;
  const binSize=range/VP_BINS, vol=new Array(VP_BINS).fill(0);
  candles.forEach(c=>{ const t=(c.high+c.low+c.close)/3; vol[Math.min(Math.floor((t-lo)/binSize),VP_BINS-1)]+=c.volume; });
  let pocIdx=0; vol.forEach((v,i)=>{ if(v>vol[pocIdx]) pocIdx=i; });
  const poc=lo+(pocIdx+0.5)*binSize, tv=vol.reduce((a,b)=>a+b,0);
  let vaVol=vol[pocIdx],vaLo=pocIdx,vaHi=pocIdx;
  while(vaVol<tv*0.70){const nL=vaLo>0?vol[vaLo-1]:0,nH=vaHi<VP_BINS-1?vol[vaHi+1]:0;if(nL>=nH&&vaLo>0){vaLo--;vaVol+=nL;}else if(vaHi<VP_BINS-1){vaHi++;vaVol+=nH;}else break;}
  return { poc, vah:lo+(vaHi+1)*binSize, val:lo+vaLo*binSize };
}
function vpProximityScore(price,vp) {
  if (!vp) return 30;
  const dL=Math.abs(price-vp.val)/vp.val*100, dP=Math.abs(price-vp.poc)/vp.poc*100, dH=Math.abs(price-vp.vah)/vp.vah*100;
  if (price<vp.val*0.98) return 5;
  if (dL<=0.8) return 100; if (dL<=2.0) return 85;
  if (dP<=0.8) return 65;  if (dP<=2.0) return 50;
  if (dH<=1.0) return 40;
  if (price>=vp.val&&price<=vp.vah) return 35;
  return 15;
}
function vpLevelLabel(price,vp) {
  if (!vp) return '—';
  const dL=Math.abs(price-vp.val)/vp.val*100, dP=Math.abs(price-vp.poc)/vp.poc*100, dH=Math.abs(price-vp.vah)/vp.vah*100;
  if (price<vp.val*0.98) return 'BELOW VAL ⚠';
  if (dL<=2.0) return 'AT VAL 🎯';
  if (dP<=2.0) return 'AT POC ◆';
  if (dH<=1.5) return 'AT VAH 🔴';
  if (price>=vp.val&&price<=vp.vah) return 'IN VALUE';
  return 'ABOVE VAH';
}

// ── Phase 3: Breakout Stage Detection ────────────────────────────────────────
function detectBreakoutStage(c1h, c4h, c1d, vp) {
  const price   = c1h[c1h.length-1].close;
  const ema20   = calcEMA(c1h,20);
  const ema50   = calcEMA(c1h,50);
  const p4hHigh = c4h.slice(0,-1).reduce((m,c)=>Math.max(m,c.high),-Infinity);
  const p4hLow  = c4h.slice(0,-1).reduce((m,c)=>Math.min(m,c.low),Infinity);
  const pdHigh  = c1d.length>=2 ? c1d[c1d.length-2].high : c1d[0].high;
  const pdLow   = c1d.length>=2 ? c1d[c1d.length-2].low  : c1d[0].low;
  const resLevels = [p4hHigh, pdHigh, vp?.vah].filter(l=>l&&l>price);
  const supLevels = [p4hLow, pdLow, vp?.val, vp?.poc].filter(l=>l&&l<price);
  const nearestRes = resLevels.length>0 ? Math.min(...resLevels) : null;
  const nearestSup = supLevels.length>0 ? Math.max(...supLevels) : null;
  let stage, stageColor;
  if (price<ema20&&price<ema50&&price<(vp?.val||Infinity))              { stage='BELOW_STRUCTURE';    stageColor='#FF5E3A'; }
  else if (price>=(vp?.val||0)&&price<=ema20&&price<=(vp?.poc||Infinity)){ stage='ACCUMULATION';       stageColor='#00FFB2'; }
  else if (price>ema20&&price<=p4hHigh&&price<=(vp?.vah||Infinity))     { stage='PRE_BREAKOUT';       stageColor='#FFD700'; }
  else if (price>p4hHigh&&price<=pdHigh)                                 { stage='BREAKOUT_CONFIRMED'; stageColor='#00BFFF'; }
  else if (price>pdHigh)                                                  { stage='CHASE_RISK';         stageColor='#FF9500'; }
  else                                                                     { stage='IN_RANGE';           stageColor='#B8D4E8'; }
  const invalidation   = nearestSup ? parseFloat((nearestSup*0.99).toFixed(6))  : null;
  const doNotChaseAbove= nearestRes  ? parseFloat((nearestRes*0.995).toFixed(6)) : null;
  return { stage, stageColor, ema20:parseFloat(ema20.toFixed(6)), ema50:parseFloat(ema50.toFixed(6)),
    p4hHigh:parseFloat(p4hHigh.toFixed(6)), pdHigh:parseFloat(pdHigh.toFixed(6)),
    nearestRes:nearestRes?parseFloat(nearestRes.toFixed(6)):null,
    nearestSup:nearestSup?parseFloat(nearestSup.toFixed(6)):null,
    invalidation, doNotChaseAbove };
}

// ── Phase 2: Volume Quality ───────────────────────────────────────────────────
function assessVolumeQuality(c1h) {
  const last3 = c1h.slice(-3), last=last3[last3.length-1];
  const buyRatio  = last.volume>0 ? last.takerBuy/last.volume : 0.5;
  const body      = Math.abs(last.close-last.open);
  const range     = last.high-last.low;
  const bodyRatio = range>0 ? body/range : 0;
  const closePos  = range>0 ? (last.close-last.low)/range : 0.5;
  const expanding = last3.length===3&&last3[1].volume>last3[0].volume&&last3[2].volume>last3[1].volume;
  let q=40;
  if (buyRatio>0.6)  q+=20;
  if (bodyRatio>0.6) q+=15;
  if (closePos>0.7)  q+=15;
  if (expanding)     q+=10;
  return { buyRatio:parseFloat(buyRatio.toFixed(2)), bodyRatio:parseFloat(bodyRatio.toFixed(2)),
    closePos:parseFloat(closePos.toFixed(2)), expanding, volQuality:Math.min(100,q),
    volQualityLabel:q>=80?'STRONG 💪':q>=60?'GOOD ✓':q>=40?'AVERAGE':'WEAK ⚠' };
}

// ── Phase 2: Relative strength vs BTC ────────────────────────────────────────
function relStrengthVsBTC(coinC1h, coinC4h, btcC1h, btcC4h) {
  const rs1h = coinC1h - btcC1h, rs4h = coinC4h - btcC4h;
  return { rs1h:parseFloat(rs1h.toFixed(2)), rs4h:parseFloat(rs4h.toFixed(2)), rsScore:Math.min(100,Math.max(0,50+rs1h*5+rs4h*3)) };
}

// ── Momentum state ────────────────────────────────────────────────────────────
function momentumStateScore(c1h, c4h, c24h) {
  let s=70; const r=Math.abs(c24h);
  if (r>15) s-=40; else if (r>8) s-=20; else if (r>4) s-=8; else s+=15;
  if (Math.abs(c4h)<1.5&&Math.abs(c1h)>0.2) s+=15;
  if (c4h<-4) s-=25;
  return Math.min(100,Math.max(0,s));
}

// ── Master scoring engine ─────────────────────────────────────────────────────
function scoreCandidate(sym, leader, m, vp, regime, btcC1h, btcC4h) {
  const narCount  = sharedNarratives(sym,leader);
  const narScore  = narCount>=2?100:narCount===1?65:20;
  const capScore  = capTierScore(sym,leader);
  const momScore  = momentumStateScore(m.change1h,m.change4h,m.change24h);
  const volScore  = m.volRatio<0.8?100:m.volRatio<1.2?80:m.volRatio<1.8?45:m.volRatio<2.5?20:5;
  const vpScore   = vpProximityScore(m.price,vp);
  const trendScore= m.change4h>1?100:m.change4h>0?80:m.change4h>-2?55:m.change4h>-5?25:0;
  const { rs1h, rs4h, rsScore } = relStrengthVsBTC(m.change1h,m.change4h,btcC1h||0,btcC4h||0);
  const vqScore   = m.volQuality?.volQuality||50;
  const composite = narScore*0.22+capScore*0.18+momScore*0.15+volScore*0.12+vpScore*0.12+trendScore*0.08+rsScore*0.08+vqScore*0.05;
  const finalScore= Math.round(composite*(regime?.altMultiplier||1.0));
  return {
    score:Math.min(100,Math.max(0,finalScore)),
    scoreBreakdown:{ narrative:Math.round(narScore), capTier:Math.round(capScore), momentum:Math.round(momScore),
      volDry:Math.round(volScore), vpLevel:Math.round(vpScore), trend:Math.round(trendScore),
      relStrength:Math.round(rsScore), volQuality:Math.round(vqScore) },
    vpLabel:vp?vpLevelLabel(m.price,vp):'—', vp, narCount, capTierVal:capTier(sym), rs1h, rs4h,
  };
}

// ── Build one signal object ───────────────────────────────────────────────────
function buildSignal(baseType, sym, leader, sector, metrics, regime) {
  const m=metrics[sym], ml=metrics[leader], btcM=metrics['BTCUSDT'];
  const lag = ml.change1h - m.change1h;
  const { score,scoreBreakdown,vpLabel,vp,narCount,capTierVal,rs1h,rs4h }
    = scoreCandidate(sym,leader,m,m.vp,regime,btcM?.change1h||0,btcM?.change4h||0);
  const breakout = detectBreakoutStage(m.c1h,m.c4h,m.c1d,m.vp);
  const catchUpPct = parseFloat(lag.toFixed(2));
  const riskPct = breakout.invalidation ? ((m.price-breakout.invalidation)/m.price*100) : Math.abs(m.change4h)||2;
  const rr = riskPct>0 ? parseFloat((catchUpPct/riskPct).toFixed(1)) : null;
  const narLabel = narCount>=2?'🔥 SAME ECOSYSTEM':narCount===1?'✓ RELATED':'○ BROAD SECTOR';
  return {
    type:baseType, symbol:sym, sector, leader,
    leaderGain:parseFloat(ml.change1h.toFixed(2)),
    ownChange1h:parseFloat(m.change1h.toFixed(2)), ownChange4h:parseFloat(m.change4h.toFixed(2)),
    change24h:parseFloat(m.change24h.toFixed(2)), lag:parseFloat(lag.toFixed(2)),
    price:m.price, volRatio:parseFloat(m.volRatio.toFixed(2)), quoteVol24h:Math.round(m.quoteVol24h),
    volDry:m.volRatio<1.2, score, scoreBreakdown, vpLabel, vp, narLabel, narCount, capTierVal,
    rs1h, rs4h, breakout, catchUpPct, rr, volQuality:m.volQuality,
    generatedAt:Date.now(),
    narrative:`${leader.replace('USDT','')} +${ml.change1h.toFixed(1)}% · ${sym.replace('USDT','')} lags ${lag.toFixed(1)}% · ${narLabel} · ${breakout.stage} · VP:${vpLabel}`,
  };
}

// ── Signal detectors ──────────────────────────────────────────────────────────
function detectSectorRotation(metrics,regime) {
  const signals=[];
  Object.entries(SECTORS).forEach(([sector,coins])=>{
    const pumped=coins.filter(s=>metrics[s]&&metrics[s].change1h>=0.4).sort((a,b)=>metrics[b].change1h-metrics[a].change1h);
    if (!pumped.length) return;
    const leader=pumped[0];
    coins.forEach(sym=>{
      if (!metrics[sym]||sym===leader) return;
      if (metrics[sym].change1h>metrics[leader].change1h*0.7) return;
      if (metrics[sym].quoteVol24h<MIN_QUOTE_VOL_24H) return;
      signals.push(buildSignal('SECTOR',sym,leader,sector,metrics,regime));
    });
  });
  return signals;
}

function detectCorrelationDivergence(metrics,regime) {
  const signals=[];
  CORR_PAIRS.forEach(([symA,symB])=>{
    const mA=metrics[symA],mB=metrics[symB]; if(!mA||!mB) return;
    const diff=mA.change1h-mB.change1h,absDiff=Math.abs(diff); if(absDiff<0.3) return;
    const laggard=diff>0?symB:symA,leader=diff>0?symA:symB;
    if(metrics[laggard].change4h<-8) return;
    if(metrics[laggard].quoteVol24h<MIN_QUOTE_VOL_24H) return;
    signals.push(buildSignal('CORR',laggard,leader,SYMBOL_SECTOR[laggard]||'—',metrics,regime));
  });
  return signals;
}

function detectVolumeFlow(metrics,regime) {
  const signals=[];
  Object.entries(SECTORS).forEach(([sector,coins])=>{
    const vl=coins.filter(s=>metrics[s]&&metrics[s].volRatio>=1.3&&metrics[s].change1h>-1).sort((a,b)=>metrics[b].volRatio-metrics[a].volRatio);
    if (!vl.length) return;
    const leader=vl[0];
    coins.forEach(sym=>{
      if(!metrics[sym]||sym===leader) return;
      if(metrics[sym].volRatio>metrics[leader].volRatio*0.8) return;
      if(metrics[sym].change1h<-5) return;
      if(metrics[sym].quoteVol24h<MIN_QUOTE_VOL_24H) return;
      signals.push(buildSignal('VOLFLOW',sym,leader,sector,metrics,regime));
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
    `${sig.confirmed?'⚡':'🔄'} <b>${sig.confirmed?'MULTI-CONFIRMED':'ROTATION'}</b> ${re} ${regime?.regime||''}`,
    `🎯 <b>${sig.symbol.replace('USDT','')}</b> ← <b>${sig.leader.replace('USDT','')}</b>`,
    `📊 Leader +${sig.leaderGain}% | Own ${sig.ownChange1h>=0?'+':''}${sig.ownChange1h}% | Lag ${sig.lag}%`,
    `📐 Stage: <b>${sig.breakout?.stage||'—'}</b> | VP: ${sig.vpLabel}`,
    `💹 RS vs BTC: ${sig.rs1h>=0?'+':''}${sig.rs1h}% | Vol: ${sig.volQuality?.volQualityLabel||'—'}`,
    `${sig.futuresLabel?`📈 Futures: ${sig.futuresLabel}`:''}`,
    `💪 Score: <b>${sig.score}%</b> (Nar:${sb.narrative||0} Cap:${sb.capTier||0} VP:${sb.vpLevel||0} RS:${sb.relStrength||0})`,
    `🎯 R/R: ${sig.rr||'—'}x | Catch-up: +${sig.catchUpPct}%`,
    `🚫 Invalidation: $${sig.breakout?.invalidation||'—'}`,
    `⛔ Max entry: $${sig.breakout?.doNotChaseAbove||'—'}`,
  ].filter(Boolean).join('\n')).catch(console.error);
}

// ── Background scan ───────────────────────────────────────────────────────────
async function runScan() {
  if (scanInProgress){console.log('[SCAN] Already running');return;}
  scanInProgress=true; rotationCache.scanning=true;
  console.log(`[SCAN START] ${ALL_SYMBOLS.length} symbols`);

  // Phase 1: Regime first
  let regime=null;
  try {
    const [b1h,b4h,e4h]=await Promise.all([fetchKlines('BTCUSDT','1h',60),fetchKlines('BTCUSDT','4h',20),fetchKlines('ETHUSDT','4h',20)]);
    regime=assessRegime(b1h,b4h,e4h);
    console.log(`[REGIME] ${regime.regime} | BTC4h:${regime.btcTrend4h} | ETH/BTC:${regime.ethBtcTrend}`);
  } catch(e){console.log('[WARN] Regime:',e.message);}

  // Scan all coins
  const newMetrics={};
  for (let i=0;i<ALL_SYMBOLS.length;i+=4) {
    const batch=ALL_SYMBOLS.slice(i,i+4);
    await Promise.allSettled(batch.map(async sym=>{
      try {
        const [c1h,c4h,c1d]=await Promise.all([fetchKlines(sym,'1h',60),fetchKlines(sym,'4h',20),fetchKlines(sym,'1d',5)]);
        const last=c1h[c1h.length-1];
        const open1h=c1h[c1h.length-2]?.close||c1h[0].open;
        const first4h=c4h[c4h.length-2]?.close||c4h[0].open;
        const first24h=c1d[c1d.length-2]?.close||c1d[0].open;
        const change1h=((last.close-open1h)/open1h)*100;
        const change4h=((last.close-first4h)/first4h)*100;
        const change24h=((last.close-first24h)/first24h)*100;
        const recentVols=c1h.slice(-21,-1).map(c=>c.volume);
        const avgVol=recentVols.reduce((a,b)=>a+b,0)/recentVols.length;
        const volRatio=avgVol>0?last.volume/avgVol:1;
        const quoteVol24h=c1h.slice(-24).reduce((a,c)=>a+c.quoteVol,0);
        if (quoteVol24h<MIN_QUOTE_VOL_24H*0.5) return; // hard liquidity cut
        const vp=calcVP(c1h);
        const volQuality=assessVolumeQuality(c1h);
        newMetrics[sym]={ price:last.close, change1h, change4h, change24h, volRatio, quoteVol24h, vp, volQuality, c1h, c4h, c1d };
      } catch(e){console.log(`[WARN] ${sym}:${e.message}`);}
    }));
    await new Promise(r=>setTimeout(r,350));
  }

  // Phase 5: check outcomes
  await checkOutcomes(newMetrics);

  // Generate signals
  const sS=detectSectorRotation(newMetrics,regime);
  const cS=detectCorrelationDivergence(newMetrics,regime);
  const vS=detectVolumeFlow(newMetrics,regime);
  const all=[...sS,...cS,...vS].sort((a,b)=>b.score-a.score);

  // Dedup by symbol
  const bySymbol=new Map();
  for(const s of all){if(!bySymbol.has(s.symbol))bySymbol.set(s.symbol,[]);bySymbol.get(s.symbol).push(s);}
  const deduped=[];
  for(const[,sigs]of bySymbol){
    sigs.sort((a,b)=>b.score-a.score);
    const best={...sigs[0]};
    const allTypes=[...new Set(sigs.map(s=>s.type))];
    const confirmed=allTypes.length>1;
    if(confirmed) best.score=Math.min(100,best.score+10);
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
    } catch {sig.futuresLabel='—';}
  }));

  // Phase 5: record for hit tracking
  deduped.slice(0,20).forEach(s=>recordSignal(s));

  // Alert
  deduped.slice(0,8).forEach(s=>alertSignal(s,regime));

  // Sector summary
  const sectorSummary={};
  Object.entries(SECTORS).forEach(([sector,coins])=>{
    const cd=coins.filter(s=>newMetrics[s]).map(s=>({sym:s,...newMetrics[s]}));
    if(!cd.length) return;
    const avgC1h=cd.reduce((a,c)=>a+c.change1h,0)/cd.length;
    const avgC4h=cd.reduce((a,c)=>a+c.change4h,0)/cd.length;
    const maxVol=Math.max(...cd.map(c=>c.volRatio));
    const ldr=cd.sort((a,b)=>b.change1h-a.change1h)[0];
    sectorSummary[sector]={avgChange1h:parseFloat(avgC1h.toFixed(3)),avgChange4h:parseFloat(avgC4h.toFixed(3)),maxVolRatio:parseFloat(maxVol.toFixed(2)),leader:ldr.sym,coins:cd.length};
  });

  rotationCache={signals:deduped, metrics:newMetrics, sectors:sectorSummary, regime,
    hitStats:getHitRateStats(), ts:new Date().toISOString(), scanning:false, coinCount:Object.keys(newMetrics).length};
  scanInProgress=false;
  console.log(`[SCAN DONE] ${Object.keys(newMetrics).length} coins, ${deduped.length} signals | ${regime?.regime||'—'}`);
  sendTelegram([`🔄 <b>Rotation Scan Complete v3</b>`,`📊 Regime: <b>${regime?.regime||'—'}</b>`,`${Object.keys(newMetrics).length} coins · ${deduped.length} signals`,`🔄${sS.length} ⚖️${cS.length} 💰${vS.length}`].join('\n')).catch(()=>{});
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function setCORS(res){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');}
const ipMap=new Map();
function isRateLimited(ip,limit=30){const n=Date.now(),e=ipMap.get(ip)||{count:0,reset:n+60000};if(n>e.reset){e.count=0;e.reset=n+60000;}e.count++;ipMap.set(ip,e);return e.count>limit;}
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
    return res.end(JSON.stringify({ok:true,signals:rotationCache.signals||[],metrics:rotationCache.metrics||{},sectors:rotationCache.sectors||{},regime:rotationCache.regime||null,hitStats:rotationCache.hitStats||null,ts:rotationCache.ts||new Date().toISOString(),scanning:rotationCache.scanning||false,coinCount:rotationCache.coinCount||0}));
  }
  if(pn==='/api/trigger-scan'){
    if(isRateLimited(clientIP,5)){res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:false,message:'Too many requests'}));}
    if(scanInProgress){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:false,message:'Already scanning'}));}
    runScan().catch(console.error);
    res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,message:'Scan started'}));
  }
  if(pn==='/api/sectors'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,sectors:rotationCache.sectors||{}}));}
  if(pn==='/api/hitstats'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,...getHitRateStats()}));}
  if(pn==='/api/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,coinCount:rotationCache.coinCount,ts:rotationCache.ts,scanning:scanInProgress,regime:rotationCache.regime?.regime}));}
  res.writeHead(404);res.end('Not found');
});

server.listen(PORT,HOST,()=>{
  console.log(`ROTATION SCREENER v3 on ${HOST}:${PORT}`);
  if(!TG_TOKEN) console.warn('[WARN] TG_TOKEN not set');
  sendTelegram('🟢 <b>ROTATION SCREENER v3 ONLINE</b>').catch(()=>{});
  setTimeout(()=>runScan().catch(console.error),3000);
  setInterval(()=>runScan().catch(console.error),10*60*1000);
});
