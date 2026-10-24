#!/usr/bin/env bun
/**
 * DEMO del kit de auditoria: dos estrategias sinteticas, una deceptiva y una sana.
 *
 * Proposito: demostrar en un comando que el kit
 *   1. desenmascara una estrategia que un dashboard tradicional mostraria como rentable
 *      (win rate alto + PnL bruto positivo + un componente simulado sumado al titular), y
 *   2. NO refuta una estrategia que si tiene expectativa positiva (control de falsos positivos).
 *
 * Sin archivos, sin red: genera los trades con un PRNG sembrado y aplica los mismos modulos
 * puros que usa el pipeline real (estadistica robusta, reconstruccion de PnL, escalado).
 *
 * Uso:
 *   bun run scripts/audit-demo.ts [--json]
 *
 * Codigos de salida: 0 = el kit clasifico correctamente ambos casos | 1 = el kit fallo
 * (deceptiva NO refutada o sana refutada).
 */

import { computeClosedTradeStats, type TradeLike } from "../src/research/paper-validation.js";
import {
  binomialBelowBreakevenPValue,
  blockBootstrapMean,
  createSeededRandom,
  describeRiskProfile,
  effectiveSampleSize,
  evaluateStopRule,
  lag1Autocorrelation,
} from "../src/research/statistics.js";
import { reconcileTradesWithLedger, scalingCurve } from "../src/research/pnl-reconstruction.js";
import { adaptGeneric } from "../src/audit/adapters/generic.js";
import { toAuditTrades } from "../src/audit/canonical.js";

interface DemoConfig {
  name: string;
  description: string;
  capitalUsd: number;
  closedTrades: number;
  days: number;
  winRate: number;
  winPct: number;
  lossPct: number;
  /** Costes: fee + slippage por trade, en fraccion del nocional (ida y vuelta). */
  feePct: number;
  slippagePct: number;
  /** Componente SIMULADO que un dashboard naive sumaria al titular (no es PnL). */
  simulatedFundingUsd: number;
  simulatedDexFeesUsd: number;
  seed: number;
}

interface DemoResult {
  name: string;
  naiveHeadlineUsd: number;
  naiveHeadlinePct: number;
  grossPnlUsd: number;
  feesUsd: number;
  slippageUsd: number;
  netPnlUsd: number;
  netPct: number;
  closed: number;
  winRatePct: number;
  breakevenWinRatePct: number;
  deficitPp: number;
  expectancyUsd: number;
  bootstrapCi: [number, number];
  binomialPValue: number;
  effectiveN: number;
  autocorrelation: number;
  positiveFolds: number;
  folds: number;
  breakevenCapitalUsd: number | null;
  verdict: string;
  action: string;
  passed: boolean;
}

const ASSETS = [
  { symbol: "BTCUSDT", price: 80_000 },
  { symbol: "SOLUSDT", price: 100 },
  { symbol: "AEROUSDT", price: 0.8 },
];

function generateTrades(cfg: DemoConfig): { trades: TradeLike[]; gross: number; fees: number; slippage: number } {
  const rand = createSeededRandom(cfg.seed);
  const trades: TradeLike[] = [];
  const notionalTarget = cfg.capitalUsd / 4; // ~25% del capital por trade
  let gross = 0;
  let fees = 0;
  let slippage = 0;

  for (let i = 0; i < cfg.closedTrades; i++) {
    const asset = ASSETS[Math.floor(rand() * ASSETS.length)];
    const notional = notionalTarget * (0.85 + rand() * 0.3);
    const isWin = rand() < cfg.winRate;
    const pnlPct = isWin ? cfg.winPct : -cfg.lossPct;
    const entryPrice = asset.price * (0.97 + rand() * 0.06);
    const exitPrice = entryPrice * (1 + pnlPct / 100);
    const amount = notional / entryPrice;
    const pnlNet = round((exitPrice - entryPrice) * amount, 4);
    const feePaid = round(notional * cfg.feePct, 4);
    const slip = round(notional * cfg.slippagePct, 4);

    const ts = new Date(Date.now() - (cfg.days - (i / cfg.closedTrades) * cfg.days) * 86_400_000);
    trades.push({
      timestamp: ts.toISOString(),
      mode: "PAPER",
      venue: "BINANCE_SPOT",
      assetOrPool: asset.symbol,
      action: isWin ? "TAKE_PROFIT" : "EMERGENCY_DELEVERAGE",
      price: round(exitPrice, 6),
      amount: round(amount, 6),
      pnlNet,
      pnlPct: pnlPct,
      feeSavedOrPaid: 0,
      feePaidUsd: feePaid,
      slippageUsd: slip,
      liquidity: "MAKER",
    } as any);
    gross += pnlNet;
    fees += feePaid;
    slippage += slip;
  }

  // Orden cronologico estable
  trades.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return { trades, gross: round(gross, 2), fees: round(fees, 2), slippage: round(slippage, 2) };
}

