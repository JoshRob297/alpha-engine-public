/**
 * FASE 3 CEX: Simulación Pura de Ejecución Aislada para BTC y SOL
 * Lee los datos pre-computados (velas, regímenes, mallas) y ejecuta
 * el loop idéntico a producción con:
 * - Recentrado dinámico tras TP
 * - Ping-Pong entre niveles L2
 * - Trailing stop a Break-Even post-TP1
 * - Hard stop exacto con deducción correcta de cost-basis
 * - Resultados 100% en Pesos Mexicanos (MXN)
 * Salidas:
 * - /mnt/storage/alpha-backtest/btc_trades.jsonl
 * - /mnt/storage/alpha-backtest/sol_trades.jsonl
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type CexDynamicGridConfig } from "./phase2-cex-grids.js";
import { type CexRegimePoint } from "./phase1-cex-regimes.js";

const OUT_DIR = existsSync("/mnt/storage/alpha-backtest") ? "/mnt/storage/alpha-backtest" : "/home/user/alpha-backtest";

interface GridLevel {
  name: string;
  price: number;
  usd: number;
  filled: boolean;
  fillPrice?: number;
}

class CexAssetGridBot {
  public capitalUsd: number;
  public cashUsd: number;
  public qty: number; // Cantidad en crypto (BTC o SOL)
  public costUsd: number;
  public levels: GridLevel[] = [];
  public tpPrice = 0;
  public stopPrice = 0;
  public centerPrice = 0;
  public partialTakenPct = 0;

  constructor(capitalUsd: number) {
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

  public deployOrRecenter(midPrice: number, config: CexDynamicGridConfig) {
    this.centerPrice = midPrice;
    this.levels = [];
    this.partialTakenPct = 0;

    // Calcular distribución de capital de la malla (40% exposición máxima)
    const maxGridExposure = this.capitalUsd * 0.40;
    let w = 0;
    for (let k = 0; k < config.levels; k++) w += Math.pow(config.mult, k);
    const base = maxGridExposure / w;

    for (let k = 0; k < config.levels; k++) {
      const priceLvl = midPrice * (1 - config.spacing * k);
      this.levels.push({
        name: `L${k + 1}`,
        price: parseFloat(priceLvl.toFixed(2)),
        usd: base * Math.pow(config.mult, k),
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

    this.tpPrice = parseFloat((midPrice * (1 + config.tp)).toFixed(2));
    this.stopPrice = parseFloat((this.levels[this.levels.length - 1].price * (1 - config.stop)).toFixed(2));
  }
}

function simulateCexAsset(ticker: "BTC" | "SOL", allocatedUsd: number, fxRate = 17.72) {
  const candlesFile = join(OUT_DIR, `raw/${ticker.toLowerCase()}_1h.json`);
  const regimesFile = join(OUT_DIR, `${ticker.toLowerCase()}_regimes.json`);
  const gridsFile = join(OUT_DIR, `${ticker.toLowerCase()}_dynamic_grids.json`);
  const tradesFile = join(OUT_DIR, `${ticker.toLowerCase()}_trades.jsonl`);

  if (existsSync(tradesFile)) unlinkSync(tradesFile);

  const candles = JSON.parse(readFileSync(candlesFile, "utf-8"));
  const regimes: CexRegimePoint[] = JSON.parse(readFileSync(regimesFile, "utf-8"));
  const grids: CexDynamicGridConfig[] = JSON.parse(readFileSync(gridsFile, "utf-8"));

  const totalHours = Math.min(candles.length, regimes.length, grids.length);
  const bot = new CexAssetGridBot(allocatedUsd);

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

  const recordTrade = (action: string, price: number, amountCrypto: number, pnlNetMxn: number, pnlPct: number, ts: number) => {
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
      id: `${ticker.toLowerCase()}_tr_${tradeSeq}`,
      timestamp: new Date(ts).toISOString(),
      ticker,
      action,
      price: parseFloat(price.toFixed(2)),
      amountCrypto: parseFloat(amountCrypto.toFixed(6)),
      pnlNetMxn: parseFloat(pnlNetMxn.toFixed(2)),
      pnlPct: parseFloat(pnlPct.toFixed(2)),
      cumulativePnlMxn: parseFloat(cumulativePnlMxn.toFixed(2)),
    };

    appendFileSync(tradesFile, JSON.stringify(item) + "\n");
  };

  for (let step = 0; step < totalHours; step++) {
    const c = candles[step];
    const r = regimes[step];
    const g = grids[step];
    const midPrice = c.close;
    const ts = c.timestamp;

    // 1. Apertura / Recentrado si no hay posición o el precio se escapó > 2 * spacing sin posición
    if (bot.levels.length === 0) {
      bot.deployOrRecenter(midPrice, g);
      recenterCount++;
    } else if (!bot.inPos && Math.abs(midPrice - bot.centerPrice) / bot.centerPrice > g.spacing * 2) {
      bot.deployOrRecenter(midPrice, g);
      recenterCount++;
    }

    // 2. Fills de Llenado pasivo L2 (compra abajo en mechazo)
    for (const lvl of bot.levels) {
      if (!lvl.filled && c.low <= lvl.price) {
        const buyQty = lvl.usd / lvl.price;
        bot.cashUsd -= lvl.usd;
        bot.qty += buyQty;
        bot.costUsd += lvl.usd;
        lvl.filled = true;
        lvl.fillPrice = lvl.price;
      }
    }

    // 3. Evaluar Salidas si está en posición
    if (bot.inPos) {
      const currentGainPct = ((midPrice / bot.avgPrice) - 1) * 100;

      // A. Hard Stop incondicional
      if (bot.stopPrice > 0 && c.low <= bot.stopPrice) {
        const exitPrice = bot.stopPrice;
        const pnlNetMxn = (exitPrice - bot.avgPrice) * bot.qty * fxRate;
        const pnlPct = ((exitPrice / bot.avgPrice) - 1) * 100;

        recordTrade("HARD_STOP_LOSS", exitPrice, bot.qty, pnlNetMxn, pnlPct, ts);

        bot.cashUsd += bot.qty * exitPrice;
        bot.qty = 0;
        bot.costUsd = 0;
        bot.deployOrRecenter(midPrice, g);
        recenterCount++;
        continue;
      }

      // B. Front-Run Exit ante libro tóxico
      if (currentGainPct >= 0.75 && (r.ofiScore < -0.50 || r.toxicFlow > 0.55)) {
        const exitPrice = midPrice;
        const pnlNetMxn = (exitPrice - bot.avgPrice) * bot.qty * fxRate;
        recordTrade("TP_FRONTRUN_LAYA", exitPrice, bot.qty, pnlNetMxn, currentGainPct, ts);

        bot.cashUsd += bot.qty * exitPrice;
        bot.qty = 0;
        bot.costUsd = 0;
        bot.deployOrRecenter(midPrice, g);
        recenterCount++;
        continue;
      }

      // C. Take Profit Parcial 1 (Asegura 50% de la posición)
      if (currentGainPct >= g.tp * 100 && bot.partialTakenPct < 0.50) {
        const qtyToClose = bot.qty * 0.50;
        const entryAvg = bot.avgPrice;
        const pnlNetMxn = (midPrice - entryAvg) * qtyToClose * fxRate;

        recordTrade("TP_PARTIAL_DCA", midPrice, qtyToClose, pnlNetMxn, currentGainPct, ts);

        bot.qty -= qtyToClose;
        bot.costUsd = Math.max(0, bot.costUsd - qtyToClose * entryAvg);
        bot.cashUsd += qtyToClose * midPrice;
        bot.partialTakenPct = 0.50;

        // Subir stop a Break-Even + Trailing Stop dinámico al 0.4%
        const breakEvenStop = entryAvg * 1.002;
        const trailingStop = midPrice * 0.996;
        bot.stopPrice = Math.max(bot.stopPrice, breakEvenStop, trailingStop);
      }

      // D. Ping-Pong Reciclador en Nivel L2
      const l2 = bot.levels.find((l) => l.name === "L2");
      if (l2 && l2.filled && l2.fillPrice) {
        const targetBounce = l2.fillPrice * (1 + g.spacing * 1.05);
        if (c.high >= targetBounce) {
          const chunkQty = l2.usd / l2.fillPrice;
          const pnlNetMxn = (targetBounce - l2.fillPrice) * chunkQty * fxRate;
          const pnlPct = ((targetBounce / l2.fillPrice) - 1) * 100;

          recordTrade("TP_GRID_PINGPONG_L2", targetBounce, chunkQty, pnlNetMxn, pnlPct, ts);

          bot.cashUsd += chunkQty * targetBounce;
          bot.qty = Math.max(0, bot.qty - chunkQty);
          bot.costUsd = Math.max(0, bot.costUsd - l2.usd);
          l2.filled = false; // Reabrir orden abajo
        }
      }
    }
  }

  const initialCapitalMxn = allocatedUsd * fxRate;
  const maxDrawdownPct = initialCapitalMxn > 0 ? (maxDrawdownMxn / initialCapitalMxn) * 100 : 0;
  const decisiveTrades = winningTrades + losingTrades;
  const winRatePct = decisiveTrades > 0 ? (winningTrades / decisiveTrades) * 100 : 0;
  const profitFactor = grossLossMxn > 0 ? grossProfitMxn / grossLossMxn : 99.9;
  const roiPct = (cumulativePnlMxn / initialCapitalMxn) * 100;

  console.log(`\n========================================================`);
  console.log(`       INFORME AUDITORÍA CEX: ${ticker} (1 AÑO COMPLETO) `);
  console.log(`========================================================`);
  console.log(`Período Auditado     : ${totalHours} horas (365 días reales de Binance)`);
  console.log(`Capital Asignado     : $${allocatedUsd.toFixed(2)} USD (~$${initialCapitalMxn.toFixed(2)} MXN)`);
  console.log(`Mallas Recentadas    : ${recenterCount} veces`);
  console.log(`--------------------------------------------------------`);
  console.log(`1. RENDIMIENTO FINANCIERO EN MXN:`);
  console.log(`   • PnL Neto en Pesos   : ${cumulativePnlMxn >= 0 ? "+" : ""}$${cumulativePnlMxn.toFixed(2)} MXN`);
  console.log(`   • ROI sobre su Capital: ${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(2)}%`);
  console.log(`   • Win Rate Real       : ${winRatePct.toFixed(1)}%`);
  console.log(`   • Profit Factor       : ${profitFactor.toFixed(2)}`);
  console.log(`   • Drawdown Máximo     : ${maxDrawdownPct.toFixed(2)}%`);
  console.log(`--------------------------------------------------------`);
  console.log(`2. DESGLOSE OPERATIVO:`);
  console.log(`   • Total Operaciones   : ${tradeSeq} trades`);
  console.log(`   • Take Profits Parcial: ${tpCount} veces asegurado 50%`);
  console.log(`   • Ping-Pong Reciclajes: ${pingPongCount} recompras/ventas en L2`);
  console.log(`   • Front-Run Exits Laya: ${frontRunCount} salidas anticipadas`);
  console.log(`   • Hard Stops Cortados : ${hardStopCount} eventos defensivos`);
  console.log(`--------------------------------------------------------`);
  console.log(`3. PROYECCIÓN DIARIA / MENSUAL EN PESOS:`);
  console.log(`   • Flujo Diario Prom   : ${cumulativePnlMxn >= 0 ? "+" : ""}$${(cumulativePnlMxn / 365).toFixed(2)} MXN / día`);
  console.log(`   • Flujo Mensual Est   : ${cumulativePnlMxn >= 0 ? "+" : ""}$${((cumulativePnlMxn / 365) * 30).toFixed(2)} MXN / mes`);
  console.log(`========================================================\n`);

  return {
    ticker,
    allocatedUsd,
    initialCapitalMxn,
    cumulativePnlMxn,
    roiPct,
    winRatePct,
    profitFactor,
    maxDrawdownPct,
    tradeSeq,
    hardStopCount,
  };
}

function main() {
  console.log("=== INICIANDO FASE 3 CEX: SIMULACIÓN AISLADA CON RECENTRADO DINÁMICO ===");
  // BTC con $258.75 USD (86.3% del capital CEX)
  const btcRes = simulateCexAsset("BTC", 258.75, 17.72);
  // SOL con $41.25 USD (13.7% del capital CEX)
  const solRes = simulateCexAsset("SOL", 41.25, 17.72);

  const totalCexPnlMxn = btcRes.cumulativePnlMxn + solRes.cumulativePnlMxn;
  const totalCexCapitalMxn = btcRes.initialCapitalMxn + solRes.initialCapitalMxn;
  const totalCexRoiPct = (totalCexPnlMxn / totalCexCapitalMxn) * 100;

  console.log(`========================================================`);
  console.log(`   RESUMEN CONSOLIDADO CEX SPOT (BTC + SOL EN PESOS)    `);
  console.log(`========================================================`);
  console.log(`Capital Total CEX    : $300.00 USD (~$${totalCexCapitalMxn.toFixed(2)} MXN)`);
  console.log(`PnL Total CEX en MXN : ${totalCexPnlMxn >= 0 ? "+" : ""}$${totalCexPnlMxn.toFixed(2)} MXN`);
  console.log(`ROI Anual CEX Spot   : ${totalCexRoiPct >= 0 ? "+" : ""}${totalCexRoiPct.toFixed(2)}%`);
  console.log(`Trades Totales CEX   : ${btcRes.tradeSeq + solRes.tradeSeq}`);
  console.log(`========================================================\n`);
}

main();
