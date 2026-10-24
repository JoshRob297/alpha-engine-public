/**
 * FASE 1: AUDITORÍA DE 2 MESES CONTINUOS (60 DÍAS / 1,440 HORAS) EN FX (BITSO usd_mxn)
 * Incluye el MES NEGRO de mayor volatilidad/choque (Marzo-Abril 2026)
 * seguido inmediatamente del mes de estabilización y recuperación.
 * 
 * Capital: $1,000 USD ($17,720 MXN)
 * Motor: Nuevo Laya Destilado + Sets Adaptativos por ATR
 * Fricciones Reales: -0.10% Maker compra, -0.10% Maker venta, slippage de salida, cero ejecución intradía.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { generateAdaptiveSet } from "../src/guardrails/volatility-adaptive-sets.js";

const FX_FILE = "/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json";
const allCandles = JSON.parse(readFileSync(FX_FILE, "utf-8"));
const FX_RATE = 17.72;

// Ventana de 1,440 horas que arranca exactamente en el inicio del Mes Negro (Índice 96)
const START_INDEX = 96;
const TOTAL_HOURS = 1440; // 60 días continuos
const testCandles = allCandles.slice(START_INDEX, START_INDEX + TOTAL_HOURS);

const INITIAL_CAPITAL_MXN = 1000.0 * FX_RATE; // $17,720.00 MXN ($1,000 USD)
const ORDER_SIZE_USD = 250.0;
const MAKER_FEE = 0.0010;

console.log("================================================================================");
console.log("   FASE 1: SIMULACIÓN DE 2 MESES CONTINUOS (60 DÍAS / 1,440 HORAS) EN FX        ");
console.log(`   Periodo: Desde ${new Date(testCandles[0].timestamp).toISOString().slice(0, 10)} hasta ${new Date(testCandles[TOTAL_HOURS - 1].timestamp).toISOString().slice(0, 10)}`);
console.log(`   Apertura Mes 1: $${testCandles[0].open.toFixed(3)} | Cierre Mes 2: $${testCandles[TOTAL_HOURS - 1].close.toFixed(3)} MXN`);
console.log(`   Rango Extremo del Periodo: Min $${Math.min(...testCandles.map((c: any) => c.low)).toFixed(3)} - Max $${Math.max(...testCandles.map((c: any) => c.high)).toFixed(3)} MXN`);
console.log("================================================================================\n");

function run60DaysFxSimulation() {
  let cashMxn = INITIAL_CAPITAL_MXN;
  let inPos = false;
  let usdHoldings = 0;
  let entryPrice = 0;
  let entryH = 0;
  let stopPrice = 0;
  let tpPrice = 0;

  let wins = 0;
  let losses = 0;
  let grossProfitMxn = 0;
  let grossLossMxn = 0;
  let feesPaidMxn = 0;

  // Tracking específico por mes para aislar el Mes Negro vs Mes de Recuperación
  let m1Wins = 0;
  let m1Losses = 0;
  let m1Pnl = 0;
  let m2Wins = 0;
  let m2Losses = 0;
  let m2Pnl = 0;

  let isAwaitingLaya = false;
  let gridPrice = testCandles[0].open * 0.9985;

  let peakEquityMxn = INITIAL_CAPITAL_MXN;
  let maxDrawdownMxn = 0;

  for (let h = 15; h < TOTAL_HOURS; h++) {
    const c = testCandles[h];
    const midPrice = (c.open + c.close) / 2;

    const ofiScore = (c.close - c.open) / (c.high - c.low + 0.001);
    const toxicFlow = c.close < c.open && c.volume > 150000 ? 0.75 : 0.20;

    const prev24Close = testCandles[Math.max(0, h - 24)].close;
    const change24hPct = ((c.close - prev24Close) / prev24Close) * 100;

    let detectedRegime: "BALANCED_RANGE" | "EXPANSION_UP" | "DEFENSIVE_STRESS" = "BALANCED_RANGE";
    if (change24hPct < -1.2 || toxicFlow > 0.70) {
      detectedRegime = "DEFENSIVE_STRESS";
    } else if (change24hPct > 1.2 && ofiScore > 0.30) {
      detectedRegime = "EXPANSION_UP";
    }

    const windowCandles = testCandles.slice(h - 14, h + 1);
    const adaptiveSet = generateAdaptiveSet(windowCandles, detectedRegime, 5, MAKER_FEE);

    // Laya Destilado: Sensor continuo sin reloj
    if (isAwaitingLaya) {
      const isBookHealthy = ofiScore > 0.20 && toxicFlow < 0.35 && detectedRegime !== "DEFENSIVE_STRESS";
      if (isBookHealthy) {
        isAwaitingLaya = false;
        gridPrice = parseFloat((midPrice * (1 - adaptiveSet.discountAfterSlPct)).toFixed(3));
      }
    }

    // 1. Entrada Maker Pasiva
    if (!inPos && !isAwaitingLaya && c.low <= gridPrice) {
      const fillPrice = gridPrice;
      const costMxn = ORDER_SIZE_USD * fillPrice;
      const feeMxn = costMxn * MAKER_FEE;

      if (cashMxn >= costMxn + feeMxn) {
        inPos = true;
        usdHoldings = ORDER_SIZE_USD;
        entryPrice = fillPrice;
        entryH = h;
        tpPrice = parseFloat((entryPrice * (1 + adaptiveSet.tpPct)).toFixed(3));
        stopPrice = parseFloat((entryPrice * (1 - adaptiveSet.stopPct)).toFixed(3));

        cashMxn -= (costMxn + feeMxn);
        feesPaidMxn += feeMxn;
      }
    }
    // 2. Posición Viva (mínimo 1 hora)
    else if (inPos && h > entryH) {
      // Salida Defensiva por Stop Loss o Toxicidad
      if (c.low <= stopPrice || (toxicFlow > 0.70 && midPrice < entryPrice * 0.994)) {
        const exitPrice = Math.min(stopPrice, midPrice * 0.998);
        const feeMxn = usdHoldings * exitPrice * MAKER_FEE;
        const netProceeds = usdHoldings * exitPrice - feeMxn;
        const costBasis = usdHoldings * entryPrice;
        const loss = netProceeds - costBasis;

        cashMxn += netProceeds;
        grossLossMxn += Math.abs(loss);
        feesPaidMxn += feeMxn;
        losses++;

        if (h < 720) { m1Losses++; m1Pnl += loss; }
        else { m2Losses++; m2Pnl += loss; }

        inPos = false;
        usdHoldings = 0;
        isAwaitingLaya = true;
      }
      // Salida por Take Profit
      else if (c.high >= tpPrice) {
        const exitPrice = tpPrice;
        const feeMxn = usdHoldings * exitPrice * MAKER_FEE;
        const netProceeds = usdHoldings * exitPrice - feeMxn;
        const costBasis = usdHoldings * entryPrice;
        const profit = netProceeds - costBasis;

        cashMxn += netProceeds;
        grossProfitMxn += profit;
        feesPaidMxn += feeMxn;
        wins++;

        if (h < 720) { m1Wins++; m1Pnl += profit; }
        else { m2Wins++; m2Pnl += profit; }

        inPos = false;
        usdHoldings = 0;
        gridPrice = parseFloat((midPrice * (1 - adaptiveSet.spacingPct)).toFixed(3));
      }
    }

    const currentEquity = cashMxn + (inPos ? usdHoldings * midPrice : 0);
    if (currentEquity > peakEquityMxn) peakEquityMxn = currentEquity;
    const currentDd = peakEquityMxn - currentEquity;
    if (currentDd > maxDrawdownMxn) maxDrawdownMxn = currentDd;
  }

  // Liquidación final al cierre de las 1,440 horas
  if (inPos) {
    const finalPrice = testCandles[TOTAL_HOURS - 1].close;
    const feeMxn = usdHoldings * finalPrice * MAKER_FEE;
    const netProceeds = usdHoldings * finalPrice - feeMxn;
    cashMxn += netProceeds;
    feesPaidMxn += feeMxn;
  }

  const netPnlMxn = cashMxn - INITIAL_CAPITAL_MXN;
  const netPnlUsd = netPnlMxn / FX_RATE;
  const totalTrades = wins + losses;

  return {
    netPnlMxn: parseFloat(netPnlMxn.toFixed(2)),
    netPnlUsd: parseFloat(netPnlUsd.toFixed(2)),
    roiPct: parseFloat(((netPnlMxn / INITIAL_CAPITAL_MXN) * 100).toFixed(2)),
    totalTrades,
    wins,
    losses,
    winRate: parseFloat(((wins / totalTrades) * 100).toFixed(1)),
    profitFactor: grossLossMxn > 0 ? parseFloat((grossProfitMxn / grossLossMxn).toFixed(2)) : 99.9,
    feesPaidMxn: parseFloat(feesPaidMxn.toFixed(2)),
    feesPaidUsd: parseFloat((feesPaidMxn / FX_RATE).toFixed(2)),
    maxDrawdownPct: parseFloat(((maxDrawdownMxn / INITIAL_CAPITAL_MXN) * 100).toFixed(2)),
    m1Wins,
    m1Losses,
    m1PnlMxn: parseFloat(m1Pnl.toFixed(2)),
    m2Wins,
    m2Losses,
    m2PnlMxn: parseFloat(m2Pnl.toFixed(2)),
    finalCapitalMxn: parseFloat(cashMxn.toFixed(2)),
  };
}

const fxAudit = run60DaysFxSimulation();

console.log("--------------------------------------------------------------------------------");
console.log("DESGLOSE POR MES DE FX (usd_mxn):");
console.log(`• MES 1 (MES NEGRO DE CHOQUE - 720h)       : PnL ${fxAudit.m1PnlMxn >= 0 ? "+" : ""}$${fxAudit.m1PnlMxn} MXN | Trades: ${fxAudit.m1Wins + fxAudit.m1Losses} (W: ${fxAudit.m1Wins} / L: ${fxAudit.m1Losses})`);
console.log(`• MES 2 (MES DE RECUPERACIÓN - 720h)       : PnL ${fxAudit.m2PnlMxn >= 0 ? "+" : ""}$${fxAudit.m2PnlMxn} MXN | Trades: ${fxAudit.m2Wins + fxAudit.m2Losses} (W: ${fxAudit.m2Wins} / L: ${fxAudit.m2Losses})`);
console.log("--------------------------------------------------------------------------------");
console.log("BALANCE GLOBAL ACUMULADO DE LOS 60 DÍAS COMPLETOS (1,440 HORAS):");
console.log(`• Capital Inicial Fondeado   : $${INITIAL_CAPITAL_MXN.toFixed(2)} MXN ($1,000.00 USD)`);
console.log(`• Capital Final al Día 60    : $${fxAudit.finalCapitalMxn.toFixed(2)} MXN`);
console.log(`• GANANCIA NETA LIMPIA TOTAL : ${fxAudit.netPnlMxn >= 0 ? "+" : ""}$${fxAudit.netPnlMxn.toFixed(2)} MXN (${fxAudit.netPnlUsd >= 0 ? "+" : ""}$${fxAudit.netPnlUsd.toFixed(2)} USD / ${fxAudit.roiPct >= 0 ? "+" : ""}${fxAudit.roiPct}%)`);
console.log(`• Total Operaciones del Bucle: ${fxAudit.totalTrades} (Ganadas: ${fxAudit.wins} / Perdidas: ${fxAudit.losses})`);
console.log(`• Win Rate Global en 60 Días : ${fxAudit.winRate}%`);
console.log(`• Profit Factor Global       : ${fxAudit.profitFactor}`);
console.log(`• Total Comisiones Bitso     : -$${fxAudit.feesPaidMxn.toFixed(2)} MXN (-$${fxAudit.feesPaidUsd.toFixed(2)} USD deducidas ya del PnL)`);
console.log(`• Drawdown Máximo Sufrido    : ${fxAudit.maxDrawdownPct}% de la cuenta`);
console.log("================================================================================\n");

writeFileSync(
  "/mnt/storage/alpha-backtest/fase1_60days_fx_audit.json",
  JSON.stringify(fxAudit, null, 2)
);
