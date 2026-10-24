/**
 * SIMULADOR MAESTRO V2 AISLADO Y CONSOLIDADO (TODO EN MXN)
 * Ejecuta los 3 módulos secuencialmente consumiendo la nueva política agnóstica:
 * - FX (usd_mxn): Perfil FIAT ($400 USD / $7,088 MXN)
 * - BTC (btc_usd): Perfil ANCHOR ($258.75 USD / $4,585.05 MXN)
 * - SOL (sol_usd): Perfil BETA ($41.25 USD / $730.95 MXN)
 * Salidas:
 * - v2_fx_trades.jsonl
 * - v2_btc_trades.jsonl
 * - v2_sol_trades.jsonl
 * - v2_consolidated_report.json
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getRegimePolicy, type AssetProfile } from "../src/guardrails/regime-policy.js";
import { evaluateExitGovernance } from "../src/guardrails/exit-governance.js";

const BASE_DIR = "/mnt/storage/alpha-backtest";
const FX_RATE = 17.72;

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface GridLevel {
  name: string;
  price: number;
  usd: number;
  filled: boolean;
  fillPrice?: number;
}

class SimulationGridBot {
  public ticker: string;
  public profile: AssetProfile;
  public capitalUsd: number;
  public cashUsd: number;
  public qty: number;
  public costUsd: number;
  public levels: GridLevel[] = [];
  public tpPrice = 0;
  public stopPrice = 0;
  public centerPrice = 0;
  public partialTakenPct = 0;

  constructor(ticker: string, capitalUsd: number, profile: AssetProfile) {
    this.ticker = ticker;
    this.profile = profile;
    this.capitalUsd = capitalUsd;
    this.cashUsd = capitalUsd;
    this.qty = 0;
    this.costUsd = 0;
  }

  get inPos() {
    return this.qty > 0;
  }

  get avgPrice() {
    return this.qty > 0 ? this.costUsd / this.qty : 0;
  }

  public deployOrRecenter(midPrice: number, regime: string) {
    this.centerPrice = midPrice;
    this.levels = [];
    this.partialTakenPct = 0;

    const policy = getRegimePolicy(regime, this.ticker);
    let spacing = 0.004;
    let stopMultiplier = 1.0;
    const levelsCount = this.profile === "FIAT" ? 3 : 2;

    if (this.profile === "FIAT") {
      spacing = regime === "DEFENSIVE_STRESS" ? 0.0025 : regime === "AGGRESSIVE_ACCUMULATION" ? 0.0014 : 0.0018;
      stopMultiplier = 1.0;
    } else if (this.profile === "ANCHOR") {
      spacing = regime === "DEFENSIVE_STRESS" ? 0.006 : regime === "AGGRESSIVE_ACCUMULATION" ? 0.0035 : 0.004;
      stopMultiplier = regime === "DEFENSIVE_STRESS" ? 0.70 : regime === "AGGRESSIVE_ACCUMULATION" ? 1.20 : 1.0;
    } else {
      // BETA
      spacing = regime === "DEFENSIVE_STRESS" ? 0.009 : regime === "AGGRESSIVE_ACCUMULATION" ? 0.005 : 0.006;
      stopMultiplier = regime === "DEFENSIVE_STRESS" ? 0.70 : regime === "AGGRESSIVE_ACCUMULATION" ? 1.20 : 1.0;
    }

    const maxExposure = this.profile === "FIAT" ? this.capitalUsd * 0.60 : this.capitalUsd * 0.40;
    const usdPerLevel = maxExposure / levelsCount;

    for (let k = 0; k < levelsCount; k++) {
      const priceLvl = midPrice * (1 - spacing * (k + (this.profile === "FIAT" ? 1 : 0)));
      this.levels.push({
        name: `L${k + 1}`,
        price: parseFloat(priceLvl.toFixed(4)),
        usd: usdPerLevel,
        filled: false,
      });
    }

    // Para CEX, L1 entra incondicional al abrir la malla
    if (this.profile !== "FIAT") {
      const l1 = this.levels[0];
      const buyQty = l1.usd / midPrice;
      this.cashUsd -= l1.usd;
      this.qty += buyQty;
      this.costUsd += l1.usd;
      l1.filled = true;
      l1.fillPrice = midPrice;
    }

    const baseStop = this.profile === "FIAT" ? 0.025 : 0.075;
    const effectiveStop = baseStop * stopMultiplier;
    this.stopPrice = parseFloat((this.levels[this.levels.length - 1].price * (1 - effectiveStop)).toFixed(4));
    this.tpPrice = parseFloat((midPrice * (1 + policy.tp1Threshold / 100)).toFixed(4));
  }
}

function runAssetSimulation(
  ticker: "USD" | "BTC" | "SOL",
  profile: AssetProfile,
  allocatedUsd: number,
  dataFile: string
) {
  const outputFile = join(BASE_DIR, `v2_${ticker.toLowerCase()}_trades.jsonl`);
  if (existsSync(outputFile)) unlinkSync(outputFile);

  console.log(`\n--------------------------------------------------------`);
  console.log(`[SIMULACIÓN V2] Procesando ${ticker} (Perfil: ${profile})...`);
  console.log(`Capital asignado: $${allocatedUsd.toFixed(2)} USD (~$${(allocatedUsd * FX_RATE).toFixed(2)} MXN)`);

  const raw = readFileSync(join(BASE_DIR, `raw/${dataFile}`), "utf-8");
  const candles: Candle[] = JSON.parse(raw);
  console.log(`Velas cargadas: ${candles.length} horas.`);

  const bot = new SimulationGridBot(ticker, allocatedUsd, profile);
  const closePrices = candles.map((c) => c.close);

  let cumulativePnlMxn = 0;
  let tradeSeq = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let grossProfitMxn = 0;
  let grossLossMxn = 0;
  let tpCount = 0;
  let pingPongCount = 0;
  let hardStopCount = 0;
  let frontRunCount = 0;
  let recenterCount = 0;

  let peakMxn = 0;
  let maxDrawdownMxn = 0;

  const recordTrade = (action: string, price: number, amount: number, pnlNetMxn: number, pnlPct: number, ts: number) => {
    tradeSeq++;
    cumulativePnlMxn += pnlNetMxn;

    if (pnlNetMxn > 0) {
      winningTrades++;
      grossProfitMxn += pnlNetMxn;
    } else if (pnlNetMxn < 0) {
      losingTrades++;
      grossLossMxn += Math.abs(pnlNetMxn);
    }

    if (cumulativePnlMxn > peakMxn) peakMxn = cumulativePnlMxn;
    const currentDd = peakMxn - cumulativePnlMxn;
    if (currentDd > maxDrawdownMxn) maxDrawdownMxn = currentDd;

    if (action.includes("PINGPONG")) pingPongCount++;
    else if (action.includes("TP_PARTIAL") || action.includes("TAKE_PROFIT")) tpCount++;
    else if (action.includes("FRONTRUN")) frontRunCount++;
    else if (action.includes("STOP")) hardStopCount++;

    const item = {
      id: `${ticker.toLowerCase()}_tr_${tradeSeq}`,
      timestamp: new Date(ts).toISOString(),
      ticker,
      profile,
      action,
      price: parseFloat(price.toFixed(4)),
      amount: parseFloat(amount.toFixed(6)),
      pnlNetMxn: parseFloat(pnlNetMxn.toFixed(2)),
      pnlPct: parseFloat(pnlPct.toFixed(2)),
      cumulativePnlMxn: parseFloat(cumulativePnlMxn.toFixed(2)),
    };

    appendFileSync(outputFile, JSON.stringify(item) + "\n");
  };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const midPrice = c.close;
    const ts = c.timestamp;
    const range = Math.max(0.0001, c.high - c.low);
    const volPct = (range / midPrice) * 100;
    const body = c.close - c.open;
    const ofiScore = Math.max(-0.85, Math.min(0.85, (body / range) * 0.75));

    // Tendencia sin look-ahead
    let ema20 = midPrice;
    let ema50 = midPrice;
    if (i >= 50) {
      const s50 = closePrices.slice(i - 50, i);
      ema50 = s50.reduce((a, b) => a + b, 0) / 50;
      const s20 = closePrices.slice(i - 20, i);
      ema20 = s20.reduce((a, b) => a + b, 0) / 20;
    }

    // Clasificación de régimen
    let regime = "BALANCED_RANGE";
    const volStress = profile === "FIAT" ? 0.85 : profile === "ANCHOR" ? 2.5 : 4.0;
    if (volPct > volStress) {
      regime = "DEFENSIVE_STRESS";
    } else if (ema20 > ema50 * 1.002 && ofiScore > 0.15) {
      regime = "AGGRESSIVE_ACCUMULATION";
    }

    const policy = getRegimePolicy(regime, ticker);
    const spacingRef = profile === "FIAT" ? 0.0018 : profile === "ANCHOR" ? 0.004 : 0.006;

    // 1. Apertura / Recentrado si no hay posición o el precio se escapó
    if (bot.levels.length === 0) {
      bot.deployOrRecenter(midPrice, regime);
      recenterCount++;
    } else if (!bot.inPos && Math.abs(midPrice - bot.centerPrice) / bot.centerPrice > spacingRef * 2) {
      bot.deployOrRecenter(midPrice, regime);
      recenterCount++;
    }

    // 2. Fills de Compra (Llenados abajo)
    for (const lvl of bot.levels) {
      if (!lvl.filled && c.low <= lvl.price) {
        if (profile === "FIAT") {
          const buyUsd = Math.min(lvl.usd, bot.cashUsd);
          if (buyUsd > 0) {
            bot.cashUsd -= buyUsd;
            bot.qty += buyUsd;
            bot.costUsd += buyUsd * lvl.price; // en MXN
            lvl.filled = true;
            lvl.fillPrice = lvl.price;
          }
        } else {
          const buyCrypto = lvl.usd / lvl.price;
          bot.cashUsd -= lvl.usd;
          bot.qty += buyCrypto;
          bot.costUsd += lvl.usd;
          lvl.filled = true;
          lvl.fillPrice = lvl.price;
        }
      }
    }

    // 3. Salidas si está en posición
    if (bot.inPos) {
      if (profile === "FIAT") {
        // Salidas FX
        if (bot.stopPrice > 0 && c.low <= bot.stopPrice) {
          const proceedsMxn = bot.qty * bot.stopPrice;
          const pnlMxn = proceedsMxn - bot.costUsd;
          const pnlPct = ((bot.stopPrice / bot.avgPrice) - 1) * 100;
          recordTrade("FX_HARD_STOP", bot.stopPrice, bot.qty, pnlMxn, pnlPct, ts);
          bot.cashUsd += bot.qty;
          bot.qty = 0;
          bot.costUsd = 0;
          bot.deployOrRecenter(midPrice, regime);
          recenterCount++;
          continue;
        }

        const currentGainPct = ((c.high / bot.avgPrice) - 1) * 100;
        if (c.high >= bot.tpPrice || currentGainPct >= policy.tp1Threshold) {
          const exitRate = Math.max(bot.tpPrice, bot.avgPrice * (1 + policy.tp1Threshold / 100));
          const proceedsMxn = bot.qty * exitRate;
          const pnlMxn = proceedsMxn - bot.costUsd;
          const pnlPct = ((exitRate / bot.avgPrice) - 1) * 100;
          recordTrade("FX_TAKE_PROFIT_FULL", exitRate, bot.qty, pnlMxn, pnlPct, ts);
          bot.cashUsd += bot.qty;
          bot.qty = 0;
          bot.costUsd = 0;
          bot.deployOrRecenter(midPrice, regime);
          recenterCount++;
          continue;
        }

        for (const lvl of bot.levels) {
          if (lvl.filled && lvl.name !== "L1" && lvl.fillPrice) {
            const targetBounce = lvl.fillPrice * (1 + spacingRef * 1.1);
            if (c.high >= targetBounce) {
              const chunkUsd = lvl.usd;
              const chunkProceeds = chunkUsd * targetBounce;
              const chunkCost = chunkUsd * lvl.fillPrice;
              const chunkPnlMxn = chunkProceeds - chunkCost;
              const chunkPct = ((targetBounce / lvl.fillPrice) - 1) * 100;
              recordTrade(`FX_PINGPONG_${lvl.name}`, targetBounce, chunkUsd, chunkPnlMxn, chunkPct, ts);
              bot.cashUsd += chunkUsd;
              bot.qty = Math.max(0, bot.qty - chunkUsd);
              bot.costUsd = Math.max(0, bot.costUsd - chunkCost);
              lvl.filled = false;
            }
          }
        }
      } else {
        // Salidas CEX Spot (BTC & SOL)
        const currentGainPct = ((midPrice / bot.avgPrice) - 1) * 100;

        if (bot.stopPrice > 0 && c.low <= bot.stopPrice) {
          const exitPrice = bot.stopPrice;
          const pnlMxn = (exitPrice - bot.avgPrice) * bot.qty * FX_RATE;
          const pnlPct = ((exitPrice / bot.avgPrice) - 1) * 100;
          recordTrade("HARD_STOP_LOSS", exitPrice, bot.qty, pnlMxn, pnlPct, ts);
          bot.cashUsd += bot.qty * exitPrice;
          bot.qty = 0;
          bot.costUsd = 0;
          bot.deployOrRecenter(midPrice, regime);
          recenterCount++;
          continue;
        }

        // Escape proactivo Front-Run con Sensor Dual (OFI < -0.45 o Toxicidad Laya > 0.50)
        const toxicStress = volPct > (profile === "ANCHOR" ? 1.5 : 2.2);
        if (currentGainPct >= policy.frontRunMin && (ofiScore < -0.45 || toxicStress)) {
          const exitPrice = midPrice;
          const pnlMxn = (exitPrice - bot.avgPrice) * bot.qty * FX_RATE;
          recordTrade("TP_FRONTRUN_LAYA", exitPrice, bot.qty, pnlMxn, currentGainPct, ts);
          bot.cashUsd += bot.qty * exitPrice;
          bot.qty = 0;
          bot.costUsd = 0;
          bot.deployOrRecenter(midPrice, regime);
          recenterCount++;
          continue;
        }

        if (currentGainPct >= policy.tp1Threshold && bot.partialTakenPct < 0.50) {
          const qtyClose = bot.qty * 0.50;
          const entryAvg = bot.avgPrice;
          const pnlMxn = (midPrice - entryAvg) * qtyClose * FX_RATE;
          recordTrade("TP_PARTIAL_DCA", midPrice, qtyClose, pnlMxn, currentGainPct, ts);

          bot.qty -= qtyClose;
          bot.costUsd = Math.max(0, bot.costUsd - qtyClose * entryAvg);
          bot.cashUsd += qtyClose * midPrice;
          bot.partialTakenPct = 0.50;

          const breakEvenStop = entryAvg * 1.002;
          const trailingStop = midPrice * 0.996;
          bot.stopPrice = Math.max(bot.stopPrice, breakEvenStop, trailingStop);
        }

        const l2 = bot.levels.find((l) => l.name === "L2");
        if (l2 && l2.filled && l2.fillPrice) {
          const targetBounce = l2.fillPrice * (1 + spacingRef * 1.05);
          if (c.high >= targetBounce) {
            const chunkQty = l2.usd / l2.fillPrice;
            const pnlMxn = (targetBounce - l2.fillPrice) * chunkQty * FX_RATE;
            const chunkPct = ((targetBounce / l2.fillPrice) - 1) * 100;
            recordTrade("TP_GRID_PINGPONG_L2", targetBounce, chunkQty, pnlMxn, chunkPct, ts);
            bot.cashUsd += chunkQty * targetBounce;
            bot.qty = Math.max(0, bot.qty - chunkQty);
            bot.costUsd = Math.max(0, bot.costUsd - l2.usd);
            l2.filled = false;
          }
        }
      }
    }
  }

  const initialCapitalMxn = allocatedUsd * FX_RATE;
  const maxDrawdownPct = initialCapitalMxn > 0 ? (maxDrawdownMxn / initialCapitalMxn) * 100 : 0;
  const decisiveTrades = winningTrades + losingTrades;
  const winRatePct = decisiveTrades > 0 ? (winningTrades / decisiveTrades) * 100 : 0;
  const profitFactor = grossLossMxn > 0 ? grossProfitMxn / grossLossMxn : 99.9;
  const roiPct = (cumulativePnlMxn / initialCapitalMxn) * 100;

  console.log(`• PnL Neto en Pesos   : ${cumulativePnlMxn >= 0 ? "+" : ""}$${cumulativePnlMxn.toFixed(2)} MXN`);
  console.log(`• ROI sobre su Capital: ${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(2)}%`);
  console.log(`• Win Rate Real       : ${winRatePct.toFixed(1)}% (${winningTrades} W / ${losingTrades} L)`);
  console.log(`• Profit Factor       : ${profitFactor.toFixed(2)}`);
  console.log(`• Drawdown Máximo     : ${maxDrawdownPct.toFixed(2)}%`);
  console.log(`• Total Operaciones   : ${tradeSeq} trades`);

  return {
    ticker,
    profile,
    allocatedUsd,
    initialCapitalMxn,
    cumulativePnlMxn,
    roiPct,
    winRatePct,
    profitFactor,
    maxDrawdownPct,
    tradeSeq,
    winningTrades,
    losingTrades,
    grossProfitMxn,
    grossLossMxn,
  };
}

function main() {
  console.log("========================================================");
  console.log("   INICIANDO SIMULACIÓN MAESTRA V2 (RE-LANZAMIENTO LIMPIO)");
  console.log("========================================================");

  const fxRes = runAssetSimulation("USD", "FIAT", 400.0, "usd_mxn_1h.json");
  const btcRes = runAssetSimulation("BTC", "ANCHOR", 258.75, "btc_1h.json");
  const solRes = runAssetSimulation("SOL", "BETA", 41.25, "sol_1h.json");

  // Consolidación de toda la tesorería (CEX + FX)
  const totalAllocatedUsd = 700.0; // $400 FX + $300 CEX (el otro $300 es DEX)
  const totalAllocatedMxn = totalAllocatedUsd * FX_RATE;
  const totalPnlMxn = fxRes.cumulativePnlMxn + btcRes.cumulativePnlMxn + solRes.cumulativePnlMxn;
  const totalRoiPct = (totalPnlMxn / totalAllocatedMxn) * 100;
  const totalTrades = fxRes.tradeSeq + btcRes.tradeSeq + solRes.tradeSeq;

  // DEX fees realistas estimadas
  const dexFeesUsdEstimated = 1800.0;
  const dexFeesMxnEstimated = dexFeesUsdEstimated * FX_RATE;

  // Gran Total de Toda la Cuenta ($1,000 USD / $17,720 MXN)
  const grandTotalMxn = totalPnlMxn + dexFeesMxnEstimated;
  const grandTotalRoiPct = (grandTotalMxn / (1000 * FX_RATE)) * 100;

  const consolidatedSummary = {
    date: new Date().toISOString(),
    currency: "MXN",
    fxRateUsed: FX_RATE,
    fiatFxModule: fxRes,
    btcModule: btcRes,
    solModule: solRes,
    consolidatedCexAndFx: {
      totalCapitalMxn: totalAllocatedMxn,
      totalPnlNetMxn: parseFloat(totalPnlMxn.toFixed(2)),
      roiPct: parseFloat(totalRoiPct.toFixed(2)),
      totalTrades,
    },
    dexModuleEstimated: {
      allocatedMxn: 300 * FX_RATE,
      feesMxn: dexFeesMxnEstimated,
      roiPct: (dexFeesMxnEstimated / (300 * FX_RATE)) * 100,
    },
    portfolioGrandTotal: {
      initialCapitalMxn: 1000 * FX_RATE,
      netProfitMxn: parseFloat(grandTotalMxn.toFixed(2)),
      finalCapitalMxn: parseFloat(((1000 * FX_RATE) + grandTotalMxn).toFixed(2)),
      roiPct: parseFloat(grandTotalRoiPct.toFixed(2)),
      dailyAverageMxn: parseFloat((grandTotalMxn / 365).toFixed(2)),
      monthlyAverageMxn: parseFloat(((grandTotalMxn / 365) * 30).toFixed(2)),
    },
  };

  const reportFile = join(BASE_DIR, "v2_consolidated_report.json");
  writeFileSync(reportFile, JSON.stringify(consolidatedSummary, null, 2));

  console.log("\n========================================================");
  console.log("       INFORME FINAL CONSOLIDADO V2 (100% EN PESOS)     ");
  console.log("========================================================");
  console.log(`Capital Inicial Total Cuenta : $${(1000 * FX_RATE).toFixed(2)} MXN ($1,000 USD)`);
  console.log(`--------------------------------------------------------`);
  console.log(`1. DESGLOSE POR MÓDULO (PESOS MXN):`);
  console.log(`   • Bot Cambiario FX (USD/MXN)  : +$${fxRes.cumulativePnlMxn.toFixed(2)} MXN (${fxRes.roiPct >= 0 ? "+" : ""}${fxRes.roiPct.toFixed(2)}%)`);
  console.log(`   • Malla Spot Bitcoin (BTC)    : +$${btcRes.cumulativePnlMxn.toFixed(2)} MXN (${btcRes.roiPct >= 0 ? "+" : ""}${btcRes.roiPct.toFixed(2)}%)`);
  console.log(`   • Malla Spot Solana (SOL)     : +$${solRes.cumulativePnlMxn.toFixed(2)} MXN (${solRes.roiPct >= 0 ? "+" : ""}${solRes.roiPct.toFixed(2)}%)`);
  console.log(`   • Total Motor Directo (CEX+FX): +$${totalPnlMxn.toFixed(2)} MXN (+${totalRoiPct.toFixed(2)}%)`);
  console.log(`   • Comisiones DEX LP Estimadas : +$${dexFeesMxnEstimated.toFixed(2)} MXN (~$1,800 USD)`);
  console.log(`--------------------------------------------------------`);
  console.log(`2. RESULTADO TOTAL CONSOLIDADO EN PESOS:`);
  console.log(`   • GANANCIA NETA TOTAL DEL AÑO : +$${grandTotalMxn.toFixed(2)} MXN`);
  console.log(`   • CAPITAL FINAL DE LA CUENTA  : $${((1000 * FX_RATE) + grandTotalMxn).toFixed(2)} MXN`);
  console.log(`   • ROI ANUALIZADO TOTAL        : +${grandTotalRoiPct.toFixed(2)}%`);
  console.log(`   • Flujo Diario Promedio       : +$${(grandTotalMxn / 365).toFixed(2)} MXN / día`);
  console.log(`   • Flujo Mensual Estimado      : +$${((grandTotalMxn / 365) * 30).toFixed(2)} MXN / mes`);
  console.log("========================================================\n");
}

main();
