/**
 * ENTRENAMIENTO GENÉTICO BICENTENARIO EN CACHY (22 HILOS) PARA AVAX Y SUI (17,520 HORAS)
 * Evoluciona los cromosomas específicos para cada altcoin de Binance.
 */

import { readFileSync, writeFileSync } from "node:fs";

const AVAX_FILE = "/home/user/alpha-backtest/raw/avax_2y_1h.json";
const SUI_FILE = "/home/user/alpha-backtest/raw/sui_2y_1h.json";

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

interface AltGenome {
  ticker: string;
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

function evaluateAlt(g: AltGenome, candles: any[]): AltGenome {
  const feeRate = 0.00075; // 0.075% Maker fee con descuento BNB en Binance
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
  let gridPrice = candles[0].open * 0.98;

  for (let h = 15; h < candles.length; h++) {
    const c = candles[h];
    const mid = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.0001);
    const toxic = c.close < c.open && c.volume > 50000 ? 0.75 : 0.20;
    const atr = calculateATR14(candles, h);

    const spacing = Math.max(0.014, atr * g.k_spacing);
    const tpPct = Math.max(0.018, atr * g.k_tp);
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

    const eq = cash + (inPos ? (holdings * mid) : 0);
    if (eq > peakEquity) peakEquity = eq;
    const dd = peakEquity - eq;
    if (dd > maxDd) maxDd = dd;
  }

  const netPnl = cash - 1000.0;
  const total = wins + losses;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 4.0 : 0.5);
  const wr = total > 0 ? wins / total : 0;
  const ddPct = maxDd / 1000.0;

  const fitness = (pf * 0.50 + wr * 0.30 + (1 - ddPct) * 0.20) * Math.log10(Math.max(2, total)) * (netPnl > 0 ? 1.3 : 0.7);

  g.fitness = parseFloat(fitness.toFixed(3));
  g.profitFactor = parseFloat(pf.toFixed(2));
  g.winRate = parseFloat((wr * 100).toFixed(1));
  g.netPnl = parseFloat(netPnl.toFixed(2));
  g.trades = total;
  g.maxDrawdownPct = parseFloat((ddPct * 100).toFixed(2));
  return g;
}

function runAltGeneticSearch(ticker: string, candles: any[], popSize = 40, generations = 25): AltGenome {
  let population: AltGenome[] = [];

  for (let i = 0; i < popSize; i++) {
    population.push({
      ticker,
      k_spacing: parseFloat((0.6 + Math.random() * 0.9).toFixed(2)),
      k_tp: parseFloat((2.0 + Math.random() * 1.8).toFixed(2)),
      k_stop: parseFloat((3.0 + Math.random() * 1.8).toFixed(2)),
      k_discount: parseFloat((1.8 + Math.random() * 1.6).toFixed(2)),
      fitness: 0,
      profitFactor: 0,
      winRate: 0,
      netPnl: 0,
      trades: 0,
      maxDrawdownPct: 0,
    });
  }

  for (let gen = 1; gen <= generations; gen++) {
    population = population.map((g) => evaluateAlt(g, candles));
    population.sort((a, b) => b.fitness - a.fitness);

    const elite = population.slice(0, Math.floor(popSize * 0.20));
    const nextGen: AltGenome[] = [...elite];

    while (nextGen.length < popSize) {
      const pA = elite[Math.floor(Math.random() * elite.length)];
      const pB = elite[Math.floor(Math.random() * elite.length)];

      const child: AltGenome = {
        ticker,
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

      if (Math.random() < 0.15) child.k_spacing = parseFloat(Math.max(0.5, Math.min(1.8, child.k_spacing + (Math.random() - 0.5) * 0.2)).toFixed(2));
      if (Math.random() < 0.15) child.k_tp = parseFloat(Math.max(1.8, Math.min(4.5, child.k_tp + (Math.random() - 0.5) * 0.3)).toFixed(2));
      if (Math.random() < 0.15) child.k_stop = parseFloat(Math.max(2.5, Math.min(5.5, child.k_stop + (Math.random() - 0.5) * 0.3)).toFixed(2));
      if (Math.random() < 0.15) child.k_discount = parseFloat(Math.max(1.5, Math.min(3.5, child.k_discount + (Math.random() - 0.5) * 0.3)).toFixed(2));

      nextGen.push(child);
    }
    population = nextGen;
  }

  population = population.map((g) => evaluateAlt(g, candles));
  population.sort((a, b) => b.fitness - a.fitness);
  return population[0];
}

console.log("================================================================================");
console.log("   ENTRENAMIENTO GENÉTICO BICENTENARIO: AVAX Y SUI (17,520 HORAS DE BINANCE)    ");
console.log("================================================================================\n");

// 1. AVAX
console.log("1. Optimizando AVAXUSDT sobre 17,520 HORAS CONTINUAS (Binance Spot)...");
const avaxData = JSON.parse(readFileSync(AVAX_FILE, "utf-8"));
console.log(`Velas cargadas: ${avaxData.length} horas reales de AVAX.`);
const genomeAvax = runAltGeneticSearch("AVAX", avaxData, 40, 25);
console.log(`• GENOMA 2 AÑOS AVAX: Spacing=${genomeAvax.k_spacing}x | TP=${genomeAvax.k_tp}x | Stop=${genomeAvax.k_stop}x | Desc=${genomeAvax.k_discount}x`);
console.log(`  PnL 2 Años: +$${genomeAvax.netPnl} USD | WinRate: ${genomeAvax.winRate}% | Profit Factor: ${genomeAvax.profitFactor} | Trades: ${genomeAvax.trades} | Max DD: ${genomeAvax.maxDrawdownPct}%\n`);

// 2. SUI
console.log("2. Optimizando SUIUSDT sobre 17,520 HORAS CONTINUAS (Binance Spot)...");
const suiData = JSON.parse(readFileSync(SUI_FILE, "utf-8"));
console.log(`Velas cargadas: ${suiData.length} horas reales de SUI.`);
const genomeSui = runAltGeneticSearch("SUI", suiData, 40, 25);
console.log(`• GENOMA 2 AÑOS SUI: Spacing=${genomeSui.k_spacing}x | TP=${genomeSui.k_tp}x | Stop=${genomeSui.k_stop}x | Desc=${genomeSui.k_discount}x`);
console.log(`  PnL 2 Años: +$${genomeSui.netPnl} USD | WinRate: ${genomeSui.winRate}% | Profit Factor: ${genomeSui.profitFactor} | Trades: ${genomeSui.trades} | Max DD: ${genomeSui.maxDrawdownPct}%\n`);

// Actualizar base de datos de genomas bicentenarios
const currentGenomes = JSON.parse(readFileSync("/home/user/proyectos/alpha-engine/data/evolved_2year_genomes.json", "utf-8"));
currentGenomes.genomeAvax2y = genomeAvax;
currentGenomes.genomeSui2y = genomeSui;
currentGenomes.updatedAt = new Date().toISOString();

writeFileSync("/home/user/proyectos/alpha-engine/data/evolved_2year_genomes.json", JSON.stringify(currentGenomes, null, 2));
console.log("Archivo consolidado actualizado con AVAX y SUI en data/evolved_2year_genomes.json");
