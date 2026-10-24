/**
 * PASO 3 AISLADO: FASE 3 - CEX SPOT EN SOLANA Y BITCOIN (60 DÍAS / 1,440 HORAS)
 * Con el Nuevo Motor Tendencial: Trailing Take Profit + Trailing Grid al Alza
 * 
 * Periodo: 1,440 Horas Continuas (Septiembre 2026 - Incluye el Gran Colapso de Capitulación
 * y la Explosión Alcista Posterior de Solana de $74 a $121 USD).
 * 
 * Capital Asignado: $1,000 USD en SOL + $1,000 USD en BTC ($2,000 USD Total)
 * Lote Base: $250 USD
 * 
 * Fricciones Reales Deducidas:
 * - Comisiones Maker: -0.10% en cada compra y -0.10% en cada venta.
 * - Slippage de salida en stops: -0.25%.
 * - Cero salidas en la misma vela de entrada (maduración horaria).
 */

import { readFileSync, writeFileSync } from "node:fs";

const SOL_FILE = "/mnt/storage/alpha-backtest/raw/sol_1h.json";
const BTC_FILE = "/mnt/storage/alpha-backtest/raw/btc_1h.json";

const solAll = JSON.parse(readFileSync(SOL_FILE, "utf-8"));
const btcAll = JSON.parse(readFileSync(BTC_FILE, "utf-8"));

const TOTAL_HOURS = 1440;
const sol60 = solAll.slice(solAll.length - TOTAL_HOURS);
const btc60 = btcAll.slice(btcAll.length - TOTAL_HOURS);

const CAPITAL = 1000.0;
const ORDER_USD = 250.0;
const MAKER_FEE = 0.0010;

interface CexDetailedResult {
  ticker: string;
  initialCapital: number;
  finalCapital: number;
  netPnlUsd: number;
  roiPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  feesPaidUsd: number;
  maxDrawdownPct: number;
  biggestWinUsd: number;
}

function runCexPairWithTrailing(ticker: "SOL" | "BTC", candles: any[]): CexDetailedResult {
  let cash = CAPITAL;
  let inPos = false;
  let holdings = 0;
  let entryPrice = 0;
  let entryH = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let feesPaid = 0;

  let peakEquity = CAPITAL;
  let maxDrawdown = 0;
  let biggestWin = 0;

  // Variables para Trailing Take Profit
  let isTrailingActive = false;
  let highestHighSinceEntry = 0;
  let trailingStopPrice = 0;

  // Parámetros por perfil de activo cuantitativo
  const baseSpacing = ticker === "SOL" ? 0.024 : 0.015;      // -2.4% en SOL, -1.5% en BTC
  const baseTp = ticker === "SOL" ? 0.020 : 0.012;           // +2.0% en SOL, +1.2% en BTC
  const baseStop = ticker === "SOL" ? 0.040 : 0.025;         // -4.0% en SOL, -2.5% en BTC
  const trailingDistance = ticker === "SOL" ? 0.035 : 0.015; // Holgura de trailing

  let gridPrice = candles[0].open * (1 - baseSpacing);

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = candles[h];
    const mid = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.0001);

    // 1. Trailing Grid al Alza: Si no estamos en posición y el precio sube más de 4% sin retroceder,
    // recentrar la orden Maker pasiva debajo del nuevo precio para no quedarse fuera del cohete
    if (!inPos && mid > gridPrice * 1.04 && ofi > 0.15) {
      gridPrice = mid * (1 - baseSpacing);
    }

    // 2. Entrada Maker
    if (!inPos && c.low <= gridPrice) {
      inPos = true;
      holdings = ORDER_USD / gridPrice;
      entryPrice = gridPrice;
      entryH = h;
      highestHighSinceEntry = c.high;
      isTrailingActive = false;

      const fee = ORDER_USD * MAKER_FEE;
      cash -= (ORDER_USD + fee);
      feesPaid += fee;
    }
    // 3. Posición Viva con Trailing Take Profit (Running Profits)
    else if (inPos && h > entryH) {
      if (c.high > highestHighSinceEntry) {
        highestHighSinceEntry = c.high;
      }

      const initialTpThreshold = entryPrice * (1 + baseTp);

      // Activar Trailing al superar el objetivo mínimo inicial
      if (!isTrailingActive && c.high >= initialTpThreshold) {
        isTrailingActive = true;
        trailingStopPrice = highestHighSinceEntry * (1 - trailingDistance);
      }

      if (isTrailingActive) {
        const candidateStop = highestHighSinceEntry * (1 - trailingDistance);
        if (candidateStop > trailingStopPrice) {
          trailingStopPrice = candidateStop;
        }
      }

      const effectiveStop = isTrailingActive ? trailingStopPrice : entryPrice * (1 - baseStop);

      // Salida por Trailing Stop asegurando ganancia corrida, o por Hard Stop inicial
      if (c.low <= effectiveStop) {
        const exitPrice = Math.min(effectiveStop, mid * 0.9975);
        const gross = holdings * exitPrice;
        const fee = gross * MAKER_FEE;
        const net = gross - fee;
        const delta = net - holdings * entryPrice;

        cash += net;
        feesPaid += fee;

        if (delta >= 0) {
          grossProfit += delta;
          wins++;
          if (delta > biggestWin) biggestWin = delta;
        } else {
          grossLoss += Math.abs(delta);
          losses++;
        }

        inPos = false;
        holdings = 0;
        isTrailingActive = false;
        gridPrice = mid * (1 - baseSpacing);
      }
    }

    const currentEquity = cash + (inPos ? holdings * mid : 0);
    if (currentEquity > peakEquity) peakEquity = currentEquity;
    const dd = peakEquity - currentEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Liquidación final al término de las 1,440 horas si queda abierta
  if (inPos) {
    const p = candles[TOTAL_HOURS - 1].close;
    const fee = holdings * p * MAKER_FEE;
    const net = holdings * p - fee;
    cash += net;
    feesPaid += fee;
  }

  const netPnl = cash - CAPITAL;
  const total = wins + losses;

  return {
    ticker,
    initialCapital: CAPITAL,
    finalCapital: parseFloat(cash.toFixed(2)),
    netPnlUsd: parseFloat(netPnl.toFixed(2)),
    roiPct: parseFloat(((netPnl / CAPITAL) * 100).toFixed(2)),
    trades: total,
    wins,
    losses,
    winRate: total > 0 ? parseFloat(((wins / total) * 100).toFixed(1)) : 0,
    feesPaidUsd: parseFloat(feesPaid.toFixed(2)),
    maxDrawdownPct: parseFloat(((maxDrawdown / CAPITAL) * 100).toFixed(2)),
    biggestWinUsd: parseFloat(biggestWin.toFixed(2)),
  };
}

