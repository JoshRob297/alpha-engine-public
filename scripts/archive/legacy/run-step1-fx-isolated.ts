/**
 * PASO 1 AISLADO: FASE 1 - FX EN BITSO (usd_mxn - 60 DÍAS / 1,440 HORAS)
 * Con el Flujo Evolved Completo + Trailing Take Profit Adaptativo
 * 
 * Periodo: 1,440 Horas Continuas (Septiembre 2026 - Incluye el Mes Negro de Choque)
 * Capital Asignado: $1,000 USD ($17,720.00 MXN)
 * Lote Base: $250 USD (~$4,430 MXN)
 * Comisiones: -0.10% Maker compra y -0.10% Maker venta pagadas a Bitso.
 * Slippage: -0.20% en salidas defensivas.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { generateAdaptiveSet } from "../src/guardrails/volatility-adaptive-sets.js";
import { evaluateEventDrivenTrigger, MicrostructureEventState } from "../src/guardrails/event-driven-allocator.js";

const FX_FILE = "/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json";
const fxAll = JSON.parse(readFileSync(FX_FILE, "utf-8"));
const TOTAL_HOURS = 1440;
const FX_RATE = 17.72;
const MAKER_FEE = 0.0010;

// Ventana de 1,440 horas exactas que arranca en el inicio del choque cambiario (Índice 96)
const testCandles = fxAll.slice(96, 96 + TOTAL_HOURS);
const INITIAL_CAPITAL_MXN = 1000.0 * FX_RATE; // $17,720 MXN

console.log("================================================================================");
console.log("   PASO 1 AISLADO: SIMULACIÓN DE 60 DÍAS EN FX (BITSO usd_mxn) - 1,440 HORAS    ");
console.log(`   Periodo: 1,440 Horas Continuas con Choque Cambiario y Consolidación Posterior`);
console.log(`   Capital Asignado: $${INITIAL_CAPITAL_MXN.toFixed(2)} MXN ($1,000.00 USD)     `);
console.log("================================================================================\n");

function runIsolatedFx60Days() {
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

  // Variables para Trailing Take Profit en FX
  let isTrailingActive = false;
  let highestHighSinceEntry = 0;
  let trailingStopPrice = 0;

  let isLocked = false;
  let lockH = -1;

  let peakEquityMxn = INITIAL_CAPITAL_MXN;
  let maxDrawdownMxn = 0;

  const eventState: MicrostructureEventState = {
    lastSpreadBps: 5.0,
    lastOfiScore: 0.0,
    lastEventTime: 0,
    postShockRecovery: false,
    consecutiveWins: 0,
  };

  let gridPrice = testCandles[0].open * 0.9985;

  for (let h = 15; h < TOTAL_HOURS; h++) {
    const c = testCandles[h];
    const midPrice = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.001);
    const spreadBps = ((c.high - c.low) / midPrice) * 10000;
    const toxic = c.close < c.open && c.volume > 150000 ? 0.75 : 0.20;

    const eventAction = evaluateEventDrivenTrigger(spreadBps, ofi, toxic > 0.60, isLocked, eventState);
    eventState.lastSpreadBps = spreadBps;
    eventState.lastOfiScore = ofi;

    const windowCandles = testCandles.slice(h - 14, h + 1);
    const adaptiveSet = generateAdaptiveSet(
      windowCandles,
      eventAction.operationalState === "EMERGENCY_HALT" ? "DEFENSIVE_STRESS" : "BALANCED_RANGE",
      spreadBps,
      MAKER_FEE,
      "FIAT"
    );

    // Trailing Grid al alza en FX si el dólar se escapa con fuerza compradora
    if (!inPos && midPrice > gridPrice * 1.015 && ofi > 0.20) {
      gridPrice = midPrice * (1 - adaptiveSet.spacingPct);
    }

    if (isLocked) {
      if (ofi > 0.20 && toxic < 0.35) {
        isLocked = false;
        eventState.postShockRecovery = true;
        gridPrice = midPrice * (1 - adaptiveSet.discountAfterSlPct);
      }
    }

    // Tamaño de orden dinámico
    const activeOrderUsd = 250.0 * eventAction.recommendedOrderFraction;

    // 1. Entrada Maker
    if (!inPos && !isLocked && eventAction.operationalState !== "EMERGENCY_HALT" && c.low <= gridPrice) {
      inPos = true;
      usdHoldings = activeOrderUsd;
      entryPrice = gridPrice;
      entryH = h;
      highestHighSinceEntry = c.high;
      isTrailingActive = false;

      const costMxn = activeOrderUsd * entryPrice;
      const feeMxn = costMxn * MAKER_FEE;
      cashMxn -= (costMxn + feeMxn);
      feesPaidMxn += feeMxn;
    }
    // 2. Posición Viva con Trailing Take Profit
    else if (inPos && h > entryH) {
      if (c.high > highestHighSinceEntry) {
        highestHighSinceEntry = c.high;
      }

      const initialTpThreshold = entryPrice * (1 + adaptiveSet.tpPct);
      const hardStopPrice = entryPrice * (1 - adaptiveSet.stopPct);
      const trailingGap = adaptiveSet.spacingPct * 1.5; // Distancia de seguimiento del trailing

      // Activar Trailing al superar el objetivo inicial (+0.45% a +0.55%)
      if (!isTrailingActive && c.high >= initialTpThreshold) {
        isTrailingActive = true;
        trailingStopPrice = highestHighSinceEntry * (1 - trailingGap);
      }

      if (isTrailingActive) {
        const candidateStop = highestHighSinceEntry * (1 - trailingGap);
        if (candidateStop > trailingStopPrice) {
          trailingStopPrice = candidateStop;
        }
      }

      const effectiveExitThreshold = isTrailingActive ? trailingStopPrice : hardStopPrice;

      // Salida por Hard Stop, Trailing Stop o Toxicidad Extrema
      if (c.low <= effectiveExitThreshold || (!isTrailingActive && toxic > 0.70 && midPrice < entryPrice * 0.994)) {
        const exitPrice = Math.min(effectiveExitThreshold, midPrice * 0.998);
        const grossProceeds = usdHoldings * exitPrice;
        const feeMxn = grossProceeds * MAKER_FEE;
        const netProceeds = grossProceeds - feeMxn;
        const costBasis = usdHoldings * entryPrice;
        const pnl = netProceeds - costBasis;

        cashMxn += netProceeds;
        feesPaidMxn += feeMxn;

        if (pnl >= 0) {
          grossProfitMxn += pnl;
          wins++;
          eventState.postShockRecovery = false;
        } else {
          grossLossMxn += Math.abs(pnl);
          losses++;
          isLocked = true;
          lockH = h;
        }

        inPos = false;
        usdHoldings = 0;
        isTrailingActive = false;
        gridPrice = midPrice * (1 - adaptiveSet.spacingPct);
      }
    }

    const currentEquity = cashMxn + (inPos ? usdHoldings * midPrice : 0);
    if (currentEquity > peakEquityMxn) peakEquityMxn = currentEquity;
    const currentDd = peakEquityMxn - currentEquity;
    if (currentDd > maxDrawdownMxn) maxDrawdownMxn = currentDd;
  }

  // Liquidación final al término de las 1,440 horas
  if (inPos) {
    const finalPrice = testCandles[TOTAL_HOURS - 1].close;
    const gross = usdHoldings * finalPrice;
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

const fxResult = runIsolatedFx60Days();

console.log("--------------------------------------------------------------------------------");
console.log("RESULTADOS DE LA FASE 1: RESERVA CAMBIARIA FX (usd_mxn en Bitso):");
console.log(`• Capital Inicial Fondeado   : $${fxResult.initialCapitalMxn.toFixed(2)} MXN ($1,000.00 USD)`);
console.log(`• Capital Final al Día 60    : $${fxResult.finalCapitalMxn.toFixed(2)} MXN`);
console.log(`• GANANCIA NETA LIMPIA TOTAL : ${fxResult.netPnlMxn >= 0 ? "+" : ""}$${fxResult.netPnlMxn.toFixed(2)} MXN (${fxResult.netPnlUsd >= 0 ? "+" : ""}$${fxResult.netPnlUsd.toFixed(2)} USD / ${fxResult.roiPct >= 0 ? "+" : ""}${fxResult.roiPct}%)`);
console.log(`• Total Operaciones en 60d   : ${fxResult.totalTrades} (Ganadas: ${fxResult.wins} / Perdidas: ${fxResult.losses})`);
console.log(`• Win Rate Real              : ${fxResult.winRate}%`);
console.log(`• Profit Factor              : ${fxResult.profitFactor}`);
console.log(`• Total Comisiones Bitso     : -$${fxResult.feesPaidMxn.toFixed(2)} MXN (-$${fxResult.feesPaidUsd.toFixed(2)} USD deducidas del balance)`);
console.log(`• Drawdown Máximo Sufrido    : ${fxResult.maxDrawdownPct}% de la cuenta`);
console.log("--------------------------------------------------------------------------------\n");

writeFileSync(
  "/mnt/storage/alpha-backtest/step1_fx_isolated_audit.json",
  JSON.stringify(fxResult, null, 2)
);
console.log("Informe de Fase 1 guardado en /mnt/storage/alpha-backtest/step1_fx_isolated_audit.json");
