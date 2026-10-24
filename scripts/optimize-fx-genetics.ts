/**
 * BÚSQUEDA GENÉTICA ESPECIALIZADA PARA FX (BITSO usd_mxn)
 * Adaptada a la microestructura de micro-spread cambiario ($17.00 - $18.50 MXN).
 */

import { readFileSync, writeFileSync } from "node:fs";

const FX_FILE = "/home/user/alpha-backtest/raw/usd_mxn_1h.json";
const fxAll = JSON.parse(readFileSync(FX_FILE, "utf-8"));
const FX_RATE = 17.72;

function calculateATR14(candles: any[], idx: number): number {
  if (idx < 14) return 0.0015;
  let trSum = 0;
  for (let i = idx - 13; i <= idx; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    trSum += tr;
  }
  return (trSum / 14) / candles[idx].close;
}

interface FxGenome {
  k_spacing: number;
  k_tp: number;
  k_stop: number;
  k_discount: number;
  pnlMxn: number;
  winRate: number;
  profitFactor: number;
  trades: number;
  fitness: number;
}

function evaluateFx(g: FxGenome): FxGenome {
  const INITIAL_MXN = 17720.0;
  let cash = INITIAL_MXN;
  let inPos = false;
  let usdHoldings = 0;
  let entryPrice = 0;
  let entryH = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let isLocked = false;
  let lockH = -1;
  const orderUsd = 250.0;
  const feeRate = 0.0010;

  let gridPrice = fxAll[0].open * 0.9985;

  for (let h = 15; h < fxAll.length; h++) {
    const c = fxAll[h];
    const mid = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.001);
    const toxic = c.close < c.open && c.volume > 150000 ? 0.75 : 0.20;
    const atrPct = calculateATR14(fxAll, h);

    const spacing = Math.max(0.0010, atrPct * g.k_spacing);
    const tpPct = Math.max(0.0035, atrPct * g.k_tp);
    const stopPct = Math.max(spacing * 1.5, atrPct * g.k_stop);
    const discountPct = Math.max(spacing * 1.2, atrPct * g.k_discount);

    if (isLocked) {
      if (h - lockH >= 4 && ofi > 0.15 && toxic < 0.35) {
        isLocked = false;
        gridPrice = mid * (1 - discountPct);
      }
    }

    if (!inPos && !isLocked && c.low <= gridPrice) {
      inPos = true;
      usdHoldings = orderUsd;
      entryPrice = gridPrice;
      entryH = h;
      cash -= orderUsd * entryPrice * (1 + feeRate);
    } else if (inPos && h > entryH) {
      const stopP = entryPrice * (1 - stopPct);
      const tpP = entryPrice * (1 + tpPct);

      if (c.low <= stopP) {
        const exitP = Math.min(stopP, mid * 0.998);
        const gross = usdHoldings * exitP;
        const net = gross * (1 - feeRate);
        const loss = net - usdHoldings * entryPrice;
        cash += net;
        grossLoss += Math.abs(loss);
        losses++;
        inPos = false;
        usdHoldings = 0;
        isLocked = true;
        lockH = h;
      } else if (c.high >= tpP) {
        const exitP = tpP;
        const gross = usdHoldings * exitP;
        const net = gross * (1 - feeRate);
        const profit = net - usdHoldings * entryPrice;
        cash += net;
        grossProfit += profit;
        wins++;
        inPos = false;
        usdHoldings = 0;
        gridPrice = mid * (1 - spacing);
      }
    }
  }

  const netPnl = cash - INITIAL_MXN;
  const total = wins + losses;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 3.0 : 0.5);
  const wr = total > 0 ? wins / total : 0;
  const fitness = (pf * 0.5 + wr * 0.3) * Math.log10(Math.max(2, total)) * (netPnl > 0 ? 1.2 : 0.8);

  g.pnlMxn = parseFloat(netPnl.toFixed(2));
  g.winRate = parseFloat((wr * 100).toFixed(1));
  g.profitFactor = parseFloat(pf.toFixed(2));
  g.trades = total;
  g.fitness = parseFloat(fitness.toFixed(3));
  return g;
}

let population: FxGenome[] = [];
for (let i = 0; i < 50; i++) {
  population.push({
    k_spacing: parseFloat((0.4 + Math.random() * 0.8).toFixed(2)),
    k_tp: parseFloat((1.5 + Math.random() * 1.5).toFixed(2)),
    k_stop: parseFloat((2.0 + Math.random() * 2.0).toFixed(2)),
    k_discount: parseFloat((1.0 + Math.random() * 1.5).toFixed(2)),
    pnlMxn: 0,
    winRate: 0,
    profitFactor: 0,
    trades: 0,
    fitness: 0,
  });
}

for (let gen = 1; gen <= 30; gen++) {
  population = population.map(evaluateFx);
  population.sort((a, b) => b.fitness - a.fitness);

  const elite = population.slice(0, 12);
  const nextGen = [...elite];

  while (nextGen.length < 50) {
    const pA = elite[Math.floor(Math.random() * elite.length)];
    const pB = elite[Math.floor(Math.random() * elite.length)];
    const child: FxGenome = {
      k_spacing: Math.random() > 0.5 ? pA.k_spacing : pB.k_spacing,
      k_tp: Math.random() > 0.5 ? pA.k_tp : pB.k_tp,
      k_stop: Math.random() > 0.5 ? pA.k_stop : pB.k_stop,
      k_discount: Math.random() > 0.5 ? pA.k_discount : pB.k_discount,
      pnlMxn: 0,
      winRate: 0,
      profitFactor: 0,
      trades: 0,
      fitness: 0,
    };
    if (Math.random() < 0.20) child.k_spacing = parseFloat(Math.max(0.4, Math.min(1.2, child.k_spacing + (Math.random() - 0.5) * 0.15)).toFixed(2));
    if (Math.random() < 0.20) child.k_tp = parseFloat(Math.max(1.4, Math.min(3.2, child.k_tp + (Math.random() - 0.5) * 0.2)).toFixed(2));
    if (Math.random() < 0.20) child.k_stop = parseFloat(Math.max(1.8, Math.min(4.0, child.k_stop + (Math.random() - 0.5) * 0.2)).toFixed(2));
    if (Math.random() < 0.20) child.k_discount = parseFloat(Math.max(1.0, Math.min(2.5, child.k_discount + (Math.random() - 0.5) * 0.2)).toFixed(2));
    nextGen.push(child);
  }
  population = nextGen;
}

population = population.map(evaluateFx);
population.sort((a, b) => b.fitness - a.fitness);
const best = population[0];

console.log(`• Genoma Élite FX Refinado (4,705 Horas de Bitso):`);
console.log(`  Spacing=${best.k_spacing}x | TP=${best.k_tp}x | Stop=${best.k_stop}x | Desc=${best.k_discount}x`);
console.log(`  PnL Total Histórico : +$${best.pnlMxn} MXN (+${((best.pnlMxn/17720)*100).toFixed(2)}% ROI)`);
console.log(`  Total Operaciones   : ${best.trades} trades`);
console.log(`  Win Rate Real       : ${best.winRate}%`);
console.log(`  Profit Factor       : ${best.profitFactor}`);
