/**
 * FASE 1B — Validación por Régimen (Hipótesis: la malla tiene edge en RANGO, no en TENDENCIA)
 *
 * Extiende el harness OOS con:
 *  1. Filtro de régimen (operar SOLO cuando el mercado NO está en tendencia).
 *  2. Ventanas múltiples (1 año y 3 años) para cubrir bull/bear/lateral.
 *  3. Desglose por régimen del OOS (barras en tendencia vs rango).
 *
 * Objetivo: responder si existe edge latente en régimen lateral que el harness
 * direccional original (Fase 1) no podía ver.
 */

import { BinanceHistoricalFeeder } from "../cex/binance-history.js";
import type { PriceSeries } from "../genetic/series.js";
import { GridBot, signal, DEFAULT_GENOME, type Genome } from "../genetic/bot.js";
import { MarketTemperatureMonitor } from "../guardrails/market-temperature.js";
import { writeFileSync } from "node:fs";

const INITIAL_EQUITY = 1000;

interface Result {
  name: string;
  retPct: number;
  maxDDPct: number;
  trades: number;
  winRatePct: number;
  profitFactor: number;
  exposurePct: number;
}

function summarize(name: string, bot: GridBot): Result {
  const trades = bot.trades;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const gp = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  return {
    name,
    retPct: parseFloat(((bot.cash / bot.start - 1) * 100).toFixed(2)),
    maxDDPct: parseFloat((bot.maxDD * 100).toFixed(2)),
    trades: trades.length,
    winRatePct: trades.length ? parseFloat(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    profitFactor: gl > 0 ? parseFloat((gp / gl).toFixed(2)) : gp > 0 ? 99.9 : 0,
    exposurePct: bot.bars ? parseFloat(((bot.exposed / bot.bars) * 100).toFixed(1)) : 0,
  };
}

function mean(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

/** Régimen: tendencia si el precio se desvía > threshold del SMA(lookback) o el SMA tiene pendiente pronunciada. */
function isTrending(s: PriceSeries, i: number, lookback = 168, threshold = 0.03): boolean {
  if (i < lookback + 1) return false;
  const win: number[] = [];
  for (let j = i - lookback; j <= i; j++) win.push(s.close[j]);
  const sma = mean(win);
  if (sma <= 0) return false;
  const deviation = Math.abs(s.close[i] - sma) / sma;
  const smaPrev = mean(win.slice(0, win.length - 24));
  const slope = Math.abs(sma / smaPrev - 1);
  return deviation > threshold || slope > threshold * 0.5;
}

type SignalFn = (g: Genome, s: PriceSeries, i: number, ticker: string, atr: number) => boolean;

const smartSignal: SignalFn = (g, s, i, ticker, atr) => {
  if (i < 15) return false;
  if (!signal(g, s, i - 1).ok) return false;
  const win: number[] = [];
  for (let j = Math.max(0, i - 15); j <= i; j++) win.push(s.close[j]);
  return MarketTemperatureMonitor.getTemperature(ticker, win, atr).spacingMultiplier > 0.5;
};

/** Smart + filtro de régimen: solo abre si NO hay tendencia. */
const smartRangeSignal: SignalFn = (g, s, i, ticker, atr) => {
  if (isTrending(s, i)) return false;
  return smartSignal(g, s, i, ticker, atr);
};

const naiveSignal: SignalFn = () => true;

function simulate(name: string, g: Genome, s: PriceSeries, from: number, to: number, sig: SignalFn, ticker: string, atr: number): Result {
  const bot = new GridBot(g, INITIAL_EQUITY);
  for (let i = from; i < to; i++) {
    if (!bot.inPos && sig(g, s, i, ticker, atr)) bot._open(s.open[i], i);
    if (bot.inPos) {
      for (const L of bot.levels) if (!L.filled && s.low[i] <= L.price) bot._fill(L, L.price, i);
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
  return summarize(name, bot);
}

function buyHold(s: PriceSeries, from: number, to: number): Result {
  const entry = s.close[from];
  const exit = s.close[to - 1];
  let peak = entry, maxDD = 0;
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
  };
}

function estimateAtrPct(s: PriceSeries, from: number, to: number): number {
  let sum = 0, n = 0;
  for (let i = Math.max(1, from); i < to; i++) {
    sum += Math.max(s.high[i] - s.low[i], Math.abs(s.high[i] - s.close[i - 1]), Math.abs(s.low[i] - s.close[i - 1])) / s.close[i];
    n++;
  }
  return n > 0 ? sum / n : 0.02;
}

const CANDIDATES: Array<{ id: string; g: Genome }> = [
  { id: "DEFAULT", g: DEFAULT_GENOME },
  { id: "ATR_SOL", g: { family: 3, lookback: 54, entryZ: 2.0, levels: 2, spacing: 0.0039, mult: 1.1, tp: 0.02328, stop: 0.0585 } },
  { id: "ATR_BTC", g: { family: 3, lookback: 54, entryZ: 2.0, levels: 2, spacing: 0.00605, mult: 1.1, tp: 0.02776, stop: 0.04845 } },
  { id: "TIGHT", g: { family: 3, lookback: 54, entryZ: 2.0, levels: 3, spacing: 0.004, mult: 1.15, tp: 0.02, stop: 0.05 } },
];

async function runWindow(label: string, hours: number, out: any) {
  console.log(`\n${"=".repeat(80)}\n  VENTANA ${label} (${hours}h) — ${(hours / 24).toFixed(0)} días\n${"=".repeat(80)}`);
  const [btc, sol] = await Promise.all([
    BinanceHistoricalFeeder.fetchHistoricalSeries("BTCUSDT", hours, 2000),
    BinanceHistoricalFeeder.fetchHistoricalSeries("SOLUSDT", hours, 2000),
  ]);
  if (!btc || !sol) { console.log("  [SKIP] datos insuficientes para esta ventana"); return; }
  const n = Math.min(btc.close.length, sol.close.length);
  const isEnd = Math.floor(n * 0.7);
  console.log(`  Data: ${n}h | IS:[0,${isEnd}) OOS:[${isEnd},${n})`);

  const assets = [{ t: "BTC", s: btc }, { t: "SOL", s: sol }];
  for (const a of assets) {
    const atr = estimateAtrPct(a.s, 0, isEnd);

    // Selección de genoma sobre IS usando la estrategia con filtro de régimen.
    let bestIs: { id: string; g: Genome; ret: number } | null = null;
    for (const c of CANDIDATES) {
      const r = simulate(`IS_${c.id}`, c.g, a.s, 200, isEnd, smartRangeSignal, a.t, atr);
      if (!bestIs || r.retPct > bestIs.ret) bestIs = { id: c.id, g: c.g, ret: r.retPct };
    }

    const smart = simulate("Smart", bestIs!.g, a.s, isEnd, n, smartSignal, a.t, atr);
    const smartRange = simulate("Smart+Range", bestIs!.g, a.s, isEnd, n, smartRangeSignal, a.t, atr);
    const naive = simulate("Naive", bestIs!.g, a.s, isEnd, n, naiveSignal, a.t, atr);
    const bh = buyHold(a.s, isEnd, n);

    // Desglose de régimen en OOS.
    let trendBars = 0;
    for (let i = isEnd; i < n; i++) if (isTrending(a.s, i)) trendBars++;
    const trendPct = parseFloat(((trendBars / (n - isEnd)) * 100).toFixed(1));

    console.log(`\n  ===== ${a.t} ===== (IS elige: ${bestIs!.id}=${bestIs!.ret}%)`);
    for (const r of [smart, smartRange, naive, bh]) {
      console.log(`   ${r.name.padEnd(12)} ret=${String(r.retPct).padStart(7)}%  maxDD=${String(r.maxDDPct).padStart(5)}%  PF=${r.profitFactor}  trades=${String(r.trades).padStart(3)}  win=${r.winRatePct}%`);
    }
    console.log(`   Régimen OOS: ${trendPct}% barras en tendencia, ${(100 - trendPct).toFixed(1)}% en rango`);

    out.windows[label].assets[a.t] = { isEnd, isChosen: bestIs!.id, trendPctOOS: trendPct, results: { smart, smartRange, naive, buyHold: bh } };
  }
}

export async function runRegimeValidation() {
  const out: any = { generatedAt: new Date().toISOString(), windows: {} };
  out.windows["1Y"] = { assets: {} };
  out.windows["3Y"] = { assets: {} };

  await runWindow("1Y", 8760, out);
  await runWindow("3Y", 26280, out);

  // Veredicto por activo: ¿Smart+Range bate a Naive y Buy&Hold en OOS?
  console.log(`\n${"=".repeat(80)}\n  VEREDICTO (¿Smart+Range aporta edge en OOS?)\n${"=".repeat(80)}`);
  for (const w of Object.keys(out.windows)) {
    for (const t of Object.keys(out.windows[w].assets)) {
      const R = out.windows[w].assets[t].results;
      const beatsNaive = R.smartRange.retPct > R.naive.retPct;
      const beatsBH = R.smartRange.retPct > R.buyHold.retPct;
      console.log(`  [${w}/${t}] Smart+Range=${R.smartRange.retPct}% | Naive=${R.naive.retPct}% | B&H=${R.buyHold.retPct}% -> bateNaive=${beatsNaive} bateBH=${beatsBH}`);
    }
  }

  try {
    writeFileSync("data/validation_regimes_report.json", JSON.stringify(out, null, 2));
    console.log("\n[REPORT] data/validation_regimes_report.json");
  } catch {}
  return out;
}

if (import.meta.main) {
  runRegimeValidation().catch((e) => console.error("[REGRIME VALIDATION ERROR]", e));
}
