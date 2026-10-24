/**
 * PASO 1 AISLADO OFICIAL: FASE 1 - FX EN BITSO (usd_mxn - 60 DÍAS / 1,440 HORAS)
 * Arquitectura Institucional de Micro-Spreads:
 * - TP Fijo Estándar a +0.45% (Toma ganancias pasiva Maker sin asfixia de trailing).
 * - Hard Stop ceñido al -0.80%.
 * - Re-centrado Geométrico con descuento gobernado por Laya Destilada.
 */

import { readFileSync, writeFileSync } from "node:fs";

const FX_FILE = "/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json";
const fxAll = JSON.parse(readFileSync(FX_FILE, "utf-8"));
const TOTAL_HOURS = 1440;
const FX_RATE = 17.72;
const MAKER_FEE = 0.0010;

const testCandles = fxAll.slice(96, 96 + TOTAL_HOURS);
const INITIAL_CAPITAL_MXN = 1000.0 * FX_RATE; // $17,720.00 MXN
const ORDER_SIZE_USD = 250.0;

function runOfficialFx60Days() {
  let cashMxn = INITIAL_CAPITAL_MXN;
  let inPos = false;
  let usdHoldings = 0;
  let entryPrice = 0;
  let entryH = 0;
  let wins = 0;
  let losses = 0;
  let grossProfitMxn = 0;
  let grossLossMxn = 0;
  let feesPaidMxn = 0;

  let isLocked = false;
  let lockH = -1;

  let peakEquityMxn = INITIAL_CAPITAL_MXN;
  let maxDrawdownMxn = 0;

  // Parámetros probados del genoma de micro-spread de Bitso
  const spacing = 0.0018; // -0.18%
  const tpTarget = 0.0045; // +0.45%
  const stopTarget = 0.0080; // -0.80%

  let gridPrice = testCandles[0].open * (1 - spacing);

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = testCandles[h];
    const midPrice = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.001);
    const toxic = c.close < c.open && c.volume > 150000 ? 0.75 : 0.20;

    // Desbloqueo continuo de Laya (sin reloj ciego)
    if (isLocked) {
      if (ofi > 0.20 && toxic < 0.35) {
        isLocked = false;
        gridPrice = midPrice * 0.9965; // Re-centrado defensivo con descuento
      }
    }

    // 1. Entrada Maker
    if (!inPos && !isLocked && c.low <= gridPrice) {
      inPos = true;
      usdHoldings = ORDER_SIZE_USD;
      entryPrice = gridPrice;
      entryH = h;
      const costMxn = ORDER_SIZE_USD * entryPrice;
      const feeMxn = costMxn * MAKER_FEE;
      cashMxn -= (costMxn + feeMxn);
      feesPaidMxn += feeMxn;
    }
    // 2. Posición Viva
    else if (inPos && h > entryH) {
      const stopPrice = entryPrice * (1 - stopTarget);
      const tpPrice = entryPrice * (1 + tpTarget);

      if (c.low <= stopPrice || (toxic > 0.70 && midPrice < entryPrice * 0.994)) {
        const exitPrice = Math.min(stopPrice, midPrice * 0.998);
        const gross = usdHoldings * exitPrice;
        const feeMxn = gross * MAKER_FEE;
        const net = gross - feeMxn;
        const loss = net - usdHoldings * entryPrice;

        cashMxn += net;
        grossLossMxn += Math.abs(loss);
        feesPaidMxn += feeMxn;
        losses++;

        inPos = false;
        usdHoldings = 0;
        isLocked = true;
        lockH = h;
      } else if (c.high >= tpPrice) {
        const exitPrice = tpPrice;
        const gross = usdHoldings * exitPrice;
        const feeMxn = gross * MAKER_FEE;
        const net = gross - feeMxn;
        const profit = net - usdHoldings * entryPrice;

        cashMxn += net;
        grossProfitMxn += profit;
        feesPaidMxn += feeMxn;
        wins++;

        inPos = false;
        usdHoldings = 0;
        gridPrice = midPrice * (1 - spacing);
      }
    }

    const currentEquity = cashMxn + (inPos ? usdHoldings * midPrice : 0);
    if (currentEquity > peakEquityMxn) peakEquityMxn = currentEquity;
    const currentDd = peakEquityMxn - currentEquity;
    if (currentDd > maxDrawdownMxn) maxDrawdownMxn = currentDd;
  }

  if (inPos) {
    const p = testCandles[TOTAL_HOURS - 1].close;
    const gross = usdHoldings * p;
    const feeMxn = gross * MAKER_FEE;
    cashMxn += (gross - feeMxn);
    feesPaidMxn += feeMxn;
  }

  const netPnlMxn = cashMxn - INITIAL_CAPITAL_MXN;
  const netPnlUsd = netPnlMxn / FX_RATE;
  const totalTrades = wins + losses;

  return {
    initialCapitalMxn: INITIAL_CAPITAL_MXN,
    finalCapitalMxn: parseFloat(cashMxn.toFixed(2)),
    netPnlMxn: parseFloat(netPnlMxn.toFixed(2)),
    netPnlUsd: parseFloat(netPnlUsd.toFixed(2)),
    roiPct: parseFloat(((netPnlMxn / INITIAL_CAPITAL_MXN) * 100).toFixed(2)),
    totalTrades,
    wins,
    losses,
    winRate: totalTrades > 0 ? parseFloat(((wins / totalTrades) * 100).toFixed(1)) : 0,
    profitFactor: grossLossMxn > 0 ? parseFloat((grossProfitMxn / grossLossMxn).toFixed(2)) : 99.9,
    feesPaidMxn: parseFloat(feesPaidMxn.toFixed(2)),
    feesPaidUsd: parseFloat((feesPaidMxn / FX_RATE).toFixed(2)),
    maxDrawdownPct: parseFloat(((maxDrawdownMxn / INITIAL_CAPITAL_MXN) * 100).toFixed(2)),
  };
}

