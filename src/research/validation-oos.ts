/**
 * FASE 1 — Harness de Validación Rigurosa CEX (Out-of-Sample, Benchmarks y Robustez)
 *
 * Metodología:
 *  1. Descarga velas horarias reales de Binance Spot (BTC, SOL).
 *  2. Split In-Sample (IS) / Out-of-Sample (OOS) temporal (sin fuga de información).
 *  3. Selección de genoma SOLO sobre IS; evaluación reportada SOLO sobre OOS.
 *  4. Benchmarks obligatorios: Buy & Hold y Grid Ingenuo (sin señal/sin inteligencia).
 *  5. Robustez de parámetros: perturbación ±20% / ±40% del genoma elegido sobre OOS.
 *  6. Sensibilidad a la fecha de inicio (Monte Carlo de offsets) sobre OOS.
 *
 * Costos: Maker 0.10% por fill y por cierre (roundtrip 0.20%), aplicado por GridBot.
 */

import { BinanceHistoricalFeeder } from "../cex/binance-history.js";
import type { PriceSeries } from "../genetic/series.js";
import { GridBot, signal, type Genome } from "../genetic/bot.js";
import { MarketTemperatureMonitor } from "../guardrails/market-temperature.js";
import { DEFAULT_GENOME } from "../genetic/bot.js";
import { writeFileSync } from "node:fs";

const INITIAL_EQUITY = 1000;

export interface StrategyResult {
  name: string;
  retPct: number;
  maxDDPct: number;
  trades: number;
  winRatePct: number;
  profitFactor: number;
  exposurePct: number;
  finalNav: number;
}

type OpenSignal = (g: Genome, s: PriceSeries, i: number, ticker: string, baseAtr: number) => boolean;

function summarize(name: string, bot: GridBot, s: PriceSeries): StrategyResult {
  const trades = bot.trades;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  return {
    name,
    retPct: parseFloat(((bot.cash / bot.start - 1) * 100).toFixed(2)),
    maxDDPct: parseFloat((bot.maxDD * 100).toFixed(2)),
    trades: trades.length,
    winRatePct: trades.length ? parseFloat(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    profitFactor: grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 99.9 : 0,
    exposurePct: bot.bars ? parseFloat(((bot.exposed / bot.bars) * 100).toFixed(1)) : 0,
    finalNav: parseFloat(bot.cash.toFixed(2)),
  };
}

/** Simula la estrategia de malla sobre [from, to). */
function simulate(
  name: string,
  g: Genome,
  s: PriceSeries,
  from: number,
  to: number,
  openSignal: OpenSignal,
  ticker: string,
  baseAtr: number
): StrategyResult {
  const bot = new GridBot(g, INITIAL_EQUITY);
  for (let i = from; i < to; i++) {
    if (!bot.inPos) {
      if (openSignal(g, s, i, ticker, baseAtr)) bot._open(s.open[i], i);
    }
    if (bot.inPos) {
      for (const L of bot.levels) {
        if (!L.filled && s.low[i] <= L.price) bot._fill(L, L.price, i);
      }
      bot.tp = bot.avg * (1 + bot.g.tp);
      if (s.low[i] <= bot.stop) bot._close(bot.stop, i, "STOP");
      else if (s.high[i] >= bot.tp) bot._close(bot.tp, i, "TP");
    }
    const eq = bot.equity(s.close[i]);
    bot.peak = Math.max(bot.peak, eq);
    bot.maxDD = Math.max(bot.maxDD, 1 - eq / bot.peak);
    bot.bars++;
    if (bot.inPos) bot.exposed++;
  }
  if (bot.inPos) bot.flatten(s, to - 1);
  return summarize(name, bot, s);
}

/** Señal de la estrategia real: entrada por genoma + modulación térmica del stop. */
const smartSignal: OpenSignal = (g, s, i, ticker, baseAtr) => {
  if (i < 15) return false;
  const sig = signal(g, s, i - 1);
  if (!sig.ok) return false;
  const win: number[] = [];
  for (let j = Math.max(0, i - 15); j <= i; j++) win.push(s.close[j]);
  // La modulación térmica existe en producción; aquí solo condiciona la apertura (no altera el genoma).
  const temp = MarketTemperatureMonitor.getTemperature(ticker, win, baseAtr);
  return temp.spacingMultiplier > 0.5;
};

/** Grid ingenuo: abre al inicio de la ventana y reabre de inmediato tras cada cierre. Sin señal, sin inteligencia. */
const naiveSignal: OpenSignal = (_g, _s, _i) => true;

/** Buy & Hold sobre la ventana. */
function buyHold(s: PriceSeries, from: number, to: number): StrategyResult {
  const entry = s.close[from];
  const exit = s.close[to - 1];
  let peak = entry;
  let maxDD = 0;
  for (let i = from; i < to; i++) {
    peak = Math.max(peak, s.close[i]);
    maxDD = Math.max(maxDD, 1 - s.close[i] / peak);
  }
  return {
    name: "BuyHold",
    retPct: parseFloat(((exit / entry - 1) * 100).toFixed(2)),
    maxDDPct: parseFloat((maxDD * 100).toFixed(2)),
    trades: 1,
    winRatePct: exit >= entry ? 100 : 0,
    profitFactor: exit >= entry ? 99.9 : 0,
    exposurePct: 100,
    finalNav: parseFloat((INITIAL_EQUITY * (exit / entry)).toFixed(2)),
  };
}

function estimateAtrPct(s: PriceSeries, from: number, to: number): number {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(1, from); i < to; i++) {
    const tr = Math.max(s.high[i] - s.low[i], Math.abs(s.high[i] - s.close[i - 1]), Math.abs(s.low[i] - s.close[i - 1]));
    sum += tr / s.close[i];
    n++;
  }
  return n > 0 ? sum / n : 0.02;
}

