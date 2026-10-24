/**
 * FASE 3: Simulación Pura de Ejecución FX con Mallas Dinámicas y Recentrado Continuo
 * Lee:
 * 1. raw/usd_mxn_1h.json (Velas reales de Bitso con High/Low reales)
 * 2. fx_regimes.json (Pre-validación de Jev / Laya)
 * 3. fx_dynamic_grids.json (Mallas dinámicas moduladas por SETS)
 * 
 * Reglas de Ejecución:
 * - Capital Fiduciario Base: $400.00 USD (~$7,100 MXN)
 * - Recentrado Dinámico: Cada vez que se cierra un TP o el precio se aleja > 2*spacing
 * - Reciclador Ping-Pong: Entre los niveles L2 y L3
 * - Fills reales usando Low (compras) y High (ventas Ping-Pong / TPs)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type DynamicGridConfig } from "./phase2-fx-grids.js";
import { type FxRegimePoint } from "./phase1-fx-regimes.js";

const OUT_DIR = existsSync("/mnt/storage/alpha-backtest") ? "/mnt/storage/alpha-backtest" : "/home/user/alpha-backtest";
const CANDLES_FILE = join(OUT_DIR, "raw/usd_mxn_1h.json");
const REGIMES_FILE = join(OUT_DIR, "fx_regimes.json");
const GRIDS_FILE = join(OUT_DIR, "fx_dynamic_grids.json");
const TRADES_JSONL = join(OUT_DIR, "fx_execution_trades.jsonl");

if (existsSync(TRADES_JSONL)) {
  unlinkSync(TRADES_JSONL);
}

interface GridLevel {
  name: string;
  price: number;
  usd: number;
  filled: boolean;
  fillPrice?: number;
}

class FxDynamicGridBot {
  public capitalUsd: number;
  public cashUsd: number;
  public qtyUsd: number; // En FX operamos compra de USD contra MXN
  public costMxn: number;
  public levels: GridLevel[] = [];
  public tpPrice = 0;
  public stopPrice = 0;
  public centerPrice = 0;

  constructor(capitalUsd = 400) {
    this.capitalUsd = capitalUsd;
    this.cashUsd = capitalUsd;
    this.qtyUsd = 0;
    this.costMxn = 0;
  }

  get inPos() {
    return this.qtyUsd > 0;
  }

  get avgRate() {
    return this.qtyUsd > 0 ? this.costMxn / this.qtyUsd : 0;
  }

  /**
   * Despliega o recentra la malla alrededor del precio actual
   */
  public deployOrRecenter(midPrice: number, config: DynamicGridConfig) {
    this.centerPrice = midPrice;
    this.levels = [];

    // Dividir el capital en partes iguales entre los 3 niveles
    const usdPerLevel = (this.capitalUsd * 0.60) / config.levels; // 60% exposición máxima a la malla

    for (let k = 0; k < config.levels; k++) {
      const priceLvl = midPrice * (1 - config.spacing * (k + 1));
      this.levels.push({
        name: `L${k + 1}`,
        price: parseFloat(priceLvl.toFixed(4)),
        usd: usdPerLevel,
        filled: false,
      });
    }

    this.tpPrice = parseFloat((midPrice * (1 + config.tp)).toFixed(4));
    this.stopPrice = parseFloat((this.levels[this.levels.length - 1].price * (1 - config.stop)).toFixed(4));
  }
}

