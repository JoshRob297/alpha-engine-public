/**
 * SIMULACIÓN WALK-FORWARD GENÉTICA (720 HORAS DE SOLANA - SEPTIEMBRE 2026)
 * Comparación Frente a Frente en el Mismo Mes de Referencia (Rally de $74 a $121 USD):
 * 
 * 1. Modelo Estático Anterior:
 *    - Un solo genoma fijo durante todo el mes (PnL: +$94.89 USD).
 * 
 * 2. Modelo Walk-Forward Evolved (SETS Re-Evolucionando en Vivo cada 24 Horas):
 *    - Cada 24 horas, pausa y re-evoluciona sobre las últimas 120 horas pasadas (Cero Lookahead).
 *    - Adapta los multiplicadores de ATR (Spacing, TP, Stop, Descuento) dinámicamente.
 * 
 * Capital: $1,000 USD | Fricciones Reales: -0.10% Maker compra, -0.10% Maker venta, slippage.
 */

import { readFileSync, writeFileSync } from "node:fs";

const SOL_FILE = "/mnt/storage/alpha-backtest/raw/sol_1h.json";
const solAll = JSON.parse(readFileSync(SOL_FILE, "utf-8"));

const TOTAL_HOURS = 720;
// Tomamos exactamente el mismo mes de referencia de Septiembre 2026 (las últimas 720 horas)
const testCandles = solAll.slice(solAll.length - TOTAL_HOURS);

const CAPITAL = 1000.0;
const ORDER_USD = 250.0;
const MAKER_FEE = 0.0010;

interface MicroGenome {
  k_spacing: number;
  k_tp: number;
  k_stop: number;
  k_discount: number;
  fitness: number;
}

function calculateATR14(candles: any[], idx: number): number {
  if (idx < 14) return 0.015;
  let trSum = 0;
  for (let i = idx - 13; i <= idx; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    trSum += tr;
  }
  return (trSum / 14) / candles[idx].close;
}

// Micro-Evolucionador SETS sobre la ventana pasada (Cero Lookahead)
function evolveQuickGenome(pastCandles: any[]): MicroGenome {
  let population: MicroGenome[] = [];
  for (let i = 0; i < 25; i++) {
    population.push({
      k_spacing: parseFloat((0.6 + Math.random() * 0.8).toFixed(2)),
      k_tp: parseFloat((1.8 + Math.random() * 1.8).toFixed(2)),
      k_stop: parseFloat((2.8 + Math.random() * 1.6).toFixed(2)),
      k_discount: parseFloat((1.5 + Math.random() * 1.5).toFixed(2)),
      fitness: 0,
    });
  }

  for (let gen = 1; gen <= 12; gen++) {
    population.forEach((g) => {
      let simCash = 1000.0;
      let inPos = false;
      let holdings = 0;
      let entryPrice = 0;
      let entryH = 0;
      let wins = 0;
      let losses = 0;
      let grossProfit = 0;
      let grossLoss = 0;
      let gridP = pastCandles[0].open * 0.98;

      for (let h = 15; h < pastCandles.length; h++) {
        const c = pastCandles[h];
        const mid = (c.open + c.close) / 2;
        const atr = calculateATR14(pastCandles, h);
        const sp = Math.max(0.012, atr * g.k_spacing);
        const tp = Math.max(0.015, atr * g.k_tp);
        const st = Math.max(0.025, atr * g.k_stop);

        if (!inPos && c.low <= gridP) {
          inPos = true;
          holdings = 250 / gridP;
          entryPrice = gridP;
          entryH = h;
          simCash -= 250 * 1.001;
        } else if (inPos && h > entryH) {
          if (c.low <= entryPrice * (1 - st)) {
            simCash += holdings * entryPrice * (1 - st) * 0.999;
            grossLoss += holdings * entryPrice * st;
            losses++;
            inPos = false;
            gridP = mid * (1 - sp);
          } else if (c.high >= entryPrice * (1 + tp)) {
            simCash += holdings * entryPrice * (1 + tp) * 0.999;
            grossProfit += holdings * entryPrice * tp;
            wins++;
            inPos = false;
            gridP = mid * (1 - sp);
          }
        }
      }
      const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 3.0 : 0.5);
      const wr = (wins + losses) > 0 ? wins / (wins + losses) : 0;
      g.fitness = (pf * 0.6 + wr * 0.4) * Math.log10(Math.max(2, wins + losses));
    });

    population.sort((a, b) => b.fitness - a.fitness);
    const elite = population.slice(0, 6);
    const nextGen = [...elite];
    while (nextGen.length < 25) {
      const p = elite[Math.floor(Math.random() * elite.length)];
      nextGen.push({
        k_spacing: parseFloat(Math.max(0.5, Math.min(1.6, p.k_spacing + (Math.random() - 0.5) * 0.2)).toFixed(2)),
        k_tp: parseFloat(Math.max(1.6, Math.min(3.8, p.k_tp + (Math.random() - 0.5) * 0.3)).toFixed(2)),
        k_stop: parseFloat(Math.max(2.5, Math.min(4.8, p.k_stop + (Math.random() - 0.5) * 0.3)).toFixed(2)),
        k_discount: parseFloat(Math.max(1.2, Math.min(3.2, p.k_discount + (Math.random() - 0.5) * 0.3)).toFixed(2)),
        fitness: 0,
      });
    }
    population = nextGen;
  }

  population.sort((a, b) => b.fitness - a.fitness);
  return population[0];
}

