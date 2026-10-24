/**
 * SIMULACIÓN DE LA FUSIÓN:
 * 1. Tu Idea: Evaluación Continua de Laya (CERO reloj, CERO horas de espera fijas).
 * 2. Mi Análisis: Re-centrado geométrico con descuento (-0.35%) tras stop y TP al +0.45% sin asfixia de breakeven.
 * 
 * Evaluado en el Peor Mes de FX (720 horas de shock cambiario, de $18.26 a $17.12 MXN)
 * Con capital de $1,000 USD ($17,720 MXN).
 */

import { readFileSync } from "node:fs";

const RAW_FILE = "/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json";
const allCandles = JSON.parse(readFileSync(RAW_FILE, "utf-8"));
const FX_RATE = 17.72;

const START_INDEX = 96;
const TOTAL_HOURS = 720;
const monthCandles = allCandles.slice(START_INDEX, START_INDEX + TOTAL_HOURS);

const INITIAL_CAPITAL_MXN = 1000.0 * FX_RATE; // $17,720 MXN
const ORDER_SIZE_USD = 250.0;
const MAKER_FEE = 0.0010; // 0.10%

function simulateContinuousLayaArchitecture() {
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

  // Estado del sensor continuo de Laya
  let isAwaitingHealthyBook = false;

  let peakEquityMxn = INITIAL_CAPITAL_MXN;
  let maxDrawdownMxn = 0;

  // Primera orden Maker inicial
  let gridPrice = parseFloat((monthCandles[0].open * 0.9985).toFixed(3));

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = monthCandles[h];
    const midPrice = (c.open + c.close) / 2;

    // Métricas del sensor continuo de Laya en tiempo real
    const ofiScore = (c.close - c.open) / (c.high - c.low + 0.001);
    const toxicFlow = c.close < c.open && c.volume > 150000 ? 0.75 : 0.20;

    // [TU IDEA]: Evaluación continua pura de Laya (sin temporizadores ni reloj)
    if (isAwaitingHealthyBook) {
      const isBookHealthy = ofiScore > 0.20 && toxicFlow < 0.35;
      if (isBookHealthy) {
        // En el instante exacto en que entran compradores y se disipa la toxicidad: Luz Verde
        isAwaitingHealthyBook = false;
        // [MI APORTE]: Re-centrado con escalón de descuento (-0.35% del precio actual)
        gridPrice = parseFloat((midPrice * 0.9965).toFixed(3));
      }
    }

    // 1. Entrada por Malla Maker (solo si no estamos en posición y Laya autoriza)
    if (!inPos && !isAwaitingHealthyBook && c.low <= gridPrice) {
      const fillPrice = gridPrice;
      const costMxn = ORDER_SIZE_USD * fillPrice;
      const feeMxn = costMxn * MAKER_FEE;

      if (cashMxn >= costMxn + feeMxn) {
        inPos = true;
        usdHoldings = ORDER_SIZE_USD;
        entryPrice = fillPrice;
        entryHour = h;
        tpPrice = parseFloat((entryPrice * 1.0045).toFixed(3)); // TP +0.45% sin asfixia
        stopPrice = parseFloat((entryPrice * 0.9920).toFixed(3)); // Stop -0.80%

        cashMxn -= (costMxn + feeMxn);
        feesPaidMxn += feeMxn;
      }
    }
    // 2. Gestión de posición viva (mínimo 1 hora de maduración)
    else if (inPos && h > entryHour) {
      // Salida por Stop Defensivo
      if (c.low <= stopPrice || (toxicFlow > 0.70 && midPrice < entryPrice * 0.994)) {
        const exitPrice = Math.min(stopPrice, midPrice * 0.998); // Slippage de salida
        const proceedsGross = usdHoldings * exitPrice;
        const feeMxn = proceedsGross * MAKER_FEE;
        const proceedsNet = proceedsGross - feeMxn;
        const costBasis = usdHoldings * entryPrice;
        const lossMxn = proceedsNet - costBasis;

        cashMxn += proceedsNet;
        grossLossMxn += Math.abs(lossMxn);
        feesPaidMxn += feeMxn;
        losses++;

        inPos = false;
        usdHoldings = 0;

        // Tras el stop: pasar la batuta a la evaluación continua de Laya
        isAwaitingHealthyBook = true;
      }
      // Salida por Take Profit (+0.45%)
      else if (c.high >= tpPrice) {
        const exitPrice = tpPrice;
        const proceedsGross = usdHoldings * exitPrice;
        const feeMxn = proceedsGross * MAKER_FEE;
        const proceedsNet = proceedsGross - feeMxn;
        const costBasis = usdHoldings * entryPrice;
        const profitMxn = proceedsNet - costBasis;

        cashMxn += proceedsNet;
        grossProfitMxn += profitMxn;
        feesPaidMxn += feeMxn;
        wins++;

        inPos = false;
        usdHoldings = 0;
        // Recentrado normal de malla post-ganancia
        gridPrice = parseFloat((midPrice * 0.9985).toFixed(3));
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
    const proceedsGross = usdHoldings * finalPrice;
    const feeMxn = proceedsGross * MAKER_FEE;
    cashMxn += (proceedsGross - feeMxn);
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
console.log("   SIMULACIÓN DE LA FUSIÓN EN EL PEOR MES HISTÓRICO DE BITSO FX                 ");
console.log("   Evaluación Continua de Laya + Re-centrado Geométrico (-0.35%)               ");
console.log("================================================================================\n");

const fused = simulateContinuousLayaArchitecture();

console.log(`• Capital Inicial          : $${INITIAL_CAPITAL_MXN.toFixed(2)} MXN ($1,000 USD)`);
console.log(`• Capital Final al Mes     : $${fused.finalCapitalMxn.toFixed(2)} MXN`);
console.log(`• GANANCIA NETA LIMPIA     : ${fused.netPnlMxn >= 0 ? "+" : ""}$${fused.netPnlMxn.toFixed(2)} MXN (${fused.roiPct >= 0 ? "+" : ""}${fused.roiPct}% ROI)`);
console.log(`• Total Operaciones        : ${fused.totalTrades} (Ganadas: ${fused.wins} / Perdidas: ${fused.losses})`);
console.log(`• Win Rate Real            : ${fused.winRatePct}%`);
console.log(`• Profit Factor            : ${fused.profitFactor}`);
console.log(`• Comisiones Pagadas Bitso : -$${fused.feesPaidMxn.toFixed(2)} MXN`);
console.log(`• Drawdown Máximo          : ${fused.maxDrawdownPct}% de la cuenta`);
console.log("================================================================================\n");