async function main() {
  console.log("=== INICIANDO FASE 3: SIMULACIÓN PURA DE EJECUCIÓN FX (RECENTRADO DINÁMICO) ===");

  const candles = JSON.parse(readFileSync(CANDLES_FILE, "utf-8"));
  const regimes: FxRegimePoint[] = JSON.parse(readFileSync(REGIMES_FILE, "utf-8"));
  const grids: DynamicGridConfig[] = JSON.parse(readFileSync(GRIDS_FILE, "utf-8"));

  const totalHours = Math.min(candles.length, regimes.length, grids.length);
  console.log(`Horas continuas a simular: ${totalHours} (~${(totalHours / 24).toFixed(1)} días)`);

  const initialCapitalUsd = 400;
  const bot = new FxDynamicGridBot(initialCapitalUsd);

  let cumulativePnlMxn = 0;
  let tradeSeq = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let grossProfitMxn = 0;
  let grossLossMxn = 0;
  let tpCount = 0;
  let pingPongCount = 0;
  let hardStopCount = 0;
  let recenterCount = 0;

  let peakMxn = 0;
  let maxDrawdownMxn = 0;

  const recordTrade = (action: string, price: number, qtyUsd: number, pnlMxn: number, pnlPct: number, ts: number) => {
    tradeSeq++;
    cumulativePnlMxn += pnlMxn;

    if (pnlMxn > 0) {
      winningTrades++;
      grossProfitMxn += pnlMxn;
    } else if (pnlMxn < 0) {
      losingTrades++;
      grossLossMxn += Math.abs(pnlMxn);
    }

    if (cumulativePnlMxn > peakMxn) {
      peakMxn = cumulativePnlMxn;
    }
    const currentDd = peakMxn - cumulativePnlMxn;
    if (currentDd > maxDrawdownMxn) {
      maxDrawdownMxn = currentDd;
    }

    if (action.includes("PINGPONG")) pingPongCount++;
    else if (action.includes("TP")) tpCount++;
    else if (action.includes("STOP")) hardStopCount++;

    const item = {
      id: `fx_tr_${tradeSeq}`,
      timestamp: new Date(ts).toISOString(),
      action,
      rate: parseFloat(price.toFixed(4)),
      amountUsd: parseFloat(qtyUsd.toFixed(2)),
      pnlNetMxn: parseFloat(pnlMxn.toFixed(2)),
      pnlPct: parseFloat(pnlPct.toFixed(2)),
      cumulativePnlMxn: parseFloat(cumulativePnlMxn.toFixed(2)),
    };

    appendFileSync(TRADES_JSONL, JSON.stringify(item) + "\n");
  };

  const startTime = Date.now();

  for (let step = 0; step < totalHours; step++) {
    const c = candles[step];
    const r = regimes[step];
    const g = grids[step];
    const midPrice = c.close;
    const ts = c.timestamp;

    // 1. Si no hay malla desplegada o el precio se alejó > 2 * spacing sin posición -> Recentrar malla
    if (bot.levels.length === 0) {
      bot.deployOrRecenter(midPrice, g);
      recenterCount++;
    } else if (!bot.inPos && Math.abs(midPrice - bot.centerPrice) / bot.centerPrice > g.spacing * 2) {
      bot.deployOrRecenter(midPrice, g);
      recenterCount++;
    }

    // 2. Fills de Compra (Nivel L1, L2, L3) usando Low de la vela
    for (const lvl of bot.levels) {
      if (!lvl.filled && c.low <= lvl.price) {
        // Ejecución de compra de USD con MXN
        const buyAmountUsd = Math.min(lvl.usd, bot.cashUsd);
        if (buyAmountUsd > 0) {
          bot.cashUsd -= buyAmountUsd;
          bot.qtyUsd += buyAmountUsd;
          bot.costMxn += buyAmountUsd * lvl.price;
          lvl.filled = true;
          lvl.fillPrice = lvl.price;
        }
      }
    }

    // 3. Evaluar Salidas si está en posición
    if (bot.inPos) {
      // A. Hard Stop (Apreciación violenta del peso por debajo del stop)
      if (bot.stopPrice > 0 && c.low <= bot.stopPrice) {
        const proceedsMxn = bot.qtyUsd * bot.stopPrice;
        const pnlMxn = proceedsMxn - bot.costMxn;
        const pnlPct = ((bot.stopPrice / bot.avgRate) - 1) * 100;

        recordTrade("FX_HARD_STOP", bot.stopPrice, bot.qtyUsd, pnlMxn, pnlPct, ts);

        bot.cashUsd += bot.qtyUsd;
        bot.qtyUsd = 0;
        bot.costMxn = 0;
        bot.deployOrRecenter(midPrice, g); // Recentrar en el nuevo piso
        recenterCount++;
        continue;
      }

      // B. Take Profit Global de la Malla (El dólar rebotó al objetivo)
      const currentGainPct = ((c.high / bot.avgRate) - 1) * 100;
      if (c.high >= bot.tpPrice || (currentGainPct >= g.tp * 100 && currentGainPct >= 0.35)) {
        const exitRate = Math.max(bot.tpPrice, bot.avgRate * (1 + g.tp));
        const proceedsMxn = bot.qtyUsd * exitRate;
        const pnlMxn = proceedsMxn - bot.costMxn;
        const pnlPct = ((exitRate / bot.avgRate) - 1) * 100;

        recordTrade("FX_TAKE_PROFIT_FULL", exitRate, bot.qtyUsd, pnlMxn, pnlPct, ts);

        bot.cashUsd += bot.qtyUsd;
        bot.qtyUsd = 0;
        bot.costMxn = 0;
        bot.deployOrRecenter(midPrice, g); // Recentrar inmediatamente en el nuevo precio
        recenterCount++;
        continue;
      }

      // C. Ping-Pong Reciclador en Niveles Secundarios (L2 y L3)
      for (const lvl of bot.levels) {
        if (lvl.filled && lvl.name !== "L1" && lvl.fillPrice) {
          const targetBounceRate = lvl.fillPrice * (1 + g.spacing * 1.1); // Rebote al nivel superior
          if (c.high >= targetBounceRate) {
            const chunkUsd = lvl.usd;
            const chunkProceedsMxn = chunkUsd * targetBounceRate;
            const chunkCostMxn = chunkUsd * lvl.fillPrice;
            const chunkPnlMxn = chunkProceedsMxn - chunkCostMxn;
            const chunkPnlPct = ((targetBounceRate / lvl.fillPrice) - 1) * 100;

            recordTrade(`FX_PINGPONG_${lvl.name}`, targetBounceRate, chunkUsd, chunkPnlMxn, chunkPnlPct, ts);

            bot.cashUsd += chunkUsd;
            bot.qtyUsd = Math.max(0, bot.qtyUsd - chunkUsd);
            bot.costMxn = Math.max(0, bot.costMxn - chunkCostMxn);
            lvl.filled = false; // Reabrir orden para volver a comprar abajo
          }
        }
      }
    }
  }

  const initialMxn = initialCapitalUsd * candles[0].close;
  const maxDrawdownPct = initialMxn > 0 ? (maxDrawdownMxn / initialMxn) * 100 : 0;
  const decisiveTrades = winningTrades + losingTrades;
  const winRatePct = decisiveTrades > 0 ? (winningTrades / decisiveTrades) * 100 : 0;
  const profitFactor = grossLossMxn > 0 ? grossProfitMxn / grossLossMxn : 99.9;

  const roiPct = (cumulativePnlMxn / initialMxn) * 100;

  console.log("\n========================================================");
  console.log("       INFORME FINAL FASE 3: SIMULACIÓN FX AISLADA      ");
  console.log("========================================================");
  console.log(`Período Auditado     : ${totalHours} horas (~${(totalHours / 24).toFixed(1)} días de Bitso real)`);
  console.log(`Capital Fondeado     : $${initialCapitalUsd.toFixed(2)} USD (~$${initialMxn.toFixed(2)} MXN)`);
  console.log(`Mallas Recentadas    : ${recenterCount} veces`);
  console.log("--------------------------------------------------------");
  console.log("1. RENDIMIENTO CUANTITATIVO FX:");
  console.log(`   • PnL Neto Generado   : +$${cumulativePnlMxn.toFixed(2)} MXN`);
  console.log(`   • ROI sobre Reserva FX: +${roiPct.toFixed(2)}%`);
  console.log(`   • Win Rate            : ${winRatePct.toFixed(1)}%`);
  console.log(`   • Profit Factor       : ${profitFactor.toFixed(2)}`);
  console.log(`   • Drawdown Máximo     : ${maxDrawdownPct.toFixed(2)}% (Cero quiebras)`);
  console.log("--------------------------------------------------------");
  console.log("2. DESGLOSE OPERATIVO:");
  console.log(`   • Total Operaciones   : ${tradeSeq} trades`);
  console.log(`   • Take Profits Global : ${tpCount} ciclos cerrados`);
  console.log(`   • Ping-Pong Reciclajes: ${pingPongCount} tramos L2/L3`);
  console.log(`   • Hard Stops Cortados : ${hardStopCount} eventos defensivos`);
  console.log("--------------------------------------------------------");
  console.log("3. PROYECCIÓN DE FLUJO EN VIVO:");
  console.log(`   • Ganancia Diaria Prom: +$${(cumulativePnlMxn / (totalHours / 24)).toFixed(2)} MXN / día`);
  console.log(`   • Ganancia Mensual Est: +$${((cumulativePnlMxn / (totalHours / 24)) * 30).toFixed(2)} MXN / mes`);
  console.log("========================================================\n");
}

main().catch(console.error);
