/**
 * FASE 2: SIMULACIÓN ÁCIDA MENSUAL DE CEX (SOL/USD Y BTC/USD)
 * Comparación Frente a Frente (720 Horas Continuas):
 * 1. Motor Anterior (Candado rígido de 16h y porcentajes fijos)
 * 2. Motor Nuevo (Laya Continuo sin reloj + Sets Dinámicos por ATR + Fail-over Dual)
 * 
 * Reglas Ácidas y Anti-Trampa:
 * - 720 Horas del mismo mes (Septiembre 2026).
 * - Cero salidas en la misma hora de compra (maduración mínima de 1h).
 * - Comisiones Maker reales deducidas: -0.10% en cada compra y -0.10% en cada venta.
 * - Slippage de penalización en stops: -0.25%.
 * - Capital: $1,000 USD por par.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { generateAdaptiveSet } from "../src/guardrails/volatility-adaptive-sets.js";

const SOL_FILE = "/mnt/storage/alpha-backtest/raw/sol_1h.json";
const BTC_FILE = "/mnt/storage/alpha-backtest/raw/btc_1h.json";

const solCandlesAll = JSON.parse(readFileSync(SOL_FILE, "utf-8"));
const btcCandlesAll = JSON.parse(readFileSync(BTC_FILE, "utf-8"));

const TOTAL_HOURS = 720;
const solMonth = solCandlesAll.slice(solCandlesAll.length - TOTAL_HOURS);
const btcMonth = btcCandlesAll.slice(btcCandlesAll.length - TOTAL_HOURS);

const CAPITAL_USD = 1000.0;
const ORDER_USD = 250.0;
const MAKER_FEE = 0.0010; // 0.10%

interface SimulationResult {
  ticker: string;
  architecture: string;
  initialCapital: number;
  finalCapital: number;
  netPnl: number;
  roiPct: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  feesPaidUsd: number;
  maxDrawdownPct: number;
}

function runCexSimulation(
  ticker: string,
  candles: any[],
  architecture: "OLD_RIGID_16H" | "NEW_LAYA_ATR_ADAPTIVE"
): SimulationResult {
  let cash = CAPITAL_USD;
  let inPos = false;
  let cryptoHoldings = 0;
  let entryPrice = 0;
  let entryHour = 0;
  let stopPrice = 0;
  let tpPrice = 0;

  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let feesPaid = 0;

  let isLocked = false;
  let lockHour = -1;

  let peakEquity = CAPITAL_USD;
  let maxDrawdown = 0;

  // Parámetros fijos antiguos
  const oldSpacing = ticker === "SOL" ? 0.025 : 0.015;
  const oldTp = ticker === "SOL" ? 0.020 : 0.012;
  const oldStop = ticker === "SOL" ? 0.040 : 0.025;

  let gridPrice = candles[0].open * (1 - oldSpacing);

  for (let h = 15; h < TOTAL_HOURS; h++) {
    const c = candles[h];
    const midPrice = (c.open + c.close) / 2;

    const ofiScore = (c.close - c.open) / (c.high - c.low + 0.0001);
    const toxicFlow = c.close < c.open && c.volume > (ticker === "SOL" ? 50000 : 1000) ? 0.75 : 0.20;

    const prev24Close = candles[Math.max(0, h - 24)].close;
    const change24hPct = ((c.close - prev24Close) / prev24Close) * 100;

    let detectedRegime: "BALANCED_RANGE" | "EXPANSION_UP" | "DEFENSIVE_STRESS" = "BALANCED_RANGE";
    if (change24hPct < -3.5 || toxicFlow > 0.70) {
      detectedRegime = "DEFENSIVE_STRESS";
    } else if (change24hPct > 3.0 && ofiScore > 0.25) {
      detectedRegime = "EXPANSION_UP";
    }

    // Cálculo dinámico por ATR
    const windowCandles = candles.slice(h - 14, h + 1);
    const adaptiveSet = generateAdaptiveSet(windowCandles, detectedRegime, 6, MAKER_FEE);

    const activeSpacing  = architecture === "NEW_LAYA_ATR_ADAPTIVE" ? adaptiveSet.spacingPct : oldSpacing;
    const activeTp       = architecture === "NEW_LAYA_ATR_ADAPTIVE" ? adaptiveSet.tpPct : oldTp;
    const activeStop     = architecture === "NEW_LAYA_ATR_ADAPTIVE" ? adaptiveSet.stopPct : oldStop;
    const activeDiscount = architecture === "NEW_LAYA_ATR_ADAPTIVE" ? adaptiveSet.discountAfterSlPct : oldSpacing * 1.5;

    // Desbloqueo según arquitectura
    if (isLocked) {
      if (architecture === "OLD_RIGID_16H") {
        if (h - lockHour >= 16) {
          isLocked = false;
          gridPrice = midPrice * (1 - oldSpacing);
        }
      } else {
        // Laya Continuo: En cuanto el libro absorbe el choque, luz verde inmediata con re-centrado por ATR
        if (ofiScore > 0.20 && toxicFlow < 0.35 && detectedRegime !== "DEFENSIVE_STRESS") {
          isLocked = false;
          gridPrice = midPrice * (1 - activeDiscount);
        }
      }
    }

    // 1. Entrada Maker
    if (!inPos && !isLocked && c.low <= gridPrice) {
      const fillPrice = gridPrice;
      const cryptoAmount = ORDER_USD / fillPrice;
      const fee = ORDER_USD * MAKER_FEE;

      if (cash >= ORDER_USD + fee) {
        inPos = true;
        cryptoHoldings = cryptoAmount;
        entryPrice = fillPrice;
        entryHour = h;
        tpPrice = entryPrice * (1 + activeTp);
        stopPrice = entryPrice * (1 - activeStop);

        cash -= (ORDER_USD + fee);
        feesPaid += fee;
      }
    }
    // 2. Gestión de posición viva (mínimo 1 hora)
    else if (inPos && h > entryHour) {
      // Salida por Stop Loss (o Laya Toxic Exit)
      if (c.low <= stopPrice || (toxicFlow > 0.70 && midPrice < entryPrice * (1 - activeStop * 0.7))) {
        const exitPrice = Math.min(stopPrice, midPrice * 0.9975); // Con 0.25% slippage
        const grossProceeds = cryptoHoldings * exitPrice;
        const fee = grossProceeds * MAKER_FEE;
        const netProceeds = grossProceeds - fee;
        const costBasis = cryptoHoldings * entryPrice;
        const loss = netProceeds - costBasis;

        cash += netProceeds;
        grossLoss += Math.abs(loss);
        feesPaid += fee;
        losses++;

        inPos = false;
        cryptoHoldings = 0;
        isLocked = true;
        lockHour = h;
      }
      // Salida por Take Profit
      else if (c.high >= tpPrice) {
        const exitPrice = tpPrice;
        const grossProceeds = cryptoHoldings * exitPrice;
        const fee = grossProceeds * MAKER_FEE;
        const netProceeds = grossProceeds - fee;
        const costBasis = cryptoHoldings * entryPrice;
        const profit = netProceeds - costBasis;

        cash += netProceeds;
        grossProfit += profit;
        feesPaid += fee;
        wins++;

        inPos = false;
        cryptoHoldings = 0;
        gridPrice = midPrice * (1 - activeSpacing);
      }
    }

    const currentEquity = cash + (inPos ? cryptoHoldings * midPrice : 0);
    if (currentEquity > peakEquity) peakEquity = currentEquity;
    const currentDd = peakEquity - currentEquity;
    if (currentDd > maxDrawdown) maxDrawdown = currentDd;
  }

  // Liquidación final al cierre
  if (inPos) {
    const finalPrice = candles[TOTAL_HOURS - 1].close;
    const fee = cryptoHoldings * finalPrice * MAKER_FEE;
    cash += (cryptoHoldings * finalPrice - fee);
    feesPaid += fee;
  }

  const netPnl = cash - CAPITAL_USD;
  const totalTrades = wins + losses;
  return {
    ticker,
    architecture,
    initialCapital: CAPITAL_USD,
    finalCapital: parseFloat(cash.toFixed(2)),
    netPnl: parseFloat(netPnl.toFixed(2)),
    roiPct: parseFloat(((netPnl / CAPITAL_USD) * 100).toFixed(2)),
    totalTrades,
    wins,
    losses,
    winRate: parseFloat(((wins / totalTrades) * 100).toFixed(1)),
    profitFactor: grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : 99.9,
    feesPaidUsd: parseFloat(feesPaid.toFixed(2)),
    maxDrawdownPct: parseFloat(((maxDrawdown / CAPITAL_USD) * 100).toFixed(2)),
  };
}

console.log("================================================================================");
console.log("   FASE 2: AUDITORÍA MENSUAL CEX (SOL/USD Y BTC/USD) - 720 HORAS CONTINUAS      ");
console.log("   Comparación: Motor Anterior (Reloj 16h Fijo) vs Motor Nuevo (Laya + ATR)     ");
console.log("================================================================================\n");

// 1. SOLANA (SOL/USD)
const solOld = runCexSimulation("SOL", solMonth, "OLD_RIGID_16H");
const solNew = runCexSimulation("SOL", solMonth, "NEW_LAYA_ATR_ADAPTIVE");

console.log("--------------------------------------------------------------------------------");
console.log("1. SOLANA (SOL/USD) - RESULTADOS DEL MES COMPLETO:");
console.log(`• Motor Anterior (16h fijo) : PnL ${solOld.netPnl >= 0 ? "+" : ""}$${solOld.netPnl} USD (${solOld.roiPct}%) | Trades: ${solOld.totalTrades} (W: ${solOld.wins} / L: ${solOld.losses}) | WinRate: ${solOld.winRate}% | Fees: -$${solOld.feesPaidUsd} | DD: ${solOld.maxDrawdownPct}%`);
console.log(`• Motor Nuevo (Laya + ATR)  : PnL ${solNew.netPnl >= 0 ? "+" : ""}$${solNew.netPnl} USD (${solNew.roiPct}%) | Trades: ${solNew.totalTrades} (W: ${solNew.wins} / L: ${solNew.losses}) | WinRate: ${solNew.winRate}% | Fees: -$${solNew.feesPaidUsd} | DD: ${solNew.maxDrawdownPct}%`);
console.log(`-> Veredicto SOL: ${solNew.netPnl > solOld.netPnl ? "MEJORA NETA" : "RESULTADO"}: ${solNew.netPnl - solOld.netPnl >= 0 ? "+" : ""}$${(solNew.netPnl - solOld.netPnl).toFixed(2)} USD | Ahorro Fees: $${(solOld.feesPaidUsd - solNew.feesPaidUsd).toFixed(2)} USD`);
console.log("--------------------------------------------------------------------------------\n");

// 2. BITCOIN (BTC/USD)
const btcOld = runCexSimulation("BTC", btcMonth, "OLD_RIGID_16H");
const btcNew = runCexSimulation("BTC", btcMonth, "NEW_LAYA_ATR_ADAPTIVE");

console.log("--------------------------------------------------------------------------------");
console.log("2. BITCOIN (BTC/USD) - RESULTADOS DEL MES COMPLETO:");
console.log(`• Motor Anterior (16h fijo) : PnL ${btcOld.netPnl >= 0 ? "+" : ""}$${btcOld.netPnl} USD (${btcOld.roiPct}%) | Trades: ${btcOld.totalTrades} (W: ${btcOld.wins} / L: ${btcOld.losses}) | WinRate: ${btcOld.winRate}% | Fees: -$${btcOld.feesPaidUsd} | DD: ${btcOld.maxDrawdownPct}%`);
console.log(`• Motor Nuevo (Laya + ATR)  : PnL ${btcNew.netPnl >= 0 ? "+" : ""}$${btcNew.netPnl} USD (${btcNew.roiPct}%) | Trades: ${btcNew.totalTrades} (W: ${btcNew.wins} / L: ${btcNew.losses}) | WinRate: ${btcNew.winRate}% | Fees: -$${btcNew.feesPaidUsd} | DD: ${btcNew.maxDrawdownPct}%`);
console.log(`-> Veredicto BTC: ${btcNew.netPnl > btcOld.netPnl ? "MEJORA NETA" : "RESULTADO"}: ${btcNew.netPnl - btcOld.netPnl >= 0 ? "+" : ""}$${(btcNew.netPnl - btcOld.netPnl).toFixed(2)} USD | Ahorro Fees: $${(btcOld.feesPaidUsd - btcNew.feesPaidUsd).toFixed(2)} USD`);
console.log("--------------------------------------------------------------------------------\n");

const summary = { solOld, solNew, btcOld, btcNew, timestamp: new Date().toISOString() };
writeFileSync("/mnt/storage/alpha-backtest/fase2_cex_month_audit.json", JSON.stringify(summary, null, 2));
console.log("Resultados guardados en /mnt/storage/alpha-backtest/fase2_cex_month_audit.json");
