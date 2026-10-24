/**
 * ENTRENAMIENTO PROFUNDO HISTÓRICO MÁXIMO DE SETS EN CACHY (22 HILOS)
 * Evaluando el 100% de la historia disponible (Cero Miopía / Resiliencia Anual Completa):
 * - Solana (SOL/USD) : 8,760 Horas (1 Año Completo / 365 Días)
 * - Bitcoin (BTC/USD): 8,760 Horas (1 Año Completo / 365 Días)
 * - Reserva FX (Bitso): 4,705 Horas (6.4 Meses Continuos)
 */

import { readFileSync, writeFileSync } from "node:fs";

const SOL_FILE = "/home/user/alpha-backtest/raw/sol_1h_full.json";
const BTC_FILE = "/home/user/alpha-backtest/raw/btc_1h_full.json";
const FX_FILE = "/home/user/alpha-backtest/raw/usd_mxn_1h.json";

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

interface DeepGenome {
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
  maxDrawdownPct: number;
}

function evaluateDeep(g: DeepGenome, candles: any[], isFx = false): DeepGenome {
  const feeRate = 0.0010;
  let cash = isFx ? 17720.0 : 1000.0;
  const initialCash = cash;
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
  let peakEquity = cash;
  let maxDd = 0;

  const orderSize = isFx ? 250.0 : 250.0;
  let gridPrice = candles[0].open * 0.998;

  for (let h = 15; h < candles.length; h++) {
    const c = candles[h];
    const mid = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.0001);
    const toxic = c.close < c.open && c.volume > (isFx ? 150000 : 50000) ? 0.75 : 0.20;
    const atr = calculateATR14(candles, h);

    const spacing = Math.max(isFx ? 0.0015 : 0.015, atr * g.k_spacing);
    const tpPct = Math.max(isFx ? 0.0040 : 0.018, atr * g.k_tp);
    const stopPct = Math.max(spacing * 1.8, atr * g.k_stop);
    const discountPct = Math.max(spacing * 1.5, atr * g.k_discount);

    if (isLocked) {
      if (h - lockH >= 6 && ofi > 0.20 && toxic < 0.35) {
        isLocked = false;
        gridPrice = mid * (1 - discountPct);
      }
    }

    if (!inPos && !isLocked && c.low <= gridPrice) {
      inPos = true;
      holdings = isFx ? orderSize : (orderSize / gridPrice);
      entryPrice = gridPrice;
      entryH = h;
      const cost = isFx ? (orderSize * entryPrice) : orderSize;
      const fee = cost * feeRate;
      cash -= (cost + fee);
    } else if (inPos && h > entryH) {
      const stopP = entryPrice * (1 - stopPct);
      const tpP = entryPrice * (1 + tpPct);

      if (c.low <= stopP) {
        const exitP = Math.min(stopP, mid * 0.9975);
        const gross = holdings * exitP;
        const net = gross * (1 - feeRate);
        const delta = net - (holdings * entryPrice);
        cash += net;
        grossLoss += Math.abs(delta);
        losses++;
        inPos = false;
        isLocked = true;
        lockH = h;
      } else if (c.high >= tpP) {
        const exitP = tpP;
        const gross = holdings * exitP;
        const net = gross * (1 - feeRate);
        const delta = net - (holdings * entryPrice);
        cash += net;
        grossProfit += delta;
        wins++;
        inPos = false;
        gridPrice = mid * (1 - spacing);
      }
    }

    const eq = cash + (inPos ? (isFx ? (holdings * mid) : (holdings * mid)) : 0);
    if (eq > peakEquity) peakEquity = eq;
    const dd = peakEquity - eq;
    if (dd > maxDd) maxDd = dd;
  }

  const netPnl = cash - initialCash;
  const total = wins + losses;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 4.0 : 0.5);
  const wr = total > 0 ? wins / total : 0;
  const ddPct = maxDd / initialCash;

  // Fitness Multiobjetivo: Premia consistencia a lo largo de miles de horas
  const fitness = (pf * 0.45 + wr * 0.35 + (1 - ddPct) * 0.20) * Math.log10(Math.max(2, total)) * (netPnl > 0 ? 1.25 : 0.75);

  g.fitness = parseFloat(fitness.toFixed(3));
  g.profitFactor = parseFloat(pf.toFixed(2));
  g.winRate = parseFloat((wr * 100).toFixed(1));
  g.netPnl = parseFloat(netPnl.toFixed(2));
  g.trades = total;
  g.maxDrawdownPct = parseFloat((ddPct * 100).toFixed(2));
  return g;
}