const CANDIDATE_GENOMES: Array<{ id: string; g: Genome }> = [
  { id: "DEFAULT", g: DEFAULT_GENOME },
  {
    id: "ATR_SOL",
    g: { family: 3, lookback: 54, entryZ: 2.0, levels: 2, spacing: 0.0039, mult: 1.1, tp: 0.02328, stop: 0.0585 },
  },
  {
    id: "ATR_BTC",
    g: { family: 3, lookback: 54, entryZ: 2.0, levels: 2, spacing: 0.00605, mult: 1.1, tp: 0.02776, stop: 0.04845 },
  },
  {
    id: "TIGHT",
    g: { family: 3, lookback: 54, entryZ: 2.0, levels: 3, spacing: 0.004, mult: 1.15, tp: 0.02, stop: 0.05 },
  },
];

function perturbation(g: Genome, factor: number): Genome {
  return {
    ...g,
    spacing: +(g.spacing * factor).toFixed(5),
    tp: +(g.tp * factor).toFixed(5),
    stop: +(g.stop * factor).toFixed(5),
  };
}

export async function runOosValidation(): Promise<any> {
  const TOTAL_HOURS = 8760; // 1 año de velas horarias

  console.log("=".repeat(80));
  console.log("  FASE 1 — VALIDACION OUT-OF-SAMPLE (CEX)  |  Capital inicial $1,000 USD");
  console.log("=".repeat(80));

  console.log("\n[1/6] Descargando datos historicos reales de Binance Spot...");
  const [btc, sol] = await Promise.all([
    BinanceHistoricalFeeder.fetchHistoricalSeries("BTCUSDT", TOTAL_HOURS, 2000),
    BinanceHistoricalFeeder.fetchHistoricalSeries("SOLUSDT", TOTAL_HOURS, 2000),
  ]);
  if (!btc || !sol) {
    console.error("Fallo la descarga de datos. Abortando validacion.");
    return null;
  }
  const n = Math.min(btc.close.length, sol.close.length);
  const isEnd = Math.floor(n * 0.7); // 70% IS, 30% OOS
  console.log(`[DATA OK] ${n} horas por activo. In-Sample: [0,${isEnd}) | Out-of-Sample: [${isEnd},${n})`);

  const assets = [
    { ticker: "BTC", s: btc },
    { ticker: "SOL", s: sol },
  ];

  const report: any = { generatedAt: new Date().toISOString(), hours: n, isEnd, assets: {} };

  console.log("\n[2/6] Seleccion de genoma SOLO sobre In-Sample (sin fuga de informacion)...");
  for (const a of assets) {
    const atr = estimateAtrPct(a.s, 0, isEnd);
    let best: { id: string; g: Genome; r: StrategyResult } | null = null;
    const isRanking: Array<{ id: string; retPct: number }> = [];
    for (const cand of CANDIDATE_GENOMES) {
      const r = simulate(`IS_${cand.id}`, cand.g, a.s, 200, isEnd, smartSignal, a.ticker, atr);
      isRanking.push({ id: cand.id, retPct: r.retPct });
      if (!best || r.retPct > best.r.retPct) best = { id: cand.id, g: cand.g, r };
    }
    console.log(`  ${a.ticker} IS ranking: ${isRanking.map((x) => `${x.id}=${x.retPct}%`).join(" | ")} -> elegido: ${best!.id}`);

    console.log(`\n[3/6] Evaluacion OOS de ${a.ticker} (genoma elegido: ${best!.id}) + benchmarks...`);
    const oosSmart = simulate("Smart(genoma)", best!.g, a.s, isEnd, n, smartSignal, a.ticker, atr);
    const oosNaive = simulate("GridIngenuo", best!.g, a.s, isEnd, n, naiveSignal, a.ticker, atr);
    const oosBH = buyHold(a.s, isEnd, n);

    report.assets[a.ticker] = { isEnd, isRanking, chosen: best!.id, oos: { smart: oosSmart, naive: oosNaive, buyHold: oosBH } };
  }

  console.log("\n[4/6] Robustez de parametros (perturbacion +/-20% y +/-40% sobre OOS)...");
  for (const a of assets) {
    const atr = estimateAtrPct(a.s, 0, isEnd);
    const chosenId = report.assets[a.ticker].chosen;
    const base = CANDIDATE_GENOMES.find((c) => c.id === chosenId)!.g;
    const variants = [0.6, 0.8, 1.0, 1.2, 1.4].map((f) => ({ f, r: simulate(`p${f}`, perturbation(base, f), a.s, isEnd, n, smartSignal, a.ticker, atr) }));
    report.assets[a.ticker].robustness = variants.map((v) => ({ factor: v.f, retPct: v.r.retPct }));
    const rets = variants.map((v) => v.r.retPct);
    console.log(`  ${a.ticker} OOS ret vs factor: ${variants.map((v) => `${v.f}x=${v.r.retPct}%`).join(" | ")} | min=${Math.min(...rets)}% max=${Math.max(...rets)}%`);
  }

  console.log("\n[5/6] Sensibilidad a la fecha de inicio (offsets de 0/168/336/504h dentro del OOS)...");
  for (const a of assets) {
    const atr = estimateAtrPct(a.s, 0, isEnd);
    const chosenId = report.assets[a.ticker].chosen;
    const base = CANDIDATE_GENOMES.find((c) => c.id === chosenId)!.g;
    const offsets = [0, 168, 336, 504].filter((o) => isEnd + o + 500 < n);
    const runs = offsets.map((o) => ({ o, r: simulate(`off${o}`, base, a.s, isEnd + o, n, smartSignal, a.ticker, atr) }));
    report.assets[a.ticker].startSensitivity = runs.map((x) => ({ offsetHours: x.o, retPct: x.r.retPct }));
    console.log(`  ${a.ticker} OOS ret por offset: ${runs.map((x) => `+${x.o}h=${x.r.retPct}%`).join(" | ")}`);
  }

  console.log("\n[6/6] Resumen comparativo OOS (estrategia vs benchmarks):");
  for (const a of assets) {
    const o = report.assets[a.ticker].oos;
    console.log(`\n  ===== ${a.ticker} (OOS) =====`);
    for (const r of [o.smart, o.naive, o.buyHold] as StrategyResult[]) {
      console.log(`   ${r.name.padEnd(16)} ret=${String(r.retPct).padStart(7)}%  maxDD=${String(r.maxDDPct).padStart(5)}%  PF=${r.profitFactor}  trades=${r.trades}  win=${r.winRatePct}%  exp=${r.exposurePct}%`);
    }
  }

  try {
    writeFileSync("data/validation_oos_report.json", JSON.stringify(report, null, 2));
    console.log("\n[REPORT] Guardado en data/validation_oos_report.json");
  } catch {}

  return report;
}

if (import.meta.main) {
  runOosValidation().catch((e) => console.error("[VALIDATION ERROR]", e));
}
