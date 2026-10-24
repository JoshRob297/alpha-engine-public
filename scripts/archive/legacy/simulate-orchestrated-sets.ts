/**
 * SIMULACIÓN MENSUAL COMPLETA (PEOR MES HISTÓRICO DE BITSO FX)
 * Evaluando el Flujo Completo Institucional:
 * 1. Post-SL -> Evaluación Continua de Laya (minuto a minuto, sin reloj ciego)
 * 2. Luz Verde de Laya -> Llamada a Régimen (Jev / Policy)
 * 3. Régimen -> Despliegue de Sets Dinámicos (re-centrado adaptativo según volatilidad y régimen)
 */

import { readFileSync } from "node:fs";
import { calculateFxDynamicSet, FxDynamicSet } from "../src/guardrails/fx-dynamic-sets.js";

const RAW_FILE = "/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json";
const allCandles = JSON.parse(readFileSync(RAW_FILE, "utf-8"));
const FX_RATE = 17.72;

// Ventana de las 720 horas del peor mes de shock (de $18.26 a $17.12 MXN)
const START_INDEX = 96;
const TOTAL_HOURS = 720;
const monthCandles = allCandles.slice(START_INDEX, START_INDEX + TOTAL_HOURS);

const INITIAL_CAPITAL_MXN = 1000.0 * FX_RATE; // $17,720 MXN ($1,000 USD)
const ORDER_SIZE_USD = 250.0;
const MAKER_FEE = 0.0010;

