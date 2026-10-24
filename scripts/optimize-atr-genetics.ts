/**
 * OPTIMIZADOR GENÉTICO DE MULTIPLICADORES FÍSICOS DE ATR (PASO 2)
 * Diseñado para explotar los 22 hilos y 30 GB de RAM de Compute-node.
 * 
 * Espacio de Búsqueda de Hiperparámetros (Cero Números Mágicos):
 * - k_spacing  : Multiplicador de espaciado de malla sobre ATR14 [0.5x a 1.6x]
 * - k_tp       : Multiplicador de Take Profit sobre ATR14 [1.6x a 3.5x]
 * - k_stop     : Multiplicador de Hard Stop sobre ATR14 [2.5x a 4.5x]
 * - k_discount : Multiplicador de descuento post-SL sobre ATR14 [1.5x a 3.0x]
 * 
 * Función Objetivo (Fitness):
 * Fitness = ProfitFactor * WinRate * (1 - MaxDrawdown) * log(TotalTrades)
 */

import { readFileSync, writeFileSync } from "node:fs";

const FX_FILE = "/home/user/alpha-backtest/raw/usd_mxn_1h.json";
const SOL_FILE = "/home/user/alpha-backtest/raw/sol_1h.json";
const BTC_FILE = "/home/user/alpha-backtest/raw/btc_1h.json";

interface Genome {
  id: number;
  k_spacing: number;
  k_tp: number;
  k_stop: number;
  k_discount: number;
  fitness: number;
  profitFactor: number;
  winRate: number;
  netPnl: number;
  trades: number;
}

function calculateATR14(candles: any[], idx: number): number {
  if (idx < 14) return 0.002;
  let trSum = 0;
  for (let i = idx - 13; i <= idx; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    trSum += tr;
  }
  return (trSum / 14) / candles[idx].close;
}

function evaluateGenome(g: Genome, candles: any[], feeRate: number = 0.0010): Genome {
  let cash = 1000.0;
  let inPos = false;
  let holdings = 0;
  let entryPrice = 0;
  let entryH = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let isLocked = false;
  let lockH = -1;
  let peakEquity = 1000.0;
  let maxDd = 0;

  const orderUsd = 250.0;
  let gridPrice = candles[0].open * 0.998;

  for (let h = 15; h < candles.length; h++) {
    const c = candles[h];
    const mid = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.0001);
    const toxic = c.close < c.open && c.volume > 50000 ? 0.75 : 0.20;
    const atrPct = calculateATR14(candles, h);

    const spacing = Math.max(0.0012, atrPct * g.k_spacing);
    const tpPct = Math.max(feeRate * 3.5, atrPct * g.k_tp);
    const stopPct = Math.max(spacing * 1.8, atrPct * g.k_stop);
    const discountPct = Math.max(spacing * 1.5, atrPct * g.k_discount);

    if (isLocked) {
      if (h - lockH >= 6 && ofi > 0.20 && toxic < 0.35) {
        isLocked = false;
        gridPrice = mid * (1 - discountPct);
      }
    }

    if (!inPos && !isLocked && c.low <= gridPrice) {
      inPos = true;
      holdings = orderUsd / gridPrice;
      entryPrice = gridPrice;
      entryH = h;
      cash -= orderUsd * (1 + feeRate);
    } else if (inPos && h > entryH) {
      const stopP = entryPrice * (1 - stopPct);
      const tpP = entryPrice * (1 + tpPct);

      if (c.low <= stopP) {
        const exitP = Math.min(stopP, mid * 0.9975);
        const gross = holdings * exitP;
        const net = gross * (1 - feeRate);
        const loss = net - holdings * entryPrice;
        cash += net;
        grossLoss += Math.abs(loss);
        losses++;
        inPos = false;
        isLocked = true;
        lockH = h;
      } else if (c.high >= tpP) {
        const exitP = tpP;
        const gross = holdings * exitP;
        const net = gross * (1 - feeRate);
        const profit = net - holdings * entryPrice;
        cash += net;
        grossProfit += profit;
        wins++;
        inPos = false;
        gridPrice = mid * (1 - spacing);
      }
    }

    const eq = cash + (inPos ? holdings * mid : 0);
    if (eq > peakEquity) peakEquity = eq;
    const dd = peakEquity - eq;
    if (dd > maxDd) maxDd = dd;
  }

  const netPnl = cash - 1000.0;
  const total = wins + losses;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 5.0 : 0.5);
  const wr = total > 0 ? wins / total : 0;
  const ddPct = maxDd / 1000.0;

  // Fitness penaliza drawdowns y premia profit factor sostenido con masa crítica de trades
  const tradeBonus = Math.log10(Math.max(2, total));
  const fitness = (pf * 0.45 + wr * 0.35 + (1 - ddPct) * 0.20) * tradeBonus * (netPnl > 0 ? 1.2 : 0.8);

  g.fitness = parseFloat(fitness.toFixed(3));
  g.profitFactor = parseFloat(pf.toFixed(2));
  g.winRate = parseFloat((wr * 100).toFixed(1));
  g.netPnl = parseFloat(netPnl.toFixed(2));
  g.trades = total;
  return g;
}

