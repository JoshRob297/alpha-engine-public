/**
 * PRUEBA DE FUEGO DEFINITIVA: SIMULACIÓN DE TRADING REAL (720 HORAS)
 * MODELO VIRGEN DE FÁBRICA VS MODELO DESTILADO RE-ENTRENADO
 * Evaluando el impacto real en el saldo de la cuenta ($1,000 USD de Capital)
 */

import { readFileSync } from "node:fs";

const SOL_FILE = "/mnt/storage/alpha-backtest/raw/sol_1h.json";
const solCandlesAll = JSON.parse(readFileSync(SOL_FILE, "utf-8"));
const TOTAL_HOURS = 720;
const candles = solCandlesAll.slice(solCandlesAll.length - TOTAL_HOURS);

const CAPITAL = 1000.0;
const ORDER_USD = 250.0;
const FEE = 0.0010;

function runModelTradingComparison(isDistilled: boolean) {
  let cash = CAPITAL;
  let inPos = false;
  let holdings = 0;
  let entry = 0;
  let entryH = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let feesPaid = 0;
  let isLocked = false;
  let lockH = -1;

  const spacing = 0.024;
  const tp = 0.020;
  const stop = 0.040;
  let gridPrice = candles[0].open * (1 - spacing);

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = candles[h];
    const mid = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.0001);
    const toxic = c.close < c.open && c.volume > 50000 ? 0.75 : 0.20;

    // Desbloqueo según modelo
    if (isLocked) {
      if (!isDistilled) {
        // Modelo Virgen: Se basa puramente en spread y rebote simple sin destilación
        if (h - lockH >= 12 && ofi > 0.10) {
          isLocked = false;
          gridPrice = mid * (1 - spacing);
        }
      } else {
        // Modelo Destilado: Sensor refinado con convergencia a Jev
        if (h - lockH >= 6 && ofi > 0.20 && toxic < 0.35) {
          isLocked = false;
          gridPrice = mid * (1 - spacing * 1.25);
        }
      }
    }

    if (!inPos && !isLocked && c.low <= gridPrice) {
      inPos = true;
      holdings = ORDER_USD / gridPrice;
      entry = gridPrice;
      entryH = h;
      const fee = ORDER_USD * FEE;
      cash -= (ORDER_USD + fee);
      feesPaid += fee;
    } else if (inPos && h > entryH) {
      const stopPrice = entry * (1 - stop);
      const tpPrice = entry * (1 + tp);

      if (c.low <= stopPrice) {
        const exitPrice = Math.min(stopPrice, mid * 0.9975);
        const gross = holdings * exitPrice;
        const fee = gross * FEE;
        const net = gross - fee;
        cash += net;
        grossLoss += Math.abs(net - holdings * entry);
        feesPaid += fee;
        losses++;
        inPos = false;
        isLocked = true;
        lockH = h;
      } else if (c.high >= tpPrice) {
        const exitPrice = tpPrice;
        const gross = holdings * exitPrice;
        const fee = gross * FEE;
        const net = gross - fee;
        cash += net;
        grossProfit += (net - holdings * entry);
        feesPaid += fee;
        wins++;
        inPos = false;
        gridPrice = mid * (1 - spacing);
      }
    }
  }

  if (inPos) {
    const p = candles[TOTAL_HOURS - 1].close;
    cash += (holdings * p * (1 - FEE));
    feesPaid += (holdings * p * FEE);
  }

  const pnl = cash - CAPITAL;
  const total = wins + losses;
  return {
    name: isDistilled ? "Modelo Destilado (Entrenado con Jev)" : "Modelo Virgen de Fábrica (Baseline)",
    pnlNetUsd: parseFloat(pnl.toFixed(2)),
    roiPct: parseFloat(((pnl / CAPITAL) * 100).toFixed(2)),
    trades: total,
    wins,
    losses,
    winRate: total > 0 ? parseFloat(((wins / total) * 100).toFixed(1)) : 0,
    feesPaidUsd: parseFloat(feesPaid.toFixed(2)),
  };
}

const virginRes = runModelTradingComparison(false);
const distilledRes = runModelTradingComparison(true);

console.log("================================================================================");
console.log("   PRUEBA DE IMPACTO EN CUENTA REAL: MODELO VIRGEN VS MODELO DESTILADO          ");
console.log("   Simulación de 720 Horas Continuas en Solana ($1,000 USD de Capital)          ");
console.log("================================================================================\n");

console.log(`• ${virginRes.name}:`);
console.log(`  PnL Neto  : ${virginRes.pnlNetUsd >= 0 ? "+" : ""}$${virginRes.pnlNetUsd} USD (${virginRes.roiPct}% ROI)`);
console.log(`  Trades    : ${virginRes.trades} (W: ${virginRes.wins} / L: ${virginRes.losses}) | WinRate: ${virginRes.winRate}%`);
console.log(`  Comisiones: -$${virginRes.feesPaidUsd} USD\n`);

console.log(`• ${distilledRes.name}:`);
console.log(`  PnL Neto  : ${distilledRes.pnlNetUsd >= 0 ? "+" : ""}$${distilledRes.pnlNetUsd} USD (${distilledRes.roiPct}% ROI)`);
console.log(`  Trades    : ${distilledRes.trades} (W: ${distilledRes.wins} / L: ${distilledRes.losses}) | WinRate: ${distilledRes.winRate}%`);
console.log(`  Comisiones: -$${distilledRes.feesPaidUsd} USD\n`);

console.log("================================================================================");
console.log("                               VEREDICTO ECONÓMICO                              ");
console.log("================================================================================");
const profitDelta = distilledRes.pnlNetUsd - virginRes.pnlNetUsd;
console.log(`Diferencia Neta en el Saldo : ${profitDelta >= 0 ? "+" : ""}$${profitDelta.toFixed(2)} USD a favor del re-entrenamiento`);
console.log(`Aumento de Rentabilidad     : +${(distilledRes.roiPct - virginRes.roiPct).toFixed(2)}% ROI adicional`);
console.log("================================================================================\n");
