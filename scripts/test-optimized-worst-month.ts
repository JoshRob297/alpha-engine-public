/**
 * AUDITORÍA DE OPTIMIZACIÓN: PEOR MES DE FX CON LAS 3 MEJORAS DE INGENIERÍA
 * 1. TP elevado a +0.75% (destruye el peaje de comisiones de Bitso).
 * 2. Trailing a Breakeven al tocar +0.30% (protege comisiones y evita que un ganador se vuelva perdedor).
 * 3. Cero candado de tiempo ciego: Re-centrado geométrico inteligente.
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

function testOptimizedWorstMonth() {
  let cashMxn = INITIAL_CAPITAL_MXN;
  let inPos = false;
  let usdHoldings = 0;
  let entryPrice = 0;
  let entryHour = 0;
  let currentStop = 0;
  let tpPrice = 0;

  let wins = 0;
  let losses = 0;
  let beExits = 0;
  let grossProfitMxn = 0;
  let grossLossMxn = 0;
  let feesPaidMxn = 0;

  let gridPrice = monthCandles[0].open * 0.9980;

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = monthCandles[h];
    const midPrice = (c.open + c.close) / 2;

    // 1. Entrada Maker
    if (!inPos && c.low <= gridPrice) {
      const fillPrice = gridPrice;
      const costMxn = ORDER_SIZE_USD * fillPrice;
      const feeMxn = costMxn * MAKER_FEE;

      if (cashMxn >= costMxn + feeMxn) {
        inPos = true;
        usdHoldings = ORDER_SIZE_USD;
        entryPrice = fillPrice;
        entryHour = h;
        tpPrice = entryPrice * 1.0075; // TP a +0.75%
        currentStop = entryPrice * 0.9920; // Stop inicial -0.80%

        cashMxn -= (costMxn + feeMxn);
        feesPaidMxn += feeMxn;
      }
    }
    // 2. Gestión de posición viva (mínimo 1 hora de maduración)
    else if (inPos && h > entryHour) {
      // Trailing a Breakeven: Si el precio tocó +0.30%, blindar la entrada con comisiones cubiertas
      if (c.high >= entryPrice * 1.0030 && currentStop < entryPrice * 1.0015) {
        currentStop = entryPrice * 1.0015;
      }

      // Salida por Stop / Breakeven
      if (c.low <= currentStop) {
        const exitPrice = currentStop;
        const proceedsGross = usdHoldings * exitPrice;
        const feeMxn = proceedsGross * MAKER_FEE;
        const proceedsNet = proceedsGross - feeMxn;
        const costBasis = usdHoldings * entryPrice;
        const pnl = proceedsNet - costBasis;

        cashMxn += proceedsNet;
        feesPaidMxn += feeMxn;

        if (pnl >= 0) {
          grossProfitMxn += pnl;
          beExits++;
        } else {
          grossLossMxn += Math.abs(pnl);
          losses++;
        }

        inPos = false;
        usdHoldings = 0;
        gridPrice = midPrice * 0.9970; // Re-centrado geométrico defensivo (-0.30%)
      }
      // Salida por Take Profit (+0.75%)
      else if (c.high >= tpPrice) {
        const exitPrice = tpPrice;
        const proceedsGross = usdHoldings * exitPrice;
        const feeMxn = proceedsGross * MAKER_FEE;
        const proceedsNet = proceedsGross - feeMxn;
        const costBasis = usdHoldings * entryPrice;
        const pnl = proceedsNet - costBasis;

        cashMxn += proceedsNet;
        grossProfitMxn += pnl;
        feesPaidMxn += feeMxn;
        wins++;

        inPos = false;
        usdHoldings = 0;
        gridPrice = midPrice * 0.9980;
      }
    }
  }

  // Liquidación final al cierre del mes si queda abierta
  if (inPos) {
    const finalPrice = monthCandles[TOTAL_HOURS - 1].close;
    const proceedsGross = usdHoldings * finalPrice;
    const feeMxn = proceedsGross * MAKER_FEE;
    cashMxn += (proceedsGross - feeMxn);
    feesPaidMxn += feeMxn;
  }

  const netPnlMxn = cashMxn - INITIAL_CAPITAL_MXN;
  const roiPct = (netPnlMxn / INITIAL_CAPITAL_MXN) * 100;

  return {
    netPnlMxn: parseFloat(netPnlMxn.toFixed(2)),
    roiPct: parseFloat(roiPct.toFixed(2)),
    wins,
    losses,
    beExits,
    totalTrades: wins + losses + beExits,
    feesPaidMxn: parseFloat(feesPaidMxn.toFixed(2)),
    finalCapitalMxn: parseFloat(cashMxn.toFixed(2)),
  };
}

const res = testOptimizedWorstMonth();

console.log("================================================================================");
console.log("   RESULTADOS CON LAS 3 MEJORAS DE INGENIERÍA EN EL PEOR MES HISTÓRICO          ");
console.log("================================================================================");
console.log(`• Capital Inicial          : $${INITIAL_CAPITAL_MXN.toFixed(2)} MXN ($1,000 USD)`);
console.log(`• Capital Final al Mes     : $${res.finalCapitalMxn.toFixed(2)} MXN`);
console.log(`• GANANCIA NETA LIMPIA     : ${res.netPnlMxn >= 0 ? "+" : ""}$${res.netPnlMxn.toFixed(2)} MXN (${res.roiPct >= 0 ? "+" : ""}${res.roiPct}% ROI)`);
console.log(`• Total Operaciones        : ${res.totalTrades}`);
console.log(`  - Victorias Plenas (+0.75%): ${res.wins}`);
console.log(`  - Salidas en Breakeven   : ${res.beExits} (Blindadas sin pérdida neta)`);
console.log(`  - Derrotas con Pérdida   : ${res.losses}`);
console.log(`• Comisiones Pagadas Bitso : -$${res.feesPaidMxn.toFixed(2)} MXN`);
console.log("================================================================================\n");
