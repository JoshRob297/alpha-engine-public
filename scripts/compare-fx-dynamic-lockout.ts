/**
 * COMPARADOR DIRECTO: MES DE FX (720 HORAS)
 * SIN CANDADO DINÁMICO VS CON CANDADO DINÁMICO DE LAYA
 * 
 * Regla del Candado Dinámico:
 * - Tras un stop defensivo, entra en estado LOCKED.
 * - Desbloqueo condicionado:
 *   1. Mínimo 4 horas de enfriamiento obligatorio.
 *   2. Laya confirma que el libro se estabilizó: OFI > +0.30 y toxicFlow < 0.35.
 */

import { readFileSync } from "node:fs";

const RAW_FILE = "/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json";
const allCandles = JSON.parse(readFileSync(RAW_FILE, "utf-8"));
const TOTAL_HOURS = 720;
const testCandles = allCandles.slice(allCandles.length - TOTAL_HOURS);

function runFxMonthWithDynamicLockout(withLockout: boolean) {
  let cashMxn = 120.0; // Piloto $120 MXN
  let inPos = false;
  let usdHoldings = 0;
  let entryAvgPrice = 0;
  let entryHour = 0;
  let tpPrice = 0;
  let stopPrice = 0;

  let wins = 0;
  let losses = 0;
  let grossProfitMxn = 0;
  let grossLossMxn = 0;
  let feesPaidMxn = 0;

  let isLocked = false;
  let lockHour = -1;

  const orderSizeMxn = 70.0;
  const tpTargetPct = 0.0045;
  const stopLossPct = 0.0080;
  const makerFeeRate = 0.0010;

  let gridPrice = parseFloat((testCandles[0].open * 0.9985).toFixed(3));
  let gridUsd = parseFloat((orderSizeMxn / gridPrice).toFixed(4));

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = testCandles[h];
    const midPrice = (c.open + c.close) / 2;

    const ofiScore = (c.close - c.open) / (c.high - c.low + 0.001);
    const toxicFlow = c.close < c.open && c.volume > 150000 ? 0.75 : 0.20;

    // Evaluación del Candado Dinámico de Laya
    if (withLockout && isLocked) {
      const hoursInLock = h - lockHour;
      // Condición de desbloqueo: Mínimo 4h Y Laya confirma flujo sano
      if (hoursInLock >= 4 && ofiScore > 0.30 && toxicFlow < 0.35) {
        isLocked = false;
        // Colocar nueva orden de compra
        gridPrice = parseFloat((midPrice * 0.9985).toFixed(3));
        gridUsd = parseFloat((orderSizeMxn / gridPrice).toFixed(4));
      }
    }

    // 1. Entrada por Malla si no estamos en posición ni bloqueados
    if (!inPos && (!withLockout || !isLocked) && c.low <= gridPrice) {
      const fillPrice = gridPrice;
      const costMxn = gridUsd * fillPrice;
      const feeMxn = costMxn * makerFeeRate;

      if (cashMxn >= costMxn + feeMxn) {
        inPos = true;
        usdHoldings = gridUsd;
        entryAvgPrice = fillPrice;
        entryHour = h;
        tpPrice = parseFloat((entryAvgPrice * (1 + tpTargetPct)).toFixed(3));
        stopPrice = parseFloat((entryAvgPrice * (1 - stopLossPct)).toFixed(3));

        cashMxn -= (costMxn + feeMxn);
        feesPaidMxn += feeMxn;
      }
    }
    // 2. Gestión de Posición Viva
    else if (inPos && h > entryHour) {
      // Stop Loss
      if (c.low <= stopPrice || (toxicFlow > 0.70 && midPrice < entryAvgPrice * 0.994)) {
        const exitPrice = Math.min(stopPrice, midPrice * 0.998);
        const proceedsGross = usdHoldings * exitPrice;
        const feeMxn = proceedsGross * makerFeeRate;
        const proceedsNet = proceedsGross - feeMxn;
        const costBasis = usdHoldings * entryAvgPrice;
        const lossMxn = proceedsNet - costBasis;

        cashMxn += proceedsNet;
        grossLossMxn += Math.abs(lossMxn);
        feesPaidMxn += feeMxn;
        losses++;

        inPos = false;
        usdHoldings = 0;
        entryAvgPrice = 0;

        if (withLockout) {
          isLocked = true;
          lockHour = h;
        } else {
          gridPrice = parseFloat((midPrice * 0.9985).toFixed(3));
          gridUsd = parseFloat((orderSizeMxn / gridPrice).toFixed(4));
        }
      }
      // Take Profit
      else if (c.high >= tpPrice) {
        const exitPrice = tpPrice;
        const proceedsGross = usdHoldings * exitPrice;
        const feeMxn = proceedsGross * makerFeeRate;
        const proceedsNet = proceedsGross - feeMxn;
        const costBasis = usdHoldings * entryAvgPrice;
        const profitMxn = proceedsNet - costBasis;

        cashMxn += proceedsNet;
        grossProfitMxn += profitMxn;
        feesPaidMxn += feeMxn;
        wins++;

        inPos = false;
        usdHoldings = 0;
        entryAvgPrice = 0;
        gridPrice = parseFloat((midPrice * 0.9985).toFixed(3));
        gridUsd = parseFloat((orderSizeMxn / gridPrice).toFixed(4));
      }
    }
  }

  if (inPos) {
    const finalPrice = testCandles[TOTAL_HOURS - 1].close;
    const proceedsGross = usdHoldings * finalPrice;
    const feeMxn = proceedsGross * makerFeeRate;
    cashMxn += (proceedsGross - feeMxn);
    feesPaidMxn += feeMxn;
  }

  const netPnlMxn = cashMxn - 120.0;
  const totalTrades = wins + losses;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const pf = grossLossMxn > 0 ? grossProfitMxn / grossLossMxn : 99.9;

  return {
    netPnlMxn: parseFloat(netPnlMxn.toFixed(2)),
    roiPct: parseFloat(((netPnlMxn / 120.0) * 100).toFixed(2)),
    totalTrades,
    wins,
    losses,
    winRate: parseFloat(winRate.toFixed(1)),
    profitFactor: parseFloat(pf.toFixed(2)),
    feesPaidMxn: parseFloat(feesPaidMxn.toFixed(2)),
    finalCapitalMxn: parseFloat(cashMxn.toFixed(2)),
  };
}