console.log("================================================================================");
console.log("   SIMULACIÓN WALK-FORWARD GENÉTICA EN VIVO: SOLANA (720 HORAS CONTINUAS)       ");
console.log("   Re-Evolución Autónoma de SETS cada 24 Horas sobre las 120 Horas Previas      ");
console.log("================================================================================\n");

function runWalkForwardSimulation() {
  let cash = CAPITAL;
  let inPos = false;
  let holdings = 0;
  let entryPrice = 0;
  let entryH = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let feesPaid = 0;
  let biggestWin = 0;

  let isTrailing = false;
  let highest = 0;
  let trailStop = 0;
  let isLocked = false;
  let lockH = -1;

  // Genoma inicial por defecto
  let currentGenome: MicroGenome = {
    k_spacing: 0.85,
    k_tp: 3.20,
    k_stop: 4.50,
    k_discount: 3.20,
    fitness: 1.0,
  };

  let gridPrice = testCandles[0].open * (1 - 0.024);
  let genomeMutations = 0;

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = testCandles[h];
    const mid = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.0001);
    const toxic = c.close < c.open && c.volume > 50000 ? 0.75 : 0.20;
    const atr = calculateATR14(testCandles, h);

    // RE-EVOLUCIÓN EN VIVO CADA 24 HORAS (CERO LOOKAHEAD)
    if (h > 0 && h % 24 === 0 && h >= 120) {
      const pastWindow = testCandles.slice(h - 120, h);
      const evolved = evolveQuickGenome(pastWindow);
      if (evolved.fitness > currentGenome.fitness * 0.95) {
        currentGenome = evolved;
        genomeMutations++;
        // Log cada 120h para ver la mutación de los genes
        if (h % 120 === 0) {
          console.log(`[DÍA ${h / 24}] SETS mutó genoma: Spacing=${currentGenome.k_spacing}x | TP=${currentGenome.k_tp}x | Stop=${currentGenome.k_stop}x (Fit: ${currentGenome.fitness.toFixed(2)})`);
        }
      }
    }

    const spacing = Math.max(0.015, atr * currentGenome.k_spacing);
    const tpPct = Math.max(0.018, atr * currentGenome.k_tp);
    const stopPct = Math.max(0.030, atr * currentGenome.k_stop);
    const trailDist = Math.max(0.025, atr * 2.2);

    if (isLocked) {
      if (h - lockH >= 6 && ofi > 0.20 && toxic < 0.35) {
        isLocked = false;
        gridPrice = mid * (1 - spacing * 1.25);
      }
    }

    // Trailing Grid al Alza
    if (!inPos && mid > gridPrice * 1.04 && ofi > 0.15) {
      gridPrice = mid * (1 - spacing);
    }

    // 1. Entrada Maker
    if (!inPos && !isLocked && c.low <= gridPrice) {
      inPos = true;
      holdings = ORDER_USD / gridPrice;
      entryPrice = gridPrice;
      entryH = h;
      highest = c.high;
      isTrailing = false;

      const fee = ORDER_USD * MAKER_FEE;
      cash -= (ORDER_USD + fee);
      feesPaid += fee;
    }
    // 2. Posición Viva con Trailing Take Profit gobernado por genoma dinámico
    else if (inPos && h > entryH) {
      if (c.high > highest) highest = c.high;

      const initialTp = entryPrice * (1 + tpPct);
      if (!isTrailing && c.high >= initialTp) {
        isTrailing = true;
        trailStop = highest * (1 - trailDist);
      }

      if (isTrailing) {
        const cand = highest * (1 - trailDist);
        if (cand > trailStop) trailStop = cand;
      }

      const effStop = isTrailing ? trailStop : entryPrice * (1 - stopPct);

      if (c.low <= effStop) {
        const exitP = Math.min(effStop, mid * 0.9975);
        const gross = holdings * exitP;
        const fee = gross * MAKER_FEE;
        const net = gross - fee;
        const delta = net - holdings * entryPrice;

        cash += net;
        feesPaid += fee;

        if (delta >= 0) {
          grossProfit += delta;
          wins++;
          if (delta > biggestWin) biggestWin = delta;
        } else {
          grossLoss += Math.abs(delta);
          losses++;
          isLocked = true;
          lockH = h;
        }

        inPos = false;
        holdings = 0;
        isTrailing = false;
        gridPrice = mid * (1 - spacing);
      }
    }
  }

  if (inPos) {
    const p = testCandles[TOTAL_HOURS - 1].close;
    cash += (holdings * p * (1 - MAKER_FEE));
    feesPaid += (holdings * p * MAKER_FEE);
  }

  const netPnl = cash - CAPITAL;
  const total = wins + losses;
  return {
    netPnl: parseFloat(netPnl.toFixed(2)),
    roiPct: parseFloat(((netPnl / CAPITAL) * 100).toFixed(2)),
    trades: total,
    wins,
    losses,
    winRate: total > 0 ? parseFloat(((wins / total) * 100).toFixed(1)) : 0,
    biggestWin: parseFloat(biggestWin.toFixed(2)),
    feesPaid: parseFloat(feesPaid.toFixed(2)),
    mutations: genomeMutations,
  };
}

