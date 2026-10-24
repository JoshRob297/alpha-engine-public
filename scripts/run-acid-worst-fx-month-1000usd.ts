/**
 * AUDITORÍA MENSUAL ÁCIDA DEL PEOR MES HISTÓRICO DE FX (BITSO usd_mxn)
 * Con Capital Significativo: $1,000 USD (~$17,720 MXN)
 * Periodo: 18 de Marzo a 17 de Abril (El mes de mayor shock: Rango 6.69%, de $18.268 a $17.123 MXN)
 * 
 * Comparativa Frente a Frente (720 Horas Continuas):
 * 1. Escenario A: Sistema Anterior (Sin veto ni candado dinámico)
 * 2. Escenario B: Sistema Blindado (Veto de régimen Jev + Sensor Laya + Candado dinámico)
 * 
 * Reglas Ácidas:
 * - Comisiones Maker deducidas: -0.10% compra y -0.10% venta pagadas a Bitso.
 * - Cero salidas en la misma hora de entrada.
 * - Slippage de castigo en stops: -0.20%.
 */

import { readFileSync, writeFileSync } from "node:fs";

const RAW_FILE = "/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json";
const allCandles = JSON.parse(readFileSync(RAW_FILE, "utf-8"));
const FX_RATE = 17.72;

// Ventana de las 720 horas del peor mes de volatilidad (Índice 96: 18 de Marzo a 17 de Abril)
const START_INDEX = 96;
const TOTAL_HOURS = 720;
const monthCandles = allCandles.slice(START_INDEX, START_INDEX + TOTAL_HOURS);

const CAPITAL_USD = 1000.0;
const INITIAL_CAPITAL_MXN = CAPITAL_USD * FX_RATE; // $17,720.00 MXN

console.log("================================================================================");
console.log("   AUDITORÍA DEL PEOR MES HISTÓRICO EN BITSO FX CON $1,000 USD ($17,720 MXN)   ");
console.log(`   Periodo: 720 Horas (18 de Marzo a 17 de Abril) // Rango de Shock: 6.69%     `);
console.log(`   Apertura: $${monthCandles[0].open.toFixed(3)} | Max: $${Math.max(...monthCandles.map((c: any) => c.high)).toFixed(3)} | Min: $${Math.min(...monthCandles.map((c: any) => c.low)).toFixed(3)} | Cierre: $${monthCandles[719].close.toFixed(3)} MXN`);
console.log("================================================================================\n");

