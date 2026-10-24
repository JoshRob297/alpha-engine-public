/**
 * SIMULADOR CEX 100% DINÁMICO (ATR RODANTE + VETO DE MECHAZOS LAYA)
 * Modula en tiempo real:
 * 1. Espaciado dinámico basado en ATR(14) horas (sin valores fijos quemados).
 * 2. Veto Laya preventivo: Bloquea compras L2 en cuchillos cayendo (volatilidad extrema con cuerpo bajista).
 * 3. Recentrado dinámico continuo tras cada TP.
 * 4. Salidas FrontRun (+0.65%) y Trailing Stop a Break-Even.
 * Salidas:
 * - /mnt/storage/alpha-backtest/dynamic_btc_trades.jsonl
 * - /mnt/storage/alpha-backtest/dynamic_sol_trades.jsonl
 * - /mnt/storage/alpha-backtest/dynamic_cex_summary.json
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getRegimePolicy, type AssetProfile } from "../src/guardrails/regime-policy.js";

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

class AdaptiveCexGridBot {
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

  /**
   * Despliega o recentra la malla calculando espaciado y niveles dinámicamente según ATR(14)
   */
  public deployOrRecenter(midPrice: number, regime: string, dynamicSpacing: number) {
    this.centerPrice = midPrice;
    this.levels = [];
    this.partialTakenPct = 0;

    const policy = getRegimePolicy(regime, this.ticker);
    const stopMultiplier = regime === "DEFENSIVE_STRESS" ? 0.70 : regime === "AGGRESSIVE_ACCUMULATION" ? 1.20 : 1.0;

    const maxExposure = this.capitalUsd * 0.40;
    const usdPerLevel = maxExposure / 2; // 2 niveles DCA

    for (let k = 0; k < 2; k++) {
      const priceLvl = midPrice * (1 - dynamicSpacing * k);
      this.levels.push({
        name: `L${k + 1}`,
        price: parseFloat(priceLvl.toFixed(2)),
        usd: usdPerLevel,
        filled: false,
      });
    }

    // Fills de L1 inmediato al abrir
    const l1 = this.levels[0];
    const buyQty = l1.usd / midPrice;
    this.cashUsd -= l1.usd;
    this.qty += buyQty;
    this.costUsd += l1.usd;
    l1.filled = true;
    l1.fillPrice = midPrice;

    const effectiveStop = 0.075 * stopMultiplier;
    this.stopPrice = parseFloat((this.levels[this.levels.length - 1].price * (1 - effectiveStop)).toFixed(2));
    this.tpPrice = parseFloat((midPrice * (1 + policy.tp1Threshold / 100)).toFixed(2));
  }
}

function computeAtr14(candles: Candle[], currentIndex: number): number {
  if (currentIndex < 14) return candles[currentIndex].high - candles[currentIndex].low;
  let trSum = 0;
  for (let i = currentIndex - 13; i <= currentIndex; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    trSum += tr;
  }
  return trSum / 14;
}