const wfResult = runWalkForwardSimulation();

console.log("\n================================================================================");
console.log("   RESULTADOS COMPARATIVOS: GENOMA ESTÁTICO VS WALK-FORWARD GENÉTICO EN VIVO   ");
console.log("================================================================================");
console.log(`• Modelo Estático Previo (Sin re-evolución) : PnL +$94.89 USD (+9.49% ROI) | Trades: 15 (WR: 66.7%) | Max Win: +$22.29 USD`);
console.log(`• Modelo Walk-Forward Evolved (SETS en vivo) : PnL +$${wfResult.netPnl} USD (+${wfResult.roiPct}% ROI) | Trades: ${wfResult.trades} (WR: ${wfResult.winRate}%) | Max Win: +$${wfResult.biggestWin} USD`);
console.log("--------------------------------------------------------------------------------");
const diff = wfResult.netPnl - 94.89;
console.log(`• DIFERENCIA DE MEJORA NETA                : ${diff >= 0 ? "+" : ""}$${diff.toFixed(2)} USD NETOS EXTRA`);
console.log(`• Total Mutaciones Genéticas Adaptadas      : ${wfResult.mutations} actualizaciones de genes en 30 días`);
console.log(`• Mayor Operación Individual Cosechada      : +$${wfResult.biggestWin} USD (vs +$22.29 USD anterior)`);
console.log("================================================================================\n");

writeFileSync(
  "/mnt/storage/alpha-backtest/walk_forward_sets_comparison.json",
  JSON.stringify({ staticPnl: 94.89, wfResult, date: new Date().toISOString() }, null, 2)
);