function runCase(cfg: DemoConfig): DemoResult {
  const { trades, gross, fees, slippage } = generateTrades(cfg);
  const netTrades: TradeLike[] = trades.map((t: any) => ({
    ...t,
    pnlNet: round((t.pnlNet || 0) - (t.feePaidUsd || 0) - (t.slippageUsd || 0), 4),
  }));
  const netPnl = round(netTrades.reduce((a, t) => a + (t.pnlNet || 0), 0), 2);
  const stats = computeClosedTradeStats(netTrades, cfg.closedTrades);
  const pnls = netTrades.map((t) => t.pnlNet || 0);
  const bootstrap = blockBootstrapMean(pnls);
  const rho = lag1Autocorrelation(pnls);
  const binomialP = binomialBelowBreakevenPValue(stats.wins, stats.closed, stats.breakevenWinRatePct);
  const profile = describeRiskProfile(pnls);
  const stopRule = evaluateStopRule({
    n: stats.closed,
    expectancyUsd: stats.expectancyUsd,
    bootstrap,
    binomialPValue: binomialP,
    minClosedForReading: 30,
  });

  // Estabilidad temporal: 4 folds consecutivos sobre los trades netos.
  const folds = 4;
  const perFold = Math.floor(netTrades.length / folds);
  let positiveFolds = 0;
  for (let f = 0; f < folds; f++) {
    const slice = netTrades.slice(f * perFold, f === folds - 1 ? netTrades.length : (f + 1) * perFold);
    const exp = slice.reduce((a, t) => a + (t.pnlNet || 0), 0) / Math.max(1, slice.length);
    if (exp > 0) positiveFolds++;
  }

  const depth = { BTCUSDT: 5_000_000, SOLUSDT: 250_000, AEROUSDT: 250_000 };
  const scale = scalingCurve(trades as any, cfg.capitalUsd, depth);

  const naiveHeadline = round(gross + cfg.simulatedFundingUsd + cfg.simulatedDexFeesUsd, 2);

  return {
    name: cfg.name,
    naiveHeadlineUsd: naiveHeadline,
    naiveHeadlinePct: round((naiveHeadline / cfg.capitalUsd) * 100, 2),
    grossPnlUsd: gross,
    feesUsd: fees,
    slippageUsd: slippage,
    netPnlUsd: netPnl,
    netPct: round((netPnl / cfg.capitalUsd) * 100, 2),
    closed: stats.closed,
    winRatePct: stats.winRatePct,
    breakevenWinRatePct: stats.breakevenWinRatePct,
    deficitPp: stats.deficitPp,
    expectancyUsd: stats.expectancyUsd,
    bootstrapCi: [bootstrap.ci95LowUsd, bootstrap.ci95HighUsd],
    binomialPValue: binomialP,
    effectiveN: round(effectiveSampleSize(stats.closed, rho), 1),
    autocorrelation: round(rho, 3),
    positiveFolds,
    folds,
    breakevenCapitalUsd: scale.breakevenCapitalUsd,
    verdict:
      stopRule.action === "REFUTED"
        ? "REFUTADO"
        : stopRule.action === "STOP_RECOMMENDED"
        ? "PARADA RECOMENDADA"
        : stats.expectancyUsd > 0 && bootstrap.significant
        ? "NO REFUTADO"
        : "NO CONCLUYENTE",
    action: stopRule.action,
    passed: false, // se setea en main
  };
}

function fmtP(p: number): string {
  if (p === 0) return "<1e-6";
  if (p < 0.0001) return p.toExponential(2);
  return String(p);
}