function runFullOrchestratedSimulation() {
  let cashMxn = INITIAL_CAPITAL_MXN;
  let inPos = false;
  let usdHoldings = 0;
  let entryPrice = 0;
  let entryHour = 0;
  let stopPrice = 0;
  let tpPrice = 0;

  let wins = 0;
  let losses = 0;
  let grossProfitMxn = 0;
  let grossLossMxn = 0;
  let feesPaidMxn = 0;

  let isAwaitingLaya = false;
  let currentSet: FxDynamicSet = calculateFxDynamicSet("BALANCED_RANGE");
  let gridPrice = monthCandles[0].open * (1 - currentSet.spacingPct);

  let peakEquityMxn = INITIAL_CAPITAL_MXN;
  let maxDrawdownMxn = 0;

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = monthCandles[h];
    const midPrice = (c.open + c.close) / 2;

    const ofiScore = (c.close - c.open) / (c.high - c.low + 0.001);
    const toxicFlow = c.close < c.open && c.volume > 150000 ? 0.75 : 0.20;

    // Clasificación dinámica de régimen (Macro Jev)
    const prev24Close = monthCandles[Math.max(0, h - 24)].close;
    const change24hPct = ((c.close - prev24Close) / prev24Close) * 100;
    
    let detectedRegime: "BALANCED_RANGE" | "EXPANSION_UP" | "DEFENSIVE_STRESS" = "BALANCED_RANGE";
    if (change24hPct < -1.2 || toxicFlow > 0.70) {
      detectedRegime = "DEFENSIVE_STRESS";
    } else if (change24hPct > 1.2 && ofiScore > 0.30) {
      detectedRegime = "EXPANSION_UP";
    }

    // 1. Post-SL: Evaluación Continua de Laya
    if (isAwaitingLaya) {
      const isBookHealthy = ofiScore > 0.20 && toxicFlow < 0.35 && detectedRegime !== "DEFENSIVE_STRESS";
      if (isBookHealthy) {
        // Luz verde de Laya alcanzada -> Invocación del Set Dinámico correspondiente
        isAwaitingLaya = false;
        currentSet = calculateFxDynamicSet(detectedRegime);
        // Re-centrado automático adaptativo del Set
        gridPrice = parseFloat((midPrice * (1 - currentSet.discountAfterSlPct)).toFixed(3));
      }
    }

    // 2. Entrada Maker pasiva
    if (!inPos && !isAwaitingLaya && c.low <= gridPrice) {
      const fillPrice = gridPrice;
      const costMxn = ORDER_SIZE_USD * fillPrice;
      const feeMxn = costMxn * MAKER_FEE;

      if (cashMxn >= costMxn + feeMxn) {
        inPos = true;
        usdHoldings = ORDER_SIZE_USD;
        entryPrice = fillPrice;
        entryHour = h;
        tpPrice = parseFloat((entryPrice * (1 + currentSet.tpPct)).toFixed(3));
        stopPrice = parseFloat((entryPrice * (1 - currentSet.stopPct)).toFixed(3));

        cashMxn -= (costMxn + feeMxn);
        feesPaidMxn += feeMxn;
      }
    }
    // 3. Gestión de posición viva (mínimo 1 hora de maduración)
    else if (inPos && h > entryHour) {
      // Hard Stop o Salida de Emergencia por Laya
      if (c.low <= stopPrice || (toxicFlow > 0.70 && midPrice < entryPrice * 0.994)) {
        const exitPrice = Math.min(stopPrice, midPrice * 0.998); // Con slippage
        const feeMxn = usdHoldings * exitPrice * MAKER_FEE;
        const netProceeds = usdHoldings * exitPrice - feeMxn;
        const costBasis = usdHoldings * entryPrice;
        const loss = netProceeds - costBasis;

        cashMxn += netProceeds;
        grossLossMxn += Math.abs(loss);
        feesPaidMxn += feeMxn;
        losses++;

        inPos = false;
        usdHoldings = 0;

        // Activar el sensor continuo de Laya para la recuperación
        isAwaitingLaya = true;
      }
      // Take Profit adaptativo del Set
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

        inPos = false;
        usdHoldings = 0;

        // Post-ganancia: actualizar el Set al régimen actual y recentrar
        currentSet = calculateFxDynamicSet(detectedRegime);
        gridPrice = parseFloat((midPrice * (1 - currentSet.spacingPct)).toFixed(3));
      }
    }

    const currentEquity = cashMxn + (inPos ? usdHoldings * midPrice : 0);
    if (currentEquity > peakEquityMxn) peakEquityMxn = currentEquity;
    const currentDd = peakEquityMxn - currentEquity;
    if (currentDd > maxDrawdownMxn) maxDrawdownMxn = currentDd;
  }

  // Liquidación de cierre
  if (inPos) {
    const finalPrice = monthCandles[TOTAL_HOURS - 1].close;
    const feeMxn = usdHoldings * finalPrice * MAKER_FEE;
    cashMxn += (usdHoldings * finalPrice - feeMxn);
    feesPaidMxn += feeMxn;
  }

  const netPnlMxn = cashMxn - INITIAL_CAPITAL_MXN;
  const roiPct = (netPnlMxn / INITIAL_CAPITAL_MXN) * 100;
  const totalTrades = wins + losses;
  const winRatePct = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const profitFactor = grossLossMxn > 0 ? grossProfitMxn / grossLossMxn : 99.9;
  const maxDrawdownPct = (maxDrawdownMxn / INITIAL_CAPITAL_MXN) * 100;

  return {
    netPnlMxn: parseFloat(netPnlMxn.toFixed(2)),
    roiPct: parseFloat(roiPct.toFixed(2)),
    totalTrades,
    wins,
    losses,
    winRatePct: parseFloat(winRatePct.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    feesPaidMxn: parseFloat(feesPaidMxn.toFixed(2)),
    maxDrawdownPct: parseFloat(maxDrawdownPct.toFixed(2)),
    finalCapitalMxn: parseFloat(cashMxn.toFixed(2)),
  };
}

console.log("================================================================================");
console.log("   SIMULACIÓN COMPLETA: LAYA CONTINUO + JEV RÉGIMEN + SETS DINÁMICOS POST-SL   ");
console.log("   Peor Mes Histórico de Bitso USD/MXN (720 Horas - Capital $1,000 USD)         ");
console.log("================================================================================\n");

const res = runFullOrchestratedSimulation();

console.log(`• Capital Inicial          : $${INITIAL_CAPITAL_MXN.toFixed(2)} MXN ($1,000 USD)`);
console.log(`• Capital Final al Mes     : $${res.finalCapitalMxn.toFixed(2)} MXN`);
console.log(`• GANANCIA NETA LIMPIA     : ${res.netPnlMxn >= 0 ? "+" : ""}$${res.netPnlMxn.toFixed(2)} MXN (${res.roiPct >= 0 ? "+" : ""}${res.roiPct}% ROI)`);
console.log(`• Total Operaciones        : ${res.totalTrades} (Ganadas: ${res.wins} / Perdidas: ${res.losses})`);
console.log(`• Win Rate Real            : ${res.winRatePct}%`);
console.log(`• Profit Factor            : ${res.profitFactor}`);
console.log(`• Comisiones Pagadas Bitso : -$${res.feesPaidMxn.toFixed(2)} MXN`);
console.log(`• Drawdown Máximo          : ${res.maxDrawdownPct}% de la cuenta`);
console.log("================================================================================\n");