export function runDeepGeneticSearch(candles: any[], isFx = false, popSize = 50, generations = 30): DeepGenome {
  let population: DeepGenome[] = [];

  for (let i = 0; i < popSize; i++) {
    population.push({
      id: i,
      k_spacing: parseFloat((isFx ? (0.6 + Math.random() * 1.2) : (0.5 + Math.random() * 1.0)).toFixed(2)),
      k_tp: parseFloat((isFx ? (2.0 + Math.random() * 2.8) : (2.2 + Math.random() * 2.0)).toFixed(2)),
      k_stop: parseFloat((isFx ? (3.0 + Math.random() * 3.5) : (3.2 + Math.random() * 1.8)).toFixed(2)),
      k_discount: parseFloat((isFx ? (1.2 + Math.random() * 1.8) : (1.8 + Math.random() * 1.6)).toFixed(2)),
      fitness: 0,
      profitFactor: 0,
      winRate: 0,
      netPnl: 0,
      trades: 0,
      maxDrawdownPct: 0,
    });
  }

  for (let gen = 1; gen <= generations; gen++) {
    population = population.map((g) => evaluateDeep(g, candles, isFx));
    population.sort((a, b) => b.fitness - a.fitness);

    const elite = population.slice(0, Math.floor(popSize * 0.20));
    const nextGen: DeepGenome[] = [...elite];

    while (nextGen.length < popSize) {
      const pA = elite[Math.floor(Math.random() * elite.length)];
      const pB = elite[Math.floor(Math.random() * elite.length)];

      const child: DeepGenome = {
        id: nextGen.length,
        k_spacing: Math.random() > 0.5 ? pA.k_spacing : pB.k_spacing,
        k_tp: Math.random() > 0.5 ? pA.k_tp : pB.k_tp,
        k_stop: Math.random() > 0.5 ? pA.k_stop : pB.k_stop,
        k_discount: Math.random() > 0.5 ? pA.k_discount : pB.k_discount,
        fitness: 0,
        profitFactor: 0,
        winRate: 0,
        netPnl: 0,
        trades: 0,
        maxDrawdownPct: 0,
      };

      if (Math.random() < 0.15) child.k_spacing = parseFloat(Math.max(0.4, Math.min(2.0, child.k_spacing + (Math.random() - 0.5) * 0.2)).toFixed(2));
      if (Math.random() < 0.15) child.k_tp = parseFloat(Math.max(1.8, Math.min(5.2, child.k_tp + (Math.random() - 0.5) * 0.3)).toFixed(2));
      if (Math.random() < 0.15) child.k_stop = parseFloat(Math.max(2.5, Math.min(7.0, child.k_stop + (Math.random() - 0.5) * 0.3)).toFixed(2));
      if (Math.random() < 0.15) child.k_discount = parseFloat(Math.max(1.0, Math.min(3.8, child.k_discount + (Math.random() - 0.5) * 0.3)).toFixed(2));

      nextGen.push(child);
    }
    population = nextGen;
  }

  population = population.map((g) => evaluateDeep(g, candles, isFx));
  population.sort((a, b) => b.fitness - a.fitness);
  return population[0];
}

console.log("================================================================================");
console.log("   ENTRENAMIENTO PROFUNDO ANUAL DE SETS EN CACHY (22 HILOS)                     ");
console.log("================================================================================\n");

console.log("1. Evolucionando Solana sobre 8,760 HORAS (1 Año Completo de Cripto)...");
const solRaw = JSON.parse(readFileSync(SOL_FILE, "utf-8"));
const masterSol = runDeepGeneticSearch(solRaw, false, 50, 30);
console.log(`• GENOMA MAESTRO SOL (1 AÑO): Spacing=${masterSol.k_spacing}x | TP=${masterSol.k_tp}x | Stop=${masterSol.k_stop}x | Desc=${masterSol.k_discount}x`);
console.log(`  PnL Anual: +$${masterSol.netPnl} USD | WinRate: ${masterSol.winRate}% | Profit Factor: ${masterSol.profitFactor} | Trades: ${masterSol.trades} | Max DD: ${masterSol.maxDrawdownPct}%\n`);

console.log("2. Evolucionando Bitcoin sobre 8,760 HORAS (1 Año Completo de Cripto)...");
const btcRaw = JSON.parse(readFileSync(BTC_FILE, "utf-8"));
const masterBtc = runDeepGeneticSearch(btcRaw, false, 50, 30);
console.log(`• GENOMA MAESTRO BTC (1 AÑO): Spacing=${masterBtc.k_spacing}x | TP=${masterBtc.k_tp}x | Stop=${masterBtc.k_stop}x | Desc=${masterBtc.k_discount}x`);
console.log(`  PnL Anual: +$${masterBtc.netPnl} USD | WinRate: ${masterBtc.winRate}% | Profit Factor: ${masterBtc.profitFactor} | Trades: ${masterBtc.trades} | Max DD: ${masterBtc.maxDrawdownPct}%\n`);

console.log("3. Evolucionando Reserva Cambiaria FX sobre 4,705 HORAS (6.4 Meses Reales)...");
const fxRaw = JSON.parse(readFileSync(FX_FILE, "utf-8"));
const masterFx = runDeepGeneticSearch(fxRaw, true, 50, 30);
console.log(`• GENOMA MAESTRO FX (4,705h): Spacing=${masterFx.k_spacing}x | TP=${masterFx.k_tp}x | Stop=${masterFx.k_stop}x | Desc=${masterFx.k_discount}x`);
console.log(`  PnL Total: +$${masterFx.netPnl} MXN | WinRate: ${masterFx.winRate}% | Profit Factor: ${masterFx.profitFactor} | Trades: ${masterFx.trades} | Max DD: ${masterFx.maxDrawdownPct}%\n`);

const masterGenomes = {
  bestSol: masterSol,
  bestBtc: masterBtc,
  bestFx: masterFx,
  trainingScope: "100% Full History (8,760h CEX / 4,705h FX)",
  generatedAt: new Date().toISOString()
};

writeFileSync("/home/user/proyectos/alpha-engine/data/evolved_atr_genomes.json", JSON.stringify(masterGenomes, null, 2));
console.log("================================================================================");
console.log("GENOMAS MAESTROS DEFINITIVOS GUARDADOS EN data/evolved_atr_genomes.json");
console.log("================================================================================\n");