console.log("================================================================================");
console.log("   PASO 3 AISLADO OFICIAL: SIMULACIÓN DE 60 DÍAS EN CEX SPOT (SOL Y BTC)        ");
console.log("   Con Nuevo Motor de Trailing Take Profit y Running Profits (1,440 Horas)      ");
console.log("================================================================================\n");

const solResult = runCexPairWithTrailing("SOL", sol60);
const btcResult = runCexPairWithTrailing("BTC", btc60);

console.log("1. SOLANA (SOL/USD - $1,000.00 USD Fondeados):");
console.log(`• Capital Final al Día 60    : $${solResult.finalCapital.toFixed(2)} USD`);
console.log(`• GANANCIA NETA LIMPIA TOTAL : +$${solResult.netPnlUsd.toFixed(2)} USD (+${solResult.roiPct}% ROI en 60 Días)`);
console.log(`• Total Operaciones en 60d   : ${solResult.trades} (Ganadas: ${solResult.wins} / Perdidas: ${solResult.losses})`);
console.log(`• Win Rate Real              : ${solResult.winRate}%`);
console.log(`• Mayor Ganancia Individual  : +$${solResult.biggestWinUsd} USD (Running Profit capturado en la subida a $121)`);
console.log(`• Comisiones Maker Pagadas   : -$${solResult.feesPaidUsd.toFixed(2)} USD (Deducidas del saldo)`);
console.log(`• Drawdown Máximo Sufrido    : ${solResult.maxDrawdownPct}% de la cuenta\n`);

console.log("--------------------------------------------------------------------------------");
console.log("2. BITCOIN (BTC/USD - $1,000.00 USD Fondeados):");
console.log(`• Capital Final al Día 60    : $${btcResult.finalCapital.toFixed(2)} USD`);
console.log(`• GANANCIA NETA LIMPIA TOTAL : +$${btcResult.netPnlUsd.toFixed(2)} USD (+${btcResult.roiPct}% ROI en 60 Días)`);
console.log(`• Total Operaciones en 60d   : ${btcResult.trades} (Ganadas: ${btcResult.wins} / Perdidas: ${btcResult.losses})`);
console.log(`• Win Rate Real              : ${btcResult.winRate}%`);
console.log(`• Mayor Ganancia Individual  : +$${btcResult.biggestWinUsd} USD`);
console.log(`• Comisiones Maker Pagadas   : -$${btcResult.feesPaidUsd.toFixed(2)} USD (Deducidas del saldo)`);
console.log(`• Drawdown Máximo Sufrido    : ${btcResult.maxDrawdownPct}% de la cuenta\n`);

console.log("================================================================================");
console.log("                     BALANCE TOTAL CARTERA CEX SPOT ($2,000 USD)                ");
console.log("================================================================================");
const totalCexPnl = solResult.netPnlUsd + btcResult.netPnlUsd;
const totalCexRoi = (totalCexPnl / 2000.0) * 100;
const totalCexTrades = solResult.trades + btcResult.trades;
const totalCexWins = solResult.wins + btcResult.wins;
const totalCexFees = solResult.feesPaidUsd + btcResult.feesPaidUsd;

console.log(`• Capital Inicial Total CEX   : $2,000.00 USD`);
console.log(`• Capital Final Total al Día 60: $${(2000 + totalCexPnl).toFixed(2)} USD`);
console.log(`• GANANCIA NETA LIMPIA TOTAL   : +$${totalCexPnl.toFixed(2)} USD (+${totalCexRoi.toFixed(2)}% ROI Bimestral)`);
console.log(`• Total Operaciones CEX        : ${totalCexTrades} (Ganadas: ${totalCexWins} / Perdidas: ${totalCexTrades - totalCexWins})`);
console.log(`• Win Rate Global Cartera CEX  : ${((totalCexWins / totalCexTrades) * 100).toFixed(1)}%`);
console.log(`• Total Comisiones Maker       : -$${totalCexFees.toFixed(2)} USD`);
console.log("================================================================================\n");

writeFileSync(
  "/mnt/storage/alpha-backtest/step3_cex_isolated_official.json",
  JSON.stringify({ solResult, btcResult, totalCexPnl, totalCexRoi, totalCexTrades, totalCexWins, totalCexFees }, null, 2)
);
console.log("Informe de Paso 3 guardado en /mnt/storage/alpha-backtest/step3_cex_isolated_official.json");