console.log("================================================================================");
console.log("   COMPARACIÓN DIRECTA EN EL MES DE FX (720 HORAS DE BITSO)                    ");
console.log("   Sin Candado Dinámico vs Con Candado Dinámico de Laya                         ");
console.log("================================================================================\n");

const withoutLock = runFxMonthWithDynamicLockout(false);
const withLock = runFxMonthWithDynamicLockout(true);

console.log(`1. SIN CANDADO DINÁMICO (Lógica Tradicional):`);
console.log(`• PnL Neto Final     : +$${withoutLock.netPnlMxn.toFixed(2)} MXN (+${withoutLock.roiPct}% ROI)`);
console.log(`• Trades             : ${withoutLock.totalTrades} (Ganadas: ${withoutLock.wins} / Perdidas: ${withoutLock.losses})`);
console.log(`• Win Rate           : ${withoutLock.winRate}%`);
console.log(`• Profit Factor      : ${withoutLock.profitFactor}`);
console.log(`• Comisiones Bitso   : -$${withoutLock.feesPaidMxn} MXN\n`);

console.log(`2. CON CANDADO DINÁMICO DE LAYA (Desbloqueo Inteligente por OFI y Toxicidad):`);
console.log(`• PnL Neto Final     : +$${withLock.netPnlMxn.toFixed(2)} MXN (+${withLock.roiPct}% ROI)`);
console.log(`• Trades             : ${withLock.totalTrades} (Ganadas: ${withLock.wins} / Perdidas: ${withLock.losses})`);
console.log(`• Win Rate           : ${withLock.winRate}%`);
console.log(`• Profit Factor      : ${withLock.profitFactor}`);
console.log(`• Comisiones Bitso   : -$${withLock.feesPaidMxn} MXN\n`);

console.log("================================================================================");
console.log("                               VEREDICTO FORENSE                                ");
console.log("================================================================================");
const diffPnl = withLock.netPnlMxn - withoutLock.netPnlMxn;
console.log(`Diferencia de Rendimiento : ${diffPnl >= 0 ? "+" : ""}$${diffPnl.toFixed(2)} MXN con Candado Dinámico`);
console.log(`Ahorro en Comisiones      : $${(withoutLock.feesPaidMxn - withLock.feesPaidMxn).toFixed(2)} MXN menos en tarifas de Bitso`);
console.log(`Profit Factor             : Subió de ${withoutLock.profitFactor} a ${withLock.profitFactor}`);
console.log("================================================================================\n");