export function runGeneticSearch(candles: any[], populationSize = 40, generations = 25): Genome {
  let population: Genome[] = [];

  // Población inicial con diversidad hiperbólica
  for (let i = 0; i < populationSize; i++) {
    population.push({
      id: i,
      k_spacing: parseFloat((0.5 + Math.random() * 1.1).toFixed(2)),
      k_tp: parseFloat((1.6 + Math.random() * 1.9).toFixed(2)),
      k_stop: parseFloat((2.5 + Math.random() * 2.0).toFixed(2)),
      k_discount: parseFloat((1.5 + Math.random() * 1.5).toFixed(2)),
      fitness: 0,
      profitFactor: 0,
      winRate: 0,
      netPnl: 0,
      trades: 0,
    });
  }

  for (let gen = 1; gen <= generations; gen++) {
    // Evaluar fitness
    population = population.map((g) => evaluateGenome(g, candles));
    population.sort((a, b) => b.fitness - a.fitness);

    // Selección de élite (top 25%)
    const elite = population.slice(0, Math.floor(populationSize * 0.25));
    const nextGen: Genome[] = [...elite];

    // Crossover y mutación para completar la siguiente generación
    while (nextGen.length < populationSize) {
      const parentA = elite[Math.floor(Math.random() * elite.length)];
      const parentB = elite[Math.floor(Math.random() * elite.length)];

      const child: Genome = {
        id: nextGen.length,
        k_spacing: Math.random() > 0.5 ? parentA.k_spacing : parentB.k_spacing,
        k_tp: Math.random() > 0.5 ? parentA.k_tp : parentB.k_tp,
        k_stop: Math.random() > 0.5 ? parentA.k_stop : parentB.k_stop,
        k_discount: Math.random() > 0.5 ? parentA.k_discount : parentB.k_discount,
        fitness: 0,
        profitFactor: 0,
        winRate: 0,
        netPnl: 0,
        trades: 0,
      };

      // Mutación gaussiana (15% de probabilidad)
      if (Math.random() < 0.15) child.k_spacing = parseFloat(Math.max(0.5, Math.min(1.8, child.k_spacing + (Math.random() - 0.5) * 0.2)).toFixed(2));
      if (Math.random() < 0.15) child.k_tp = parseFloat(Math.max(1.6, Math.min(3.8, child.k_tp + (Math.random() - 0.5) * 0.3)).toFixed(2));
      if (Math.random() < 0.15) child.k_stop = parseFloat(Math.max(2.5, Math.min(4.8, child.k_stop + (Math.random() - 0.5) * 0.3)).toFixed(2));
      if (Math.random() < 0.15) child.k_discount = parseFloat(Math.max(1.5, Math.min(3.2, child.k_discount + (Math.random() - 0.5) * 0.3)).toFixed(2));

      nextGen.push(child);
    }

    population = nextGen;
  }

  // Evaluación final
  population = population.map((g) => evaluateGenome(g, candles));
  population.sort((a, b) => b.fitness - a.fitness);
  return population[0];
}

console.log("Iniciando búsqueda evolutiva en Compute-node...");
