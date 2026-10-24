/**
 * WALK-FORWARD CON MEMORIA MACRO (VENTANA DE 350 HORAS / 15 DÍAS MÍNIMOS)
 * Para evitar la trampa de muestra pequeña (micro-overfitting de 5 días).
 */

import { readFileSync, writeFileSync } from "node:fs";

const SOL_FILE = "/mnt/storage/alpha-backtest/raw/sol_1h.json";
const solAll = JSON.parse(readFileSync(SOL_FILE, "utf-8"));
const TOTAL_HOURS = 720;
const testCandles = solAll.slice(solAll.length - TOTAL_HOURS);
// Velas previas al mes para que la ventana inicial de 350h esté completa desde la hora 0
const fullSeries = solAll.slice(solAll.length - (TOTAL_HOURS + 350));

const CAPITAL = 1000.0;
const ORDER_USD = 250.0;
const MAKER_FEE = 0.0010;

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

interface MicroGenome {
  k_spacing: number;
  k_tp: number;
  k_stop: number;
  k_discount: number;
  fitness: number;
  trades: number;
}

// Búsqueda sobre ventana macro de 350 horas (15 días de historia continua)
function evolveMacroWindowGenome(windowCandles: any[]): MicroGenome {
  let population: MicroGenome[] = [];
  for (let i = 0; i < 30; i++) {
    population.push({
      k_spacing: parseFloat((0.6 + Math.random() * 0.6).toFixed(2)),
      k_tp: parseFloat((2.5 + Math.random() * 1.5).toFixed(2)), // TP amplio
      k_stop: parseFloat((3.5 + Math.random() * 1.2).toFixed(2)), // Stop holgado para resistir ruido
      k_discount: parseFloat((2.0 + Math.random() * 1.5).toFixed(2)),
      fitness: 0,
      trades: 0,
    });
  }

  for (let gen = 1; gen <= 15; gen++) {
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
      let gridP = windowCandles[0].open * 0.98;

      for (let h = 15; h < windowCandles.length; h++) {
        const c = windowCandles[h];
        const mid = (c.open + c.close) / 2;
        const atr = calculateATR14(windowCandles, h);
        const sp = Math.max(0.015, atr * g.k_spacing);
        const tp = Math.max(0.020, atr * g.k_tp);
        const st = Math.max(0.035, atr * g.k_stop);

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
      g.trades = wins + losses;
      // Penalizar si no hay al menos 6 trades en los 15 días
      g.fitness = (pf * 0.5 + wr * 0.3) * Math.log10(Math.max(2, g.trades)) * (g.trades >= 5 ? 1.2 : 0.4);
    });

    population.sort((a, b) => b.fitness - a.fitness);
    const elite = population.slice(0, 8);
    const nextGen = [...elite];
    while (nextGen.length < 30) {
      const p = elite[Math.floor(Math.random() * elite.length)];
      nextGen.push({
        k_spacing: parseFloat(Math.max(0.5, Math.min(1.4, p.k_spacing + (Math.random() - 0.5) * 0.15)).toFixed(2)),
        k_tp: parseFloat(Math.max(2.2, Math.min(4.2, p.k_tp + (Math.random() - 0.5) * 0.25)).toFixed(2)),
        k_stop: parseFloat(Math.max(3.2, Math.min(4.8, p.k_stop + (Math.random() - 0.5) * 0.25)).toFixed(2)),
        k_discount: parseFloat(Math.max(1.8, Math.min(3.5, p.k_discount + (Math.random() - 0.5) * 0.25)).toFixed(2)),
        fitness: 0,
        trades: 0,
      });
    }
    population = nextGen;
  }

  population.sort((a, b) => b.fitness - a.fitness);
  return population[0];
}

console.log("================================================================================");
console.log("   WALK-FORWARD CON VENTANA MACRO DE 350 HORAS (15 DÍAS) - SOLANA 720 HORAS     ");
console.log("================================================================================\n");

function runMacroWalkForward() {
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

  // Genoma Élite comprobado de partida
  let currentGenome: MicroGenome = {
    k_spacing: 0.85,
    k_tp: 3.20,
    k_stop: 4.50,
    k_discount: 3.20,
    fitness: 1.5,
    trades: 15,
  };

  let gridPrice = testCandles[0].open * (1 - 0.024);
  let adaptations = 0;

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = testCandles[h];
    const mid = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.0001);
    const atr = calculateATR14(testCandles, h);

    // Re-evaluación cada 72 horas (3 días) sobre ventana macro de 350 horas
    if (h > 0 && h % 72 === 0) {
      const globalIdx = 350 + h;
      const macroWindow = fullSeries.slice(globalIdx - 350, globalIdx);
      const evolved = evolveMacroWindowGenome(macroWindow);
      // Solo adoptar si el genoma demuestra superioridad estadística real (trades >= 5 y fitness alto)
      if (evolved.fitness > currentGenome.fitness && evolved.trades >= 5) {
        currentGenome = evolved;
        adaptations++;
        console.log(`[DÍA ${h / 24}] SETS adoptó genoma macro: Spacing=${currentGenome.k_spacing}x | TP=${currentGenome.k_tp}x | Stop=${currentGenome.k_stop}x (Trades: ${currentGenome.trades}, Fit: ${currentGenome.fitness.toFixed(2)})`);
      }
    }

    const spacing = Math.max(0.018, atr * currentGenome.k_spacing);
    const tpPct = Math.max(0.020, atr * currentGenome.k_tp);
    const stopPct = Math.max(0.038, atr * currentGenome.k_stop);
    const trailDist = Math.max(0.030, atr * 2.5);

    if (!inPos && mid > gridPrice * 1.04 && ofi > 0.15) {
      gridPrice = mid * (1 - spacing);
    }

    if (!inPos && c.low <= gridPrice) {
      inPos = true;
      holdings = ORDER_USD / gridPrice;
      entryPrice = gridPrice;
      entryH = h;
      highest = c.high;
      isTrailing = false;
      const fee = ORDER_USD * MAKER_FEE;
      cash -= (ORDER_USD + fee);
      feesPaid += fee;
    } else if (inPos && h > entryH) {
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
    adaptations,
  };
}

const macroResult = runMacroWalkForward();

console.log("\n================================================================================");
console.log("   RESULTADOS FINALES: WALK-FORWARD MACRO (350h) VS MODELO BASE ESTÁTICO       ");
console.log("================================================================================");
console.log(`• Modelo Estático Previo (Sin re-evolución) : PnL +$94.89 USD (+9.49% ROI) | Trades: 15 (WR: 66.7%) | Max Win: +$22.29 USD`);
console.log(`• Walk-Forward con Memoria Macro (350h)     : PnL +$${macroResult.netPnl} USD (+${macroResult.roiPct}% ROI) | Trades: ${macroResult.trades} (WR: ${macroResult.winRate}%) | Max Win: +$${macroResult.biggestWin} USD`);
console.log("--------------------------------------------------------------------------------");
const delta = macroResult.netPnl - 94.89;
console.log(`• IMPACTO NETO DE LA MEMORIA MACRO         : ${delta >= 0 ? "+" : ""}$${delta.toFixed(2)} USD NETOS`);
console.log(`• Adaptaciones de Genoma Exitosas           : ${macroResult.adaptations} veces en el mes`);
console.log("================================================================================");