console.log("================================================================================");
console.log("   PASO 1 AISLADO OFICIAL: SIMULACIÓN DE 60 DÍAS EN FX (BITSO usd_mxn)          ");
console.log("   Arquitectura Institucional de Micro-Spreads (TP Fijo +0.45% Maker Pasivo)   ");
console.log("================================================================================\n");

const fxFinal = runOfficialFx60Days();

console.log(`• Capital Inicial Fondeado   : $${fxFinal.initialCapitalMxn.toFixed(2)} MXN ($1,000.00 USD)`);
console.log(`• Capital Final al Día 60    : $${fxFinal.finalCapitalMxn.toFixed(2)} MXN`);
console.log(`• GANANCIA NETA LIMPIA TOTAL : ${fxFinal.netPnlMxn >= 0 ? "+" : ""}$${fxFinal.netPnlMxn.toFixed(2)} MXN (${fxFinal.netPnlUsd >= 0 ? "+" : ""}$${fxFinal.netPnlUsd.toFixed(2)} USD / ${fxFinal.roiPct >= 0 ? "+" : ""}${fxFinal.roiPct}%)`);
console.log(`• Total Operaciones en 60d   : ${fxFinal.totalTrades} (Ganadas: ${fxFinal.wins} / Perdidas: ${fxFinal.losses})`);
console.log(`• Win Rate Real              : ${fxFinal.winRate}%`);
console.log(`• Profit Factor              : ${fxFinal.profitFactor}`);
console.log(`• Total Comisiones Bitso     : -$${fxFinal.feesPaidMxn.toFixed(2)} MXN (-$${fxFinal.feesPaidUsd.toFixed(2)} USD deducidas ya)`);
console.log(`• Drawdown Máximo Sufrido    : ${fxFinal.maxDrawdownPct}% de la cuenta`);
console.log("================================================================================\n");

writeFileSync(
  "/mnt/storage/alpha-backtest/step1_fx_isolated_official.json",
  JSON.stringify(fxFinal, null, 2)
);
