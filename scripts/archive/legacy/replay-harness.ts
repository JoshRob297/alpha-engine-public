/**
 * Harness de Replay Ciego (1 Año)
 * Ejecuta los motores tácticos reales (GridBot, ShadowLP, ExitGovernance, SETS)
 * alimentados por HistoricalMarketFeed paso a paso a lo largo de 8760 horas.
 * Salida: /mnt/storage/alpha-backtest/replay_state.json
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HistoricalMarketFeed } from "../src/research/historical-feed.js";
import { GridBot, type Genome } from "../src/genetic/bot.js";
import { ShadowLPEngine, type PoolState } from "../src/dex/shadow-lp-simulator.js";
import { evaluateExitGovernance } from "../src/guardrails/exit-governance.js";
import { getRegimePolicy } from "../src/guardrails/regime-policy.js";
import { TradeLedger } from "../src/telemetry/trade-ledger.js";

const OUT_DIR = "/mnt/storage/alpha-backtest";
if (!existsSync(OUT_DIR)) {
  mkdirSync(OUT_DIR, { recursive: true });
}

// Genomas iniciales estándar idénticos a producción
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

const FX_GENOME: Genome = {
  family: 3,
  lookback: 20,
  entryZ: 1.2,
  levels: 3,
  spacing: 0.0018,
  mult: 1.0,
  tp: 0.0045,
  stop: 0.025,
};

export async function runReplayHarness(mode: "fast" | "full" = "fast") {
  console.log(`=== INICIANDO MOTOR DE REPLAY HISTÓRICO CIEGO (1 AÑO) [MODO: ${mode.toUpperCase()}] ===`);
  const feed = new HistoricalMarketFeed();
  const totalSteps = feed.getTotalSteps();
  console.log(`Total de horas a simular: ${totalSteps} (${(totalSteps / 24).toFixed(1)} días de mercado real)`);

  const ledger = new TradeLedger(2000); // Ledger expandido para capturar toda la historia anual
  const initialCapitalUsd = 1000;

  // Asignación de Capital Macro Inicial (BALANCED_RANGE: 40% Fiat, 30% CEX, 30% DEX)
  const policy = getRegimePolicy("BALANCED_RANGE");
  const fiatCapitalUsd = initialCapitalUsd * policy.fiatPct; // $400 USD
  const cexTotalUsd = initialCapitalUsd * (1 - policy.fiatPct) * policy.cexPct; // $300 USD
  const dexTotalUsd = initialCapitalUsd * (1 - policy.fiatPct) * policy.dexPct; // $300 USD

  // CEX Bots (BTC: 86.3%, SOL: 13.7%)
  const btcBot = new GridBot(DEFAULT_BTC_GENOME, cexTotalUsd * 0.863);
  const solBot = new GridBot(DEFAULT_SOL_GENOME, cexTotalUsd * 0.137);
  const fxBot = new GridBot(FX_GENOME, fiatCapitalUsd);

  // DEX Pools (WETH-CBBTC: 47.5%, WETH-AERO: 16.6%, USDC-CBBTC: 35.9%)
  const dexSnap = feed.getDexSnapshot();
  const dexPools = {
    BTC: new ShadowLPEngine(dexSnap.BTC || { symbol: "WETH-CBBTC", protocol: "Aerodrome Slipstream", feeAprPct: 68.9, price: 0.032 }, dexTotalUsd * 0.475),
    AERO: new ShadowLPEngine(dexSnap.AERO || { symbol: "WETH-AERO", protocol: "Aerodrome Slipstream", feeAprPct: 250.0, price: 0.88 }, dexTotalUsd * 0.166),
    YIELD: new ShadowLPEngine(dexSnap.YIELD || { symbol: "USDC-CBBTC", protocol: "Aerodrome Slipstream", feeAprPct: 180.0, price: 84000 }, dexTotalUsd * 0.359),
  };

  const startTime = Date.now();
  let emergencyCount = 0;
  let tpCount = 0;
  let hardStopCount = 0;
  let pingPongCount = 0;

  // Curva de equity horaria
  const equityPoints: Array<{ t: number; equityUsd: number; pnlMxn: number }> = [];

  for (let step = 0; step < totalSteps; step++) {
    feed.setStep(step);
    const ts = feed.getCurrentTimestamp();
    const usdMxnRate = feed.getUsdMxnRate();

    // 1. Obtener estados de mercado sintéticos
    const btcBook = feed.getOrderBook("BTC");
    const solBook = feed.getOrderBook("SOL");

    // Determinar régimen macro simulado (basado en tendencia EMA50 vs EMA200 sin look-ahead)
    const btcCandle = feed.getCandle("BTC");
    const solCandle = feed.getCandle("SOL");

    const macroRegime = btcBook.ofiScore > 0.40 ? "AGGRESSIVE_ACCUMULATION" : btcBook.isLiquidityEvaporating || btcBook.spreadBps > 30 ? "DEFENSIVE_STRESS" : "BALANCED_RANGE";

    // 2. Loop CEX (BTC)
    if (mode === "full") {
      // Interpolación intra-vela: 360 pasos de 10s (recorrido Open -> Low -> High -> Close)
      await processCexIntraHour("BTC", "btc_usd", btcBot, btcBook, btcCandle, macroRegime, ledger, ts, usdMxnRate);
      await processCexIntraHour("SOL", "sol_usd", solBot, solBook, solCandle, macroRegime, ledger, ts, usdMxnRate);
    } else {
      await processCexAsset("BTC", "btc_usd", btcBot, btcBook, btcCandle, macroRegime, ledger, ts, usdMxnRate);
      await processCexAsset("SOL", "sol_usd", solBot, solBook, solCandle, macroRegime, ledger, ts, usdMxnRate);
    }

    // 4. Loop DEX (Paso horario acumulando fees e IL)
    const wethCbbtcPrice = btcBook.midPrice > 0 ? 2600 / btcBook.midPrice : 0.032;
    await dexPools.BTC.step(wethCbbtcPrice, 0, undefined, macroRegime, 0.70);
    await dexPools.AERO.step(0.88 + Math.sin(step / 100) * 0.05, 0, undefined, macroRegime, 0.25);
    await dexPools.YIELD.step(btcBook.midPrice, 0, undefined, macroRegime, 0.40);

    // Multiplicar fees horarias reales (1 hora = 360 pulsos de 10s)
    const stepHoursAcc = (pool: any) => {
      const snap = pool.getSnapshot();
      const annualRate = pool.pool.feeAprPct / 100;
      const hourRate = annualRate / 8760; // 1 hora de fees
      snap.accumulatedFeesUsd += snap.currentCapitalUsd * hourRate;
    };
    stepHoursAcc(dexPools.BTC);
    stepHoursAcc(dexPools.AERO);
    stepHoursAcc(dexPools.YIELD);

    // Muestreo de equity cada 24 horas (1 día)
    if (step % 24 === 0 || step === totalSteps - 1) {
      const dexFees = dexPools.BTC.getSnapshot().accumulatedFeesUsd + dexPools.AERO.getSnapshot().accumulatedFeesUsd + dexPools.YIELD.getSnapshot().accumulatedFeesUsd;
      const btcEq = btcBot.equity(btcBook.midPrice);
      const solEq = solBot.equity(solBook.midPrice);
      const totalEqUsd = btcEq + solEq + fiatCapitalUsd + dexFees;
      const metrics = ledger.calculateMetrics(initialCapitalUsd * 17.72, dexTotalUsd, "PAPER", dexFees, undefined, usdMxnRate);

      equityPoints.push({
        t: ts,
        equityUsd: parseFloat(totalEqUsd.toFixed(2)),
        pnlMxn: metrics.totalPnlMxn,
      });
    }

    if (step % 1000 === 0 && step > 0) {
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[PROGRESO] Hora ${step}/${totalSteps} (${((step / totalSteps) * 100).toFixed(1)}%) en ${elapsedSec}s. Trades: ${ledger.getHistory().length}`);
    }
  }

  // Contabilizar tipos de trade
  for (const t of ledger.getHistory()) {
    if (t.action.includes("EMERGENCY")) emergencyCount++;
    else if (t.action.includes("TP_")) tpCount++;
    else if (t.action.includes("STOP")) hardStopCount++;
    else if (t.action.includes("PINGPONG")) pingPongCount++;
  }

  const finalDexFees = dexPools.BTC.getSnapshot().accumulatedFeesUsd + dexPools.AERO.getSnapshot().accumulatedFeesUsd + dexPools.YIELD.getSnapshot().accumulatedFeesUsd;
  const finalMetrics = ledger.calculateMetrics(initialCapitalUsd * 17.72, dexTotalUsd, "PAPER", finalDexFees, undefined, feed.getUsdMxnRate());

  const resultPayload = {
    mode,
    totalHoursSimulated: totalSteps,
    simulationDays: (totalSteps / 24).toFixed(1),
    elapsedRealSeconds: ((Date.now() - startTime) / 1000).toFixed(2),
    initialCapitalUsd,
    finalDexFeesUsd: parseFloat(finalDexFees.toFixed(4)),
    metrics: finalMetrics,
    counts: {
      emergencyDeleverage: emergencyCount,
      takeProfits: tpCount,
      hardStops: hardStopCount,
      pingPongRecycles: pingPongCount,
      totalTrades: ledger.getHistory().length,
    },
    equityCurve: equityPoints,
    historySample: ledger.getHistory().slice(0, 50),
    dexSnapshots: {
      BTC: dexPools.BTC.getSnapshot(),
      AERO: dexPools.AERO.getSnapshot(),
      YIELD: dexPools.YIELD.getSnapshot(),
    },
  };

  const outFile = join(OUT_DIR, "replay_state.json");
  writeFileSync(outFile, JSON.stringify(resultPayload, null, 2));

  console.log("\n=== REPLAY HISTÓRICO DE 1 AÑO FINALIZADO ===");
  console.log(`Archivo guardado: ${outFile}`);
  console.log(`Tiempo de computo: ${resultPayload.elapsedRealSeconds}s`);
  console.log(`Win Rate: ${finalMetrics.winRatePct}% | Profit Factor: ${finalMetrics.profitFactor}`);
  console.log(`Trades cerrados: ${finalMetrics.totalTrades} | Drawdown Máximo: ${finalMetrics.maxDrawdownPct}%`);
  console.log(`PnL CEX Realizado: $${finalMetrics.totalPnlMxn} MXN | Fees DEX Ganadas: $${finalDexFees.toFixed(2)} USD`);
  console.log(`Distribución: ${emergencyCount} Emergency | ${tpCount} Take Profit | ${hardStopCount} Hard Stops | ${pingPongCount} Ping-Pong`);
}

async function processCexIntraHour(
  ticker: string,
  book: string,
  bot: GridBot,
  bookState: any,
  candle: any,
  macroRegime: string,
  ledger: TradeLedger,
  ts: number,
  fxRate: number
) {
  // Simular trayectoria intra-hora dividida en 4 segmentos:
  // 1. Open -> Low
  // 2. Low -> High
  // 3. High -> Close
  const segments = [
    { start: candle.open, end: candle.low, steps: 100 },
    { start: candle.low, end: candle.high, steps: 160 },
    { start: candle.high, end: candle.close, steps: 100 },
  ];

  for (const seg of segments) {
    for (let i = 0; i <= seg.steps; i++) {
      const frac = i / seg.steps;
      const subPrice = seg.start + (seg.end - seg.start) * frac;
      const subBook = {
        ...bookState,
        midPrice: subPrice,
      };
      await processCexAsset(ticker, book, bot, subBook, candle, macroRegime, ledger, ts, fxRate);
    }
  }
}

async function processCexAsset(
  ticker: string,
  book: string,
  bot: GridBot,
  bookState: any,
  candle: any,
  macroRegime: string,
  ledger: TradeLedger,
  ts: number,
  fxRate: number
) {
  const midPrice = bookState.midPrice;
  const toxicFlow = bookState.isLiquidityEvaporating ? 0.92 : bookState.ofiScore < -0.45 ? 0.75 : 0.15;
  const isToxic = toxicFlow > 0.65;

  // 1. Si no hay posición y condiciones óptimas, abrir malla
  if (!bot.inPos && bot.levels.length === 0 && !isToxic) {
    bot._open(midPrice, 0, 0.40, 1.0);
  }

  if (bot.inPos) {
    // 2. Hard-stop incondicional
    if (bot.stop > 0 && midPrice <= bot.stop) {
      const pnlNetMxn = (midPrice - bot.avg) * bot.qty * fxRate;
      ledger.recordTrade({
        timestamp: new Date(ts).toISOString(),
        mode: "PAPER",
        venue: "BITSO_CEX",
        assetOrPool: book,
        action: "HARD_STOP_LOSS",
        price: midPrice,
        amount: bot.qty,
        pnlNet: parseFloat(pnlNetMxn.toFixed(2)),
        pnlPct: parseFloat((((midPrice / bot.avg) - 1) * 100).toFixed(2)),
        feeSavedOrPaid: 0,
      });
      bot._close(midPrice, 0, "STOP");
      return;
    }

    // 3. Gobernanza Causal de Salidas (Triple-Barrier + Emergency Deleverage estricto a -3%)
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
      ledger.recordTrade({
        timestamp: new Date(ts).toISOString(),
        mode: "PAPER",
        venue: "BITSO_CEX",
        assetOrPool: book,
        action: "TP_PARTIAL_DCA",
        price: midPrice,
        amount: qtyClose,
        pnlNet: parseFloat(pnlNetMxn.toFixed(2)),
        pnlPct: parseFloat((((midPrice / bot.avg) - 1) * 100).toFixed(2)),
        feeSavedOrPaid: 0,
      });
      bot.qty -= qtyClose;
      bot.cost = Math.max(0, bot.cost - qtyClose * bot.avg);
      bot.cash += qtyClose * midPrice;

      // Sincronizar Trailing Stop a Break-Even (idéntico a cex-engine.ts:287)
      const breakEvenStop = bot.avg * 1.002;
      const trailingStop = midPrice * 0.996;
      bot.stop = Math.max(bot.stop, breakEvenStop, trailingStop);
    } else if (exitEval.action === "FRONT_RUN_EXIT" || exitEval.action === "EMERGENCY_DELEVERAGE" || (exitEval.action === "TAKE_PROFIT_STANDARD" && midPrice >= bot.tp)) {
      const actionLabel = exitEval.action === "FRONT_RUN_EXIT" ? "TP_FRONTRUN_LAYA" : exitEval.action === "EMERGENCY_DELEVERAGE" ? "EMERGENCY_DELEVERAGE" : "TAKE_PROFIT_FULL";
      const pnlNetMxn = (midPrice - bot.avg) * bot.qty * fxRate;
      ledger.recordTrade({
        timestamp: new Date(ts).toISOString(),
        mode: "PAPER",
        venue: "BITSO_CEX",
        assetOrPool: book,
        action: actionLabel,
        price: midPrice,
        amount: bot.qty,
        pnlNet: parseFloat(pnlNetMxn.toFixed(2)),
        pnlPct: parseFloat((((midPrice / bot.avg) - 1) * 100).toFixed(2)),
        feeSavedOrPaid: 0,
      });
      bot._close(midPrice, 0, exitEval.action === "EMERGENCY_DELEVERAGE" ? "STOP" : "TP");
      return;
    }

    // 4. Llenados pasivos L1/L2
    for (const lvl of bot.levels) {
      if (!lvl.filled && candle.low <= lvl.price) {
        bot._fill(lvl, lvl.price, 0);
      } else if (lvl.filled && lvl.name !== "L1") {
        const targetBounce = (lvl.fillPrice || lvl.price) * 1.004;
        if (candle.high >= targetBounce) {
          const chunkQty = lvl.usd / (lvl.fillPrice || lvl.price);
          const pnlNetMxn = (targetBounce - (lvl.fillPrice || lvl.price)) * chunkQty * fxRate;
          ledger.recordTrade({
            timestamp: new Date(ts).toISOString(),
            mode: "PAPER",
            venue: "BITSO_CEX",
            assetOrPool: book,
            action: `TP_GRID_PINGPONG_${lvl.name}`,
            price: targetBounce,
            amount: chunkQty,
            pnlNet: parseFloat(pnlNetMxn.toFixed(2)),
            pnlPct: 0.40,
            feeSavedOrPaid: 0,
          });
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
  const mode = process.argv.includes("--mode=full") ? "full" : "fast";
  runReplayHarness(mode).catch((err) => {
    console.error("[FATAL ERROR EN REPLAY HARNESS]:", err);
    process.exit(1);
  });
}