function round(v: number, d = 4): number {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

const DECEPTIVE: DemoConfig = {
  name: "Deceptiva (dashboard feliz, edge inexistente)",
  description:
    "Gana 80% de las veces pero pierde 10x por perdida. El titular naive suma un funding de futuros SIMULADO y fees DEX: parece +12%. El PnL auditado es negativo.",
  capitalUsd: 1000,
  closedTrades: 160,
  days: 60,
  winRate: 0.8,
  winPct: 0.45,
  lossPct: 4.5,
  feePct: 0.002,
  slippagePct: 0.0005,
  simulatedFundingUsd: 300,
  simulatedDexFeesUsd: 40,
  seed: 1101,
};

const HEALTHY: DemoConfig = {
  name: "Sana (control de falsos positivos)",
  description:
    "Gana 55% de las veces con payoff 1:1.4 a favor. El titular naive es moderado, pero el PnL neto y la inferencia robusta muestran expectativa positiva.",
  capitalUsd: 1000,
  closedTrades: 250,
  days: 90,
  winRate: 0.55,
  winPct: 2.0,
  lossPct: 1.0,
  feePct: 0.002,
  slippagePct: 0.0005,
  simulatedFundingUsd: 0,
  simulatedDexFeesUsd: 0,
  seed: 2202,
};


/**
 * Tercer caso: export de un bot ajeno en formato MT4 (CSV con ; y costes con signo).
 * Demuestra el adaptador generico: el kit no entiende "cualquier archivo", entiende un
 * contrato canonico y un mapeo explicito. Y con datos reales puede decir NO CONCLUYENTE.
 */
function buildMt4Csv(): { csv: string; profitSum: number; netSum: number; rows: number } {
  const rand = createSeededRandom(3303);
  const rows: string[] = ["ticket;open_time;symbol;type;lots;open_price;close_price;commission;swap;profit"];
  let profitSum = 0;
  let netSum = 0;
  const n = 120;
  const wins = 0.84;
  for (let i = 0; i < n; i++) {
    const isWin = rand() < wins;
    const open = 80_000 * (0.97 + rand() * 0.06);
    const close = open * (1 + (isWin ? 0.005 : -0.03));
    const notional = 250;
    const lots = notional / open;
    const profit = round((close - open) * lots, 2);
    const commission = -round(notional * 0.0005, 2);
    const swap = -0.01;
    const ts = new Date(Date.now() - (60 - (i / n) * 60) * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    rows.push(`${i + 1};${ts};BTCUSD;buy;${lots.toFixed(6)};${open.toFixed(2)};${close.toFixed(2)};${commission};${swap};${profit}`);
    profitSum += profit;
    netSum += profit + commission + swap;
  }
  return { csv: rows.join("\n"), profitSum: round(profitSum, 2), netSum: round(netSum, 2), rows: n };
}

function runForeignCase() {
  const mt4 = buildMt4Csv();
  const ds = adaptGeneric(mt4.csv, {
    source: "mt4-export.csv",
    format: "csv",
    delimiter: ";",
    capitalUsd: 1000,
    mapping: {
      ts: "open_time",
      symbol: "symbol",
      qty: "lots",
      entryPrice: "open_price",
      exitPrice: "close_price",
      pnlNet: "profit",
      pnlKind: "gross",
      fees: "commission",
      extraCosts: ["swap"],
      costSign: "negative",
    },
  });
  const bridged = toAuditTrades(ds);
  const stats = computeClosedTradeStats(bridged as any, 191);
  const pnls = bridged.map((t) => t.pnlNet);
  const bootstrap = blockBootstrapMean(pnls);
  const binomialP = binomialBelowBreakevenPValue(stats.wins, stats.closed, stats.breakevenWinRatePct);
  const stopRule = evaluateStopRule({
    n: stats.closed,
    expectancyUsd: stats.expectancyUsd,
    bootstrap,
    binomialPValue: binomialP,
    minClosedForReading: 30,
  });
  const verdict =
    stopRule.action === "REFUTED"
      ? "REFUTADO"
      : stopRule.action === "STOP_RECOMMENDED"
      ? "PARADA RECOMENDADA"
      : stats.expectancyUsd > 0 && bootstrap.significant
      ? "NO REFUTADO"
      : "NO CONCLUYENTE";
  return { mt4, ds, stats, bootstrap, binomialP, verdict };
}

const results = [runCase(DECEPTIVE), runCase(HEALTHY)];
results[0].passed = results[0].verdict === "REFUTADO";
results[1].passed = results[1].verdict === "NO REFUTADO";

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ results, ok: results.every((r) => r.passed) }, null, 2));
} else {
  console.log("=== KIT DE AUDITORIA / DEMO (2 casos sinteticos, sin red) ===\n");
  const pad = (s: string | number, n: number) => String(s).padStart(n);
  for (const r of results) {
    const cfg = r.name.startsWith("Deceptiva") ? DECEPTIVE : HEALTHY;
    console.log(`--- ${r.name}`);
    console.log(`  ${cfg.description}`);
    console.log(`  Titular naive (lo que mostraria un dashboard): ${r.naiveHeadlineUsd >= 0 ? "+" : ""}$${r.naiveHeadlineUsd} (${r.naiveHeadlinePct}%)`);
    console.log(
      `  Auditable: bruto ${r.grossPnlUsd >= 0 ? "+" : ""}$${r.grossPnlUsd} - fees $${r.feesUsd} - slippage $${r.slippageUsd} = NETO ${r.netPnlUsd >= 0 ? "+" : ""}$${r.netPnlUsd} (${r.netPct}%)`
    );
    console.log(
      `  Muestra: n=${r.closed} | WR ${r.winRatePct}% vs breakeven ${r.breakevenWinRatePct}% (deficit ${r.deficitPp} pp)`
    );
    console.log(
      `  Inferencia: expectancy $${r.expectancyUsd} | bootstrap IC95% [$${r.bootstrapCi[0]}, $${r.bootstrapCi[1]}] | binomial p=${fmtP(r.binomialPValue)} | n efectivo ${r.effectiveN} (lag-1 ${r.autocorrelation})`
    );
    console.log(
      `  Walk-forward: ${r.positiveFolds}/${r.folds} folds positivos | breakeven de capital ${r.breakevenCapitalUsd === null || !Number.isFinite(r.breakevenCapitalUsd) ? "no alcanzado con la profundidad asumida" : `$${r.breakevenCapitalUsd}`}`
    );
    console.log(`  VEREDICTO DEL KIT: ${r.verdict}  ${r.passed ? "[OK]" : "[FALLO DEL KIT]"}`);
    console.log("");
  }
  const foreign = runForeignCase();
  console.log("--- Formato de terceros (MT4 CSV, adaptador generico)");
  console.log(
    `  Ingesta: ${foreign.mt4.rows} filas | calidad ${foreign.ds.quality.sufficiency} (${foreign.ds.quality.coveragePct}% con PnL verificable, ${foreign.ds.quality.rowsWithFees} con costes)`
  );
  console.log(
    `  Columna 'profit' del broker (BRUTA): ${foreign.mt4.profitSum >= 0 ? "+" : ""}$${foreign.mt4.profitSum} | NETO auditado (profit + commission + swap): ${foreign.mt4.netSum >= 0 ? "+" : ""}$${foreign.mt4.netSum}`
  );
  console.log(
    `  n=${foreign.stats.closed} | WR ${foreign.stats.winRatePct}% vs breakeven ${foreign.stats.breakevenWinRatePct}% | expectancy neta $${foreign.stats.expectancyUsd} | bootstrap IC95% [$${foreign.bootstrap.ci95LowUsd}, $${foreign.bootstrap.ci95HighUsd}] | binomial p=${fmtP(foreign.binomialP)}`
  );
  console.log(`  VEREDICTO DEL KIT: ${foreign.verdict}  [ADAPTADOR OK]`);
  console.log("  Lectura: el kit no entiende cualquier archivo; entiende un contrato canonico y un mapeo");
  console.log("  explicito. Y con datos reales puede decir NO CONCLUYENTE en vez de inventar certeza.");
  console.log("");
  console.log("=== RESUMEN ===");
  console.log(
    results.every((r) => r.passed)
      ? "El kit clasifico correctamente: refuto la deceptiva y no refuto la sana (sin falsos positivos)."
      : "FALLO: el kit no clasifico correctamente los casos de control."
  );
}

process.exit(results.every((r) => r.passed) ? 0 : 1);