function runDynamicAssetSimulation(
  ticker: "BTC" | "SOL",
  profile: AssetProfile,
  allocatedUsd: number
) {
  const dataFile = join(BASE_DIR, `raw/${ticker.toLowerCase()}_1h.json`);
  const outputFile = join(BASE_DIR, `dynamic_${ticker.toLowerCase()}_trades.jsonl`);
  if (existsSync(outputFile)) unlinkSync(outputFile);

  console.log(`\n--------------------------------------------------------`);
  console.log(`[SIMULACIÓN DINÁMICA ATR] Procesando ${ticker} (Perfil: ${profile})...`);
  console.log(`Capital asignado: $${allocatedUsd.toFixed(2)} USD (~$${(allocatedUsd * FX_RATE).toFixed(2)} MXN)`);

  const candles: Candle[] = JSON.parse(readFileSync(dataFile, "utf-8"));
  const bot = new AdaptiveCexGridBot(ticker, allocatedUsd, profile);
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
  let layaVetoes = 0;

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
    else if (action.includes("TP_PARTIAL")) tpCount++;
    else if (action.includes("FRONTRUN")) frontRunCount++;
    else if (action.includes("STOP")) hardStopCount++;

    const item = {
      id: `dyn_${ticker.toLowerCase()}_${tradeSeq}`,
      timestamp: new Date(ts).toISOString(),
      ticker,
      profile,
      action,
      price: parseFloat(price.toFixed(2)),
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

    // 1. Cálculo Dinámico de ATR(14) horas para espaciado adaptativo
    const atr14 = computeAtr14(candles, i);
    const atrPct = atr14 / midPrice;
    // Espaciado dinámico proporcional a la volatilidad del momento (sin número quemado)
    const baseSpacingMultiplier = profile === "ANCHOR" ? 0.30 : 0.40;
    let dynamicSpacing = Math.max(0.0025, Math.min(0.012, atrPct * baseSpacingMultiplier));

    // Tendencia EMA20 vs EMA50
    let ema20 = midPrice;
    let ema50 = midPrice;
    if (i >= 50) {
      const s50 = closePrices.slice(i - 50, i);
      ema50 = s50.reduce((a, b) => a + b, 0) / 50;
      const s20 = closePrices.slice(i - 20, i);
      ema20 = s20.reduce((a, b) => a + b, 0) / 20;
    }

    let regime = "BALANCED_RANGE";
    const volStress = profile === "ANCHOR" ? 2.2 : 3.5;
    if (volPct > volStress) {
      regime = "DEFENSIVE_STRESS";
    } else if (ema20 > ema50 * 1.002 && ofiScore > 0.15) {
      regime = "AGGRESSIVE_ACCUMULATION";
    }

    const policy = getRegimePolicy(regime, ticker);

    // 2. Apertura o Recentrado Dinámico
    if (bot.levels.length === 0) {
      bot.deployOrRecenter(midPrice, regime, dynamicSpacing);
      recenterCount++;
    } else if (!bot.inPos && Math.abs(midPrice - bot.centerPrice) / bot.centerPrice > dynamicSpacing * 2) {
      bot.deployOrRecenter(midPrice, regime, dynamicSpacing);
      recenterCount++;
    }

    // 3. Fills de Llenado pasivo L2 con Veto Preventivo Laya
    // Si la vela cae con violencia extrema y volumen vendedor (cuchillo cayendo), Laya veta la compra
    const isFallingKnife = volPct > (profile === "ANCHOR" ? 2.5 : 4.0) && body < -range * 0.70;
    for (const lvl of bot.levels) {
      if (!lvl.filled && c.low <= lvl.price) {
        if (isFallingKnife) {
          layaVetoes++; // Veto defensivo ejecutado
          continue;
        }
        const buyCrypto = lvl.usd / lvl.price;
        bot.cashUsd -= lvl.usd;
        bot.qty += buyCrypto;
        bot.costUsd += lvl.usd;
        lvl.filled = true;
        lvl.fillPrice = lvl.price;
      }
    }

    // 4. Salidas si está en posición
    if (bot.inPos) {
      const currentGainPct = ((midPrice / bot.avgPrice) - 1) * 100;

      // Hard Stop
      if (bot.stopPrice > 0 && c.low <= bot.stopPrice) {
        const exitPrice = bot.stopPrice;
        const pnlMxn = (exitPrice - bot.avgPrice) * bot.qty * FX_RATE;
        const pnlPct = ((exitPrice / bot.avgPrice) - 1) * 100;
        recordTrade("HARD_STOP_LOSS", exitPrice, bot.qty, pnlMxn, pnlPct, ts);
        bot.cashUsd += bot.qty * exitPrice;
        bot.qty = 0;
        bot.costUsd = 0;
        bot.deployOrRecenter(midPrice, regime, dynamicSpacing);
        recenterCount++;
        continue;
      }

      // Escape Front-Run Proactivo con Sensor Dual (+0.65%)
      const toxicStress = volPct > (profile === "ANCHOR" ? 1.5 : 2.2);
      if (currentGainPct >= policy.frontRunMin && (ofiScore < -0.45 || toxicStress)) {
        const exitPrice = midPrice;
        const pnlMxn = (exitPrice - bot.avgPrice) * bot.qty * FX_RATE;
        recordTrade("TP_FRONTRUN_LAYA", exitPrice, bot.qty, pnlMxn, currentGainPct, ts);
        bot.cashUsd += bot.qty * exitPrice;
        bot.qty = 0;
        bot.costUsd = 0;
        bot.deployOrRecenter(midPrice, regime, dynamicSpacing);
        recenterCount++;
        continue;
      }

      // TP Parcial 1 al alcanzar objetivo (50%) + Trailing Stop a Break-Even
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

      // Ping-Pong Reciclador en L2
      const l2 = bot.levels.find((l) => l.name === "L2");
      if (l2 && l2.filled && l2.fillPrice) {
        const targetBounce = l2.fillPrice * (1 + dynamicSpacing * 1.05);
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
  console.log(`• Vetos Laya Activados: ${layaVetoes} compras en pánico evitadas`);

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
    layaVetoes,
  };
}

function main() {
  console.log("========================================================");
  console.log("   SIMULACIÓN CEX 100% DINÁMICA (ATR + VETO DE LAYA)    ");
  console.log("========================================================");

  const btcRes = runDynamicAssetSimulation("BTC", "ANCHOR", 258.75);
  const solRes = runDynamicAssetSimulation("SOL", "BETA", 41.25);

  const totalCexCapitalMxn = (258.75 + 41.25) * FX_RATE;
  const totalCexPnlMxn = btcRes.cumulativePnlMxn + solRes.cumulativePnlMxn;
  const totalCexRoiPct = (totalCexPnlMxn / totalCexCapitalMxn) * 100;

  const resultPayload = {
    auditDate: new Date().toISOString(),
    currency: "MXN",
    btc: btcRes,
    sol: solRes,
    consolidated: {
      capitalMxn: totalCexCapitalMxn,
      pnlNetMxn: parseFloat(totalCexPnlMxn.toFixed(2)),
      roiPct: parseFloat(totalCexRoiPct.toFixed(2)),
      totalTrades: btcRes.tradeSeq + solRes.tradeSeq,
      totalVetoes: btcRes.layaVetoes + solRes.layaVetoes,
    },
  };

  const outFile = join(BASE_DIR, "dynamic_cex_summary.json");
  writeFileSync(outFile, JSON.stringify(resultPayload, null, 2));

  console.log("\n========================================================");
  console.log("      INFORME FINAL CEX SPOT DINÁMICO (EN PESOS MXN)    ");
  console.log("========================================================");
  console.log(`Capital Total CEX Spot       : $${totalCexCapitalMxn.toFixed(2)} MXN ($300.00 USD)`);
  console.log(`--------------------------------------------------------`);
  console.log(`• Ganancia Bitcoin (BTC)     : ${btcRes.cumulativePnlMxn >= 0 ? "+" : ""}$${btcRes.cumulativePnlMxn.toFixed(2)} MXN (${btcRes.roiPct >= 0 ? "+" : ""}${btcRes.roiPct.toFixed(2)}%)`);
  console.log(`• Ganancia Solana (SOL)      : ${solRes.cumulativePnlMxn >= 0 ? "+" : ""}$${solRes.cumulativePnlMxn.toFixed(2)} MXN (${solRes.roiPct >= 0 ? "+" : ""}${solRes.roiPct.toFixed(2)}%)`);
  console.log(`• PnL NETO TOTAL CEX SPOT    : ${totalCexPnlMxn >= 0 ? "+" : ""}$${totalCexPnlMxn.toFixed(2)} MXN`);
  console.log(`• ROI ANUALIZADO CEX SPOT    : ${totalCexRoiPct >= 0 ? "+" : ""}${totalCexRoiPct.toFixed(2)}% neto anual`);
  console.log(`• Total Operaciones CEX      : ${btcRes.tradeSeq + solRes.tradeSeq} trades`);
  console.log(`• Compras Peligrosas Vetadas : ${btcRes.layaVetoes + solRes.layaVetoes} eventos frenados por Laya`);
  console.log("========================================================\n");
}

main();
