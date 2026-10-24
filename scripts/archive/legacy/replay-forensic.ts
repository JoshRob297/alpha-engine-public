/**
 * Motor de Replay Ciego 1 Año - Versión Forense Sin Límites
 * Registra cada trade en /mnt/storage/alpha-backtest/trades.jsonl (streaming append-only)
 * Respeta el ciclo natural del Grid (1 re-evaluación por vela horaria, fills L1/L2 usando High/Low reales)
 */

import { writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { HistoricalMarketFeed } from "../src/research/historical-feed.js";
import { GridBot, type Genome } from "../src/genetic/bot.js";
import { ShadowLPEngine } from "../src/dex/shadow-lp-simulator.js";
import { evaluateExitGovernance } from "../src/guardrails/exit-governance.js";
import { getRegimePolicy } from "../src/guardrails/regime-policy.js";

const OUT_DIR = "/mnt/storage/alpha-backtest";
if (!existsSync(OUT_DIR)) {
  mkdirSync(OUT_DIR, { recursive: true });
}

const TRADES_JSONL = join(OUT_DIR, "trades.jsonl");
if (existsSync(TRADES_JSONL)) {
  unlinkSync(TRADES_JSONL); // Limpiar corrida previa
}

// Genomas idénticos a producción
const DEFAULT_BTC_GENOME: Genome = {
  family: 3,
  lookback: 54,
  entryZ: 2.2,
  levels: 2,
  spacing: 0.004,
  mult: 1.1,
  tp: 0.038,
  stop: 0.075,
};

const DEFAULT_SOL_GENOME: Genome = {
  family: 3,
  lookback: 54,
  entryZ: 2.2,
  levels: 2,
  spacing: 0.004,
  mult: 1.1,
  tp: 0.038,
  stop: 0.075,
};

export interface FullAuditTrade {
  id: string;
  timestamp: string;
  ticker: string;
  action: string;
  price: number;
  qty: number;
  pnlNetMxn: number;
  pnlPct: number;
  balanceMxnCumulative: number;
}

export async function runForensicReplay() {
  console.log("=== INICIANDO MOTOR DE REPLAY FORENSE (8,760 HORAS / STREAMING JSONL) ===");
  const feed = new HistoricalMarketFeed();
  const totalSteps = feed.getTotalSteps();
  console.log(`Dataset cargado: ${totalSteps} horas continuas (Binance BTC/SOL + Bitso USD/MXN)`);

  const initialCapitalUsd = 1000;
  const policy = getRegimePolicy("BALANCED_RANGE");
  const fiatCapitalUsd = initialCapitalUsd * policy.fiatPct; // $400 USD
  const cexTotalUsd = initialCapitalUsd * (1 - policy.fiatPct) * policy.cexPct; // $300 USD
  const dexTotalUsd = initialCapitalUsd * (1 - policy.fiatPct) * policy.dexPct; // $300 USD

  const btcBot = new GridBot(DEFAULT_BTC_GENOME, cexTotalUsd * 0.863);
  const solBot = new GridBot(DEFAULT_SOL_GENOME, cexTotalUsd * 0.137);

  const dexSnap = feed.getDexSnapshot();
  const dexPools = {
    BTC: new ShadowLPEngine(dexSnap.BTC || { symbol: "WETH-CBBTC", protocol: "Aerodrome Slipstream", feeAprPct: 68.9, price: 0.032 }, dexTotalUsd * 0.475),
    AERO: new ShadowLPEngine(dexSnap.AERO || { symbol: "WETH-AERO", protocol: "Aerodrome Slipstream", feeAprPct: 548.5, price: 0.88 }, dexTotalUsd * 0.166),
    YIELD: new ShadowLPEngine(dexSnap.YIELD || { symbol: "USDC-CBBTC", protocol: "Aerodrome Slipstream", feeAprPct: 231.25, price: 84000 }, dexTotalUsd * 0.359),
  };

  const startTime = Date.now();
  let cumulativePnlMxn = 0;
  let tradeSeq = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let emergencyCount = 0;
  let hardStopCount = 0;
  let tpCount = 0;
  let pingPongCount = 0;

  let grossProfitMxn = 0;
  let grossLossMxn = 0;

  let peakCumulativeMxn = 0;
  let maxDrawdownMxn = 0;
  let worstTradePct = 0;

  const recordTrade = (ticker: string, action: string, price: number, qty: number, pnlNetMxn: number, pnlPct: number, ts: number) => {
    tradeSeq++;
    cumulativePnlMxn += pnlNetMxn;

    if (pnlNetMxn > 0) {
      winningTrades++;
      grossProfitMxn += pnlNetMxn;
    } else if (pnlNetMxn < 0) {
      losingTrades++;
      grossLossMxn += Math.abs(pnlNetMxn);
    }

    if (cumulativePnlMxn > peakCumulativeMxn) {
      peakCumulativeMxn = cumulativePnlMxn;
    }
    const currentDd = peakCumulativeMxn - cumulativePnlMxn;
    if (currentDd > maxDrawdownMxn) {
      maxDrawdownMxn = currentDd;
    }
    if (pnlPct < worstTradePct) {
      worstTradePct = pnlPct;
    }

    if (action.includes("EMERGENCY")) emergencyCount++;
    else if (action.includes("STOP")) hardStopCount++;
    else if (action.includes("PINGPONG")) pingPongCount++;
    else if (action.includes("TP_")) tpCount++;

    const item: FullAuditTrade = {
      id: `tr_${tradeSeq}`,
      timestamp: new Date(ts).toISOString(),
      ticker,
      action,
      price: parseFloat(price.toFixed(2)),
      qty: parseFloat(qty.toFixed(6)),
      pnlNetMxn: parseFloat(pnlNetMxn.toFixed(2)),
      pnlPct: parseFloat(pnlPct.toFixed(2)),
      balanceMxnCumulative: parseFloat(cumulativePnlMxn.toFixed(2)),
    };

    appendFileSync(TRADES_JSONL, JSON.stringify(item) + "\n");
  };

  // Traqueo diario de equity
  const dailyEquity: Array<{ day: number; date: string; pnlMxn: number; dexFeesUsd: number }> = [];

  for (let step = 0; step < totalSteps; step++) {
    feed.setStep(step);
    const ts = feed.getCurrentTimestamp();
    const usdMxnRate = feed.getUsdMxnRate();

    const btcBook = feed.getOrderBook("BTC");
    const solBook = feed.getOrderBook("SOL");
    const btcCandle = feed.getCandle("BTC");
    const solCandle = feed.getCandle("SOL");

    const macroRegime = btcBook.ofiScore > 0.40 ? "AGGRESSIVE_ACCUMULATION" : btcBook.isLiquidityEvaporating || btcBook.spreadBps > 30 ? "DEFENSIVE_STRESS" : "BALANCED_RANGE";

    // 1. Proceso CEX Natural (BTC & SOL)
    await processAssetStep("BTC", "btc_usd", btcBot, btcBook, btcCandle, macroRegime, recordTrade, ts, usdMxnRate);
    await processAssetStep("SOL", "sol_usd", solBot, solBook, solCandle, macroRegime, recordTrade, ts, usdMxnRate);

    // 2. Proceso DEX (Acumulación Horaria de Fees e Impermanent Loss)
    const wethCbbtcPrice = btcBook.midPrice > 0 ? 2600 / btcBook.midPrice : 0.032;
    await dexPools.BTC.step(wethCbbtcPrice, 0, undefined, macroRegime, 0.70);
    await dexPools.AERO.step(0.88 + Math.sin(step / 100) * 0.05, 0, undefined, macroRegime, 0.25);
    await dexPools.YIELD.step(btcBook.midPrice, 0, undefined, macroRegime, 0.40);

    const stepHourlyDex = (pool: any) => {
      const snap = pool.getSnapshot();
      const annualRate = pool.pool.feeAprPct / 100;
      const hourRate = annualRate / 8760;
      snap.accumulatedFeesUsd += snap.currentCapitalUsd * hourRate;
    };
    stepHourlyDex(dexPools.BTC);
    stepHourlyDex(dexPools.AERO);
    stepHourlyDex(dexPools.YIELD);

    // Snapshot cada 24 horas
    if (step % 24 === 0 || step === totalSteps - 1) {
      const dexFees = dexPools.BTC.getSnapshot().accumulatedFeesUsd + dexPools.AERO.getSnapshot().accumulatedFeesUsd + dexPools.YIELD.getSnapshot().accumulatedFeesUsd;
      dailyEquity.push({
        day: Math.floor(step / 24) + 1,
        date: new Date(ts).toISOString().split("T")[0],
        pnlMxn: parseFloat(cumulativePnlMxn.toFixed(2)),
        dexFeesUsd: parseFloat(dexFees.toFixed(2)),
      });
    }

    if (step % 1000 === 0 && step > 0) {
      console.log(`[STREAMING] Hora ${step}/${totalSteps} (${((step / totalSteps) * 100).toFixed(1)}%). Trades acumulados en JSONL: ${tradeSeq}`);
    }
  }

  const finalDexFees = dexPools.BTC.getSnapshot().accumulatedFeesUsd + dexPools.AERO.getSnapshot().accumulatedFeesUsd + dexPools.YIELD.getSnapshot().accumulatedFeesUsd;
  const initialEquityMxn = initialCapitalUsd * 17.72;
  const maxDrawdownPct = initialEquityMxn > 0 ? (maxDrawdownMxn / initialEquityMxn) * 100 : 0;
  const decisiveTrades = winningTrades + losingTrades;
  const winRatePct = decisiveTrades > 0 ? (winningTrades / decisiveTrades) * 100 : 0;
  const profitFactor = grossLossMxn > 0 ? grossProfitMxn / grossLossMxn : 99.9;

  const summaryPayload = {
    auditDate: new Date().toISOString(),
    totalHoursSimulated: totalSteps,
    simulationDays: (totalSteps / 24).toFixed(1),
    elapsedSeconds: ((Date.now() - startTime) / 1000).toFixed(2),
    initialCapitalUsd,
    cexPnlMxnTotal: parseFloat(cumulativePnlMxn.toFixed(2)),
    finalDexFeesUsd: parseFloat(finalDexFees.toFixed(2)),
    tradesCount: {
      total: tradeSeq,
      winning: winningTrades,
      losing: losingTrades,
      winRatePct: parseFloat(winRatePct.toFixed(1)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      grossProfitMxn: parseFloat(grossProfitMxn.toFixed(2)),
      grossLossMxn: parseFloat(grossLossMxn.toFixed(2)),
      hardStops: hardStopCount,
      takeProfits: tpCount,
      pingPongRecycles: pingPongCount,
      emergencyDeleverage: emergencyCount,
    },
    risk: {
      maxDrawdownMxn: parseFloat(maxDrawdownMxn.toFixed(2)),
      maxDrawdownPct: parseFloat(maxDrawdownPct.toFixed(2)),
      worstTradePct: parseFloat(worstTradePct.toFixed(2)),
    },
    dailySnapshotsCount: dailyEquity.length,
    firstDay: dailyEquity[0],
    lastDay: dailyEquity[dailyEquity.length - 1],
    jsonlPath: TRADES_JSONL,
  };

  const summaryFile = join(OUT_DIR, "forensic_summary.json");
  writeFileSync(summaryFile, JSON.stringify(summaryPayload, null, 2));

  console.log("\n=== AUDITORÍA FORENSE 1 AÑO FINALIZADA ===");
  console.log(`Archivo de streaming JSONL : ${TRADES_JSONL}`);
  console.log(`Archivo de resumen general : ${summaryFile}`);
  console.log(`Total Trades Auditados     : ${tradeSeq} (CERO TRUNCADOS)`);
  console.log(`Win Rate Real              : ${winRatePct.toFixed(1)}%`);
  console.log(`Profit Factor Real         : ${profitFactor.toFixed(2)}`);
  console.log(`Max Drawdown Real          : ${maxDrawdownPct.toFixed(2)}%`);
  console.log(`PnL CEX Realizado          : +$${cumulativePnlMxn.toFixed(2)} MXN`);
  console.log(`DEX Fees Totales           : +$${finalDexFees.toFixed(2)} USD`);
}

async function processAssetStep(
  ticker: string,
  book: string,
  bot: GridBot,
  bookState: any,
  candle: any,
  macroRegime: string,
  recordTrade: (ticker: string, action: string, price: number, qty: number, pnlNetMxn: number, pnlPct: number, ts: number) => void,
  ts: number,
  fxRate: number
) {
  const midPrice = bookState.midPrice;
  const isToxic = bookState.isLiquidityEvaporating || bookState.ofiScore < -0.45;

  // 1. Apertura si no hay posición
  if (!bot.inPos && bot.levels.length === 0 && !isToxic) {
    bot._open(midPrice, 0, 0.40, 1.0);
  }

  if (bot.inPos) {
    // 2. Hard Stop incondicional
    if (bot.stop > 0 && midPrice <= bot.stop) {
      const pnlNetMxn = (midPrice - bot.avg) * bot.qty * fxRate;
      const pnlPct = ((midPrice / bot.avg) - 1) * 100;
      recordTrade(ticker, "HARD_STOP_LOSS", midPrice, bot.qty, pnlNetMxn, pnlPct, ts);
      bot._close(midPrice, 0, "STOP");
      return;
    }

    // 3. Gobernanza Causal de Salidas
    const exitEval = await evaluateExitGovernance(
      ticker,
      book,
      bot.avg,
      midPrice,
      bot.tp,
      bookState.ofiScore,
      bookState.spreadBps,
      macroRegime,
      0
    );

    if (exitEval.action === "TAKE_PROFIT_PARTIAL" && exitEval.fractionToClose > 0) {
      const qtyClose = bot.qty * exitEval.fractionToClose;
      const pnlNetMxn = (midPrice - bot.avg) * qtyClose * fxRate;
      const pnlPct = ((midPrice / bot.avg) - 1) * 100;
      recordTrade(ticker, "TP_PARTIAL_DCA", midPrice, qtyClose, pnlNetMxn, pnlPct, ts);

      const entryAvg = bot.avg;
      bot.qty -= qtyClose;
      bot.cost = Math.max(0, bot.cost - qtyClose * entryAvg);
      bot.cash += qtyClose * midPrice;

      // Trailing stop a Break-Even idéntico a producción
      const breakEvenStop = entryAvg * 1.002;
      const trailingStop = midPrice * 0.996;
      bot.stop = Math.max(bot.stop, breakEvenStop, trailingStop);
    } else if (
      exitEval.action === "FRONT_RUN_EXIT" ||
      exitEval.action === "EMERGENCY_DELEVERAGE" ||
      (exitEval.action === "TAKE_PROFIT_STANDARD" && midPrice >= bot.tp)
    ) {
      const actionLabel = exitEval.action === "FRONT_RUN_EXIT" ? "TP_FRONTRUN_LAYA" : exitEval.action === "EMERGENCY_DELEVERAGE" ? "EMERGENCY_DELEVERAGE" : "TAKE_PROFIT_FULL";
      const pnlNetMxn = (midPrice - bot.avg) * bot.qty * fxRate;
      const pnlPct = ((midPrice / bot.avg) - 1) * 100;
      recordTrade(ticker, actionLabel, midPrice, bot.qty, pnlNetMxn, pnlPct, ts);
      bot._close(midPrice, 0, exitEval.action === "EMERGENCY_DELEVERAGE" ? "STOP" : "TP");
      return;
    }

    // 4. Llenados pasivos L1/L2 usando los High/Low de la vela real
    for (const lvl of bot.levels) {
      if (!lvl.filled && candle.low <= lvl.price) {
        bot._fill(lvl, lvl.price, 0);
      } else if (lvl.filled && lvl.name !== "L1") {
        const targetBounce = (lvl.fillPrice || lvl.price) * 1.004;
        if (candle.high >= targetBounce) {
          const chunkQty = lvl.usd / (lvl.fillPrice || lvl.price);
          const pnlNetMxn = (targetBounce - (lvl.fillPrice || lvl.price)) * chunkQty * fxRate;
          recordTrade(ticker, `TP_GRID_PINGPONG_${lvl.name}`, targetBounce, chunkQty, pnlNetMxn, 0.40, ts);

          bot.cash += chunkQty * targetBounce;
          bot.qty = Math.max(0, bot.qty - chunkQty);
          bot.cost = Math.max(0, bot.cost - lvl.usd);
          lvl.filled = false;
        }
      }
    }
  }
}

if (import.meta.main) {
  runForensicReplay().catch((err) => {
    console.error("[FATAL ERROR EN FORENSIC REPLAY]:", err);
    process.exit(1);
  });
}