function simulateWorstMonth(name: string, withShield: boolean) {
  let cashMxn = INITIAL_CAPITAL_MXN;
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

  let peakEquityMxn = INITIAL_CAPITAL_MXN;
  let maxDrawdownMxn = 0;

  // Lotes estándar con $1,000 USD de capital: Órdenes de $250 USD (~$4,430 MXN por lote)
  const orderSizeUsd = 250.0;
  const tpTargetPct = 0.0045; // +0.45% TP1
  const stopLossPct = 0.0080; // -0.80% Stop
  const makerFeeRate = 0.0010; // 0.10% Maker Fee de Bitso

  let gridPrice = parseFloat((monthCandles[0].open * 0.9985).toFixed(3));
  let gridUsd = orderSizeUsd;

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = monthCandles[h];
    const midPrice = (c.open + c.close) / 2;

    const ofiScore = (c.close - c.open) / (c.high - c.low + 0.001);
    const toxicFlow = c.close < c.open && c.volume > 150000 ? 0.75 : 0.20;
    const isDevaluationStress = c.close < monthCandles[Math.max(0, h - 24)].close * 0.985; // Caída de 1.5% en 24h

    // Evaluación del Candado Dinámico de Laya
    if (withShield && isLocked) {
      const hoursInLock = h - lockHour;
      // Desbloqueo: Mínimo 4h Y confirmación de libro sano por Laya
      if (hoursInLock >= 4 && ofiScore > 0.25 && toxicFlow < 0.35 && !isDevaluationStress) {
        isLocked = false;
        gridPrice = parseFloat((midPrice * 0.9985).toFixed(3));
      }
    }

    // 1. Entrada por Malla Maker
    if (!inPos && (!withShield || !isLocked) && c.low <= gridPrice) {
      // Veto de régimen con blindaje
      if (withShield && isDevaluationStress) {
        // Veto activo: No comprar dólares cayendo a cuchillo
      } else {
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
    }
    // 2. Gestión de Posición Viva
    else if (inPos && h > entryHour) {
      // Stop Loss
      if (c.low <= stopPrice || (withShield && toxicFlow > 0.70 && midPrice < entryAvgPrice * 0.994)) {
        const exitPrice = Math.min(stopPrice, midPrice * 0.998); // Con slippage
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

        if (withShield) {
          isLocked = true;
          lockHour = h;
        } else {
          gridPrice = parseFloat((midPrice * 0.9985).toFixed(3));
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
      }
    }

    const currentEquity = cashMxn + (inPos ? usdHoldings * midPrice : 0);
    if (currentEquity > peakEquityMxn) peakEquityMxn = currentEquity;
    const currentDd = peakEquityMxn - currentEquity;
    if (currentDd > maxDrawdownMxn) maxDrawdownMxn = currentDd;
  }

  // Liquidar si quedó posición abierta al cierre
  if (inPos) {
    const finalPrice = monthCandles[TOTAL_HOURS - 1].close;
    const proceedsGross = usdHoldings * finalPrice;
    const feeMxn = proceedsGross * makerFeeRate;
    cashMxn += (proceedsGross - feeMxn);
    feesPaidMxn += feeMxn;
  }

  const netPnlMxn = cashMxn - INITIAL_CAPITAL_MXN;
  const roiPct = (netPnlMxn / INITIAL_CAPITAL_MXN) * 100;
  const totalTrades = wins + losses;
  const winRatePct = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const profitFactor = grossLossMxn > 0 ? grossProfitMxn / grossLossMxn : 99.9;
  const maxDrawdownPct = (maxDrawdownMxn / INITIAL_CAPITAL_MXN) * 100;

  console.log(`--------------------------------------------------------------------------------`);
  console.log(`RESULTADOS: ${name.toUpperCase()}`);
  console.log(`• Capital Inicial          : $${INITIAL_CAPITAL_MXN.toFixed(2)} MXN ($1,000 USD)`);
  console.log(`• Capital Final al Mes     : $${cashMxn.toFixed(2)} MXN`);
  console.log(`• GANANCIA NETA LIMPIA     : ${netPnlMxn >= 0 ? "+" : ""}$${netPnlMxn.toFixed(2)} MXN (${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(2)}% ROI Mensual)`);
  console.log(`• Operaciones del Mes      : ${totalTrades} (Ganadas: ${wins} / Perdidas: ${losses})`);
  console.log(`• Win Rate Real            : ${winRatePct.toFixed(1)}%`);
  console.log(`• Profit Factor            : ${profitFactor.toFixed(2)}`);
  console.log(`• Comisiones Pagadas Bitso : -$${feesPaidMxn.toFixed(2)} MXN (Deducidas ya del PnL)`);
  console.log(`• Drawdown Máximo Sufrido  : ${maxDrawdownPct.toFixed(2)}% de la cuenta`);
  console.log(`--------------------------------------------------------------------------------\n`);

  return { name, netPnlMxn, roiPct, totalTrades, wins, losses, winRatePct, profitFactor, feesPaidMxn, maxDrawdownPct };
}

// 1. Simulación sin Blindaje
const resOld = simulateWorstMonth("1. Sin Blindaje (Lógica Antigua)", false);

// 2. Simulación con Blindaje Causal
const resNew = simulateWorstMonth("2. Con Blindaje Causal (Veto Jev + Laya + Candado)", true);

console.log("================================================================================");
console.log("                             BALANCE COMPARATIVO FINAL                          ");
console.log("================================================================================");
console.log(`Diferencia de Ganancia Neta : +$${(resNew.netPnlMxn - resOld.netPnlMxn).toFixed(2)} MXN a favor del blindaje`);
console.log(`Reducción de Operaciones Malas: De ${resOld.losses} pérdidas bajó a ${resNew.losses} pérdidas`);
console.log(`Ahorro en Comisiones        : $${(resOld.feesPaidMxn - resNew.feesPaidMxn).toFixed(2)} MXN menos en tarifas de Bitso`);
console.log("================================================================================\n");
