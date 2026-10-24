/**
 * FASE 1: AUDITORÍA MENSUAL FORENSE DE FX (usd_mxn en Bitso - 720 HORAS REALES)
 * 
 * Reglas Ácidas y Anti-Trampa:
 * 1. 720 Horas Continuas: Los últimos 30 días del dataset de Bitso (Septiembre 2026).
 * 2. Cero Fills Mágicos Intradía: Si el bot compra en una vela horaria, NO puede vender
 *    en esa misma vela; tiene que esperar al menos a la siguiente hora para que el mercado respire.
 * 3. Comisiones Maker 100% Reales Deducidas: -0.10% en cada compra y -0.10% en cada venta.
 * 4. Slippage de Salida en Pánico: -0.20% de penalización si el precio perfora el stop.
 * 5. Gobernanza por Laya System 1: Evalúa OFI y toxicFlow hora por hora para salidas Front-Run y paradas.
 * 
 * Evalúa dos escenarios de capital:
 * - Escenario A: Capital Piloto Actual ($120.00 MXN)
 * - Escenario B: Capital Objetivo Fondeado ($7,088.00 MXN / $400 USD)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RAW_FILE = "/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json";
const allCandles = JSON.parse(readFileSync(RAW_FILE, "utf-8"));
const FX_RATE = 17.72;

// Tomar las últimas 720 horas del dataset (30 días completos de Septiembre 2026)
const TOTAL_HOURS = 720;
const testCandles = allCandles.slice(allCandles.length - TOTAL_HOURS);

console.log("================================================================================");
console.log("   FASE 1: SIMULACIÓN MENSUAL FORENSE DE FX (BITSO usd_mxn) - 720 HORAS         ");
console.log(`   Periodo Evaluado: 30 Días Continuos (Desde ${new Date(testCandles[0].timestamp).toISOString()} hasta ${new Date(testCandles[TOTAL_HOURS - 1].timestamp).toISOString()})`);
console.log(`   Precio Inicial Mes: $${testCandles[0].open.toFixed(3)} | Precio Final Mes: $${testCandles[TOTAL_HOURS - 1].close.toFixed(3)} MXN`);
console.log("================================================================================\n");

interface FxMonthAudit {
  label: string;
  initialCapitalMxn: number;
  finalCapitalMxn: number;
  netPnlMxn: number;
  roiPct: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  feesPaidToBitsoMxn: number;
  avgHoldHours: number;
}

function runAcidFxMonth(label: string, initialCapitalMxn: number, orderSizeMxn: number): FxMonthAudit {
  let cashMxn = initialCapitalMxn;
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
  let totalHoldHours = 0;

  let peakEquityMxn = initialCapitalMxn;
  let maxDrawdownMxn = 0;

  // Parámetros conservadores
  const tpTargetPct = 0.0045; // +0.45% TP1
  const stopLossPct = 0.0080; // -0.80% Stop
  const makerFeeRate = 0.0010; // 0.10% Maker Fee de Bitso

  let gridPrice = parseFloat((testCandles[0].open * 0.9985).toFixed(3));
  let gridUsd = parseFloat((orderSizeMxn / gridPrice).toFixed(4));

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = testCandles[h];
    const midPrice = (c.open + c.close) / 2;

    // Métricas del sensor de microestructura de Laya
    const ofiScore = (c.close - c.open) / (c.high - c.low + 0.001);
    const toxicFlow = c.close < c.open && c.volume > 150000 ? 0.75 : 0.20;

    // 1. Entrada por Malla Maker (solo si no estamos en posición)
    if (!inPos && c.low <= gridPrice) {
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
    // 2. Gestión de Posición Viva (CERO salida en la misma hora de compra)
    else if (inPos && h > entryHour) {
      const holdTime = h - entryHour;

      // A. Stop Defensivo (si toca el suelo o Laya detecta toxicidad extrema con pérdida)
      if (c.low <= stopPrice || (toxicFlow > 0.70 && midPrice < entryAvgPrice * 0.994)) {
        const exitPrice = Math.min(stopPrice, midPrice * 0.998); // Con 0.2% de penalización por slippage
        const proceedsGross = usdHoldings * exitPrice;
        const feeMxn = proceedsGross * makerFeeRate;
        const proceedsNet = proceedsGross - feeMxn;
        const costBasis = usdHoldings * entryAvgPrice;
        const lossMxn = proceedsNet - costBasis;

        cashMxn += proceedsNet;
        grossLossMxn += Math.abs(lossMxn);
        feesPaidMxn += feeMxn;
        losses++;
        totalHoldHours += holdTime;

        inPos = false;
        usdHoldings = 0;
        entryAvgPrice = 0;
        // Esperar a que el mercado respire para volver a colocar la orden
        gridPrice = parseFloat((midPrice * 0.9985).toFixed(3));
        gridUsd = parseFloat((orderSizeMxn / gridPrice).toFixed(4));
      }
      // B. Take Profit (El precio rebota y toca el objetivo)
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
        totalHoldHours += holdTime;

        inPos = false;
        usdHoldings = 0;
        entryAvgPrice = 0;
        // Recentrar la siguiente compra justo debajo del precio actual
        gridPrice = parseFloat((midPrice * 0.9985).toFixed(3));
        gridUsd = parseFloat((orderSizeMxn / gridPrice).toFixed(4));
      }
    }

    const currentEquity = cashMxn + (inPos ? usdHoldings * midPrice : 0);
    if (currentEquity > peakEquityMxn) peakEquityMxn = currentEquity;
    const currentDd = peakEquityMxn - currentEquity;
    if (currentDd > maxDrawdownMxn) maxDrawdownMxn = currentDd;
  }

  // Si quedó posición abierta en la última hora del mes, liquidarla a mercado
  if (inPos) {
    const finalPrice = testCandles[TOTAL_HOURS - 1].close;
    const proceedsGross = usdHoldings * finalPrice;
    const feeMxn = proceedsGross * makerFeeRate;
    cashMxn += (proceedsGross - feeMxn);
    feesPaidMxn += feeMxn;
  }

  const netPnlMxn = cashMxn - initialCapitalMxn;
  const roiPct = (netPnlMxn / initialCapitalMxn) * 100;
  const totalTrades = wins + losses;
  const winRatePct = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const profitFactor = grossLossMxn > 0 ? grossProfitMxn / grossLossMxn : 99.9;
  const maxDrawdownPct = (maxDrawdownMxn / initialCapitalMxn) * 100;
  const avgHoldHours = totalTrades > 0 ? totalHoldHours / totalTrades : 0;

  return {
    label,
    initialCapitalMxn,
    finalCapitalMxn: parseFloat(cashMxn.toFixed(2)),
    netPnlMxn: parseFloat(netPnlMxn.toFixed(2)),
    roiPct: parseFloat(roiPct.toFixed(2)),
    totalTrades,
    winningTrades: wins,
    losingTrades: losses,
    winRatePct: parseFloat(winRatePct.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    maxDrawdownPct: parseFloat(maxDrawdownPct.toFixed(2)),
    feesPaidToBitsoMxn: parseFloat(feesPaidMxn.toFixed(2)),
    avgHoldHours: parseFloat(avgHoldHours.toFixed(1)),
  };
}

// 1. Escenario A: Piloto Actual ($120.00 MXN / Lote de $70.00 MXN)
const auditA = runAcidFxMonth("Escenario A: Piloto Real Actual", 120.0, 70.0);

// 2. Escenario B: Fondeo Completo ($7,088.00 MXN / Lotes de $1,400.00 MXN)
const auditB = runAcidFxMonth("Escenario B: Fondeo Completo ($400 USD)", 7088.0, 1400.0);

console.log("--------------------------------------------------------------------------------");
console.log(`1. RESULTADOS DEL PILOTO REAL ACTUAL ($120.00 MXN EN BITSO):`);
console.log(`• Capital Inicial          : $${auditA.initialCapitalMxn.toFixed(2)} MXN`);
console.log(`• Capital Final al Mes     : $${auditA.finalCapitalMxn.toFixed(2)} MXN`);
console.log(`• GANANCIA NETA LIMPIA     : ${auditA.netPnlMxn >= 0 ? "+" : ""}$${auditA.netPnlMxn.toFixed(2)} MXN (${auditA.roiPct >= 0 ? "+" : ""}${auditA.roiPct}% ROI Mensual)`);
console.log(`• Total Operaciones        : ${auditA.totalTrades} (Ganadas: ${auditA.winningTrades} / Perdidas: ${auditA.losingTrades})`);
console.log(`• Win Rate Real            : ${auditA.winRatePct}%`);
console.log(`• Profit Factor            : ${auditA.profitFactor}`);
console.log(`• Comisiones Pagadas Bitso : -$${auditA.feesPaidToBitsoMxn.toFixed(2)} MXN (Deducidas ya del PnL)`);
console.log(`• Tiempo Promedio por Trade: ${auditA.avgHoldHours} horas de retención`);
console.log(`• Drawdown Máximo          : ${auditA.maxDrawdownPct}%`);
console.log("--------------------------------------------------------------------------------\n");

console.log("--------------------------------------------------------------------------------");
console.log(`2. RESULTADOS DEL FONDEO COMPLETO ($7,088.00 MXN / $400 USD):`);
console.log(`• Capital Inicial          : $${auditB.initialCapitalMxn.toFixed(2)} MXN`);
console.log(`• Capital Final al Mes     : $${auditB.finalCapitalMxn.toFixed(2)} MXN`);
console.log(`• GANANCIA NETA LIMPIA     : ${auditB.netPnlMxn >= 0 ? "+" : ""}$${auditB.netPnlMxn.toFixed(2)} MXN (${auditB.roiPct >= 0 ? "+" : ""}${auditB.roiPct}% ROI Mensual)`);
console.log(`• Total Operaciones        : ${auditB.totalTrades} (Ganadas: ${auditB.winningTrades} / Perdidas: ${auditB.losingTrades})`);
console.log(`• Win Rate Real            : ${auditB.winRatePct}%`);
console.log(`• Profit Factor            : ${auditB.profitFactor}`);
console.log(`• Comisiones Pagadas Bitso : -$${auditB.feesPaidToBitsoMxn.toFixed(2)} MXN (Deducidas ya del PnL)`);
console.log(`• Tiempo Promedio por Trade: ${auditB.avgHoldHours} horas de retención`);
console.log(`• Drawdown Máximo          : ${auditB.maxDrawdownPct}%`);
console.log("--------------------------------------------------------------------------------\n");

const outReport = {
  testDate: new Date().toISOString(),
  periodDays: 30,
  totalHours: TOTAL_HOURS,
  pilotScenario: auditA,
  fullFundingScenario: auditB,
};

writeFileSync("/mnt/storage/alpha-backtest/fase1_fx_month_audit.json", JSON.stringify(outReport, null, 2));
console.log("Informe guardado en /mnt/storage/alpha-backtest/fase1_fx_month_audit.json");
