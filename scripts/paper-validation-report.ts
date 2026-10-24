#!/usr/bin/env bun
/**
 * Reporte de validacion del periodo Paper (Alpha Engine).
 *
 * Lee el estado persistido + logs + dataset de destilacion, descarga klines reales
 * de Binance y emite un veredicto estadistico sobre si la estrategia tiene ventaja.
 *
 * Uso:
 *   bun run scripts/paper-validation-report.ts
 *   bun run scripts/paper-validation-report.ts --notify
 *   bun run scripts/paper-validation-report.ts --offline --state /ruta/engine_state.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  computeBuyHoldComparison,
  computeClosedTradeStats,
  computeDexAnalytics,
  computeEquityReconciliation,
  computeExitCounterfactuals,
  computeLayaAttribution,
  type Kline,
  type TradeLike,
} from "../src/research/paper-validation.js";
import { MEASUREMENT_TARGET_CLOSED_TRADES } from "../src/guardrails/measurement-window.js";
import {
  binomialBelowBreakevenPValue,
  blockBootstrapMean,
  describeRiskProfile,
  effectiveSampleSize,
  estimateDaysToTarget,
  evaluateStopRule,
  lag1Autocorrelation,
} from "../src/research/statistics.js";

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

interface Args {
  statePath: string;
  genomesPath: string;
  distillPath: string;
  outputDir: string;
  notify: boolean;
  offline: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    statePath: get("--state", "./data/engine_state.json"),
    genomesPath: get("--genomes", "./data/evolved_atr_genomes.json"),
    distillPath: get("--distill", "./data/laya_distillation.jsonl"),
    outputDir: get("--out", "./data/validation"),
    notify: argv.includes("--notify"),
    offline: argv.includes("--offline"),
  };
}

async function fetchKlines(symbol: string, startMs: number, endMs: number): Promise<Kline[]> {
  const out: Kline[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&startTime=${cursor}&limit=1000`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) break;
    const raw = (await res.json()) as any[];
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const k of raw) out.push({ openTimeMs: Number(k[0]), close: parseFloat(k[4]) });
    const last = Number(raw[raw.length - 1][0]);
    if (last <= cursor) break;
    cursor = last + 3_600_000;
    if (raw.length < 1000) break;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.statePath)) {
    console.error(`[VALIDATION] No existe el estado: ${args.statePath}`);
    process.exit(1);
  }

  const state = JSON.parse(readFileSync(args.statePath, "utf-8"));
  const trades: TradeLike[] = state.history || [];

  // El `pnlNet` del ledger es BRUTO (la auditoria independiente lo verifica): los costes
  // viven en `feePaidUsd`/`slippageUsd`. El veredicto debe emitirse sobre el PnL NETO,
  // porque las fees son dinero real. Antes se calculaba sobre el bruto y sobrestimaba el
  // resultado (en la corrida real: -3.32 bruto vs -4.66 neto).
  const netTrades: TradeLike[] = trades.map((t: any) => ({
    ...t,
    pnlNet: (t.pnlNet || 0) - (t.feePaidUsd || 0) - (t.slippageUsd || 0),
  }));
  const startedAt: string = state.startedAt || new Date().toISOString();
  const daysElapsed = Math.max(0.1, (Date.now() - Date.parse(startedAt)) / 86_400_000);

  // Inicio de la ventana out-of-sample: congelamiento de genomas o congelamiento explicito.
  let oosStart: string | null = process.env.MEASUREMENT_STARTED_AT || null;
  if (!oosStart && existsSync(args.genomesPath)) {
    try {
      const g = JSON.parse(readFileSync(args.genomesPath, "utf-8"));
      if (g.updatedAt) oosStart = g.updatedAt;
    } catch {}
  }

  // Dias transcurridos dentro de la ventana OOS (para el ETA al objetivo de cierres).
  const oosDaysElapsed = oosStart ? Math.max(0.01, (Date.now() - Date.parse(oosStart)) / 86_400_000) : daysElapsed;

  const symbols = Array.from(
    new Set([
      "BTCUSDT",
      "SOLUSDT",
      ...Object.keys(state.cexPositions || {}).map((t) => `${t}USDT`),
    ])
  );

  const klinesBySymbol: Record<string, Kline[]> = {};
  if (!args.offline) {
    for (const s of symbols) {
      try {
        klinesBySymbol[s] = await fetchKlines(s, Date.parse(startedAt), Date.now());
      } catch (err: any) {
        console.warn(`[VALIDATION] Sin klines para ${s}: ${err?.message || err}`);
      }
    }
  }

  const closedFull = computeClosedTradeStats(netTrades, MEASUREMENT_TARGET_CLOSED_TRADES);
  const closedOoS = oosStart
    ? computeClosedTradeStats(
        netTrades.filter((t) => Date.parse(t.timestamp) >= Date.parse(oosStart!)),
        MEASUREMENT_TARGET_CLOSED_TRADES
      )
    : null;

  // Inferencia robusta sobre la muestra primaria: el perfil es bimodal y los cierres
  // estan autocorrelacionados, de modo que el t de Student no alcanza (ver
  // src/research/statistics.ts).
  const primary = closedOoS ?? closedFull;
  const primaryLabel = closedOoS ? "OOS" : "total";
  const primaryTrades = closedOoS
    ? netTrades.filter((t) => Date.parse(t.timestamp) >= Date.parse(oosStart!))
    : netTrades;
  const primaryPnls = primaryTrades
    .filter((t) => (t.pnlNet || 0) !== 0)
    .map((t) => t.pnlNet || 0);
  const bootstrap = blockBootstrapMean(primaryPnls);
  const riskProfile = describeRiskProfile(primaryPnls);
  const rho1 = lag1Autocorrelation(primaryPnls);
  const binomialP = binomialBelowBreakevenPValue(
    primary.wins,
    Math.max(1, primary.closed),
    primary.breakevenWinRatePct
  );
  const stopRule = evaluateStopRule({
    n: primary.closed,
    expectancyUsd: primary.expectancyUsd,
    bootstrap,
    binomialPValue: binomialP,
    minClosedForReading: 30,
  });
  const eta = estimateDaysToTarget(primary.closed, oosStart ? oosDaysElapsed : daysElapsed, MEASUREMENT_TARGET_CLOSED_TRADES);

  // Veredicto textual derivado de la inferencia robusta (no del t de Student).
  const verdict =
    primary.closed < 10
      ? `EN ACUMULACION: ${primary.closed} cierres en la muestra ${primaryLabel} (objetivo ${primary.targetClosedTrades}); sin lectura estadistica todavia`
      : stopRule.action === "REFUTED"
      ? `REFUTADO EN VIVO: expectancy negativa con IC95% por debajo de cero y win rate por debajo del breakeven con significancia (n=${primary.closed} ${primaryLabel})`
      : stopRule.action === "STOP_RECOMMENDED"
      ? `PARADA RECOMENDADA: expectancy negativa con IC95% por debajo de cero, aunque el win rate no rechaza el breakeven (n=${primary.closed} ${primaryLabel})`
      : primary.expectancyUsd < 0
      ? `NO CONCLUYENTE aun: expectancy negativa sin evidencia suficiente (IC95% [$${bootstrap.ci95LowUsd}, $${bootstrap.ci95HighUsd}], p binomial ${binomialP}); seguir acumulando`
      : `NO REFUTADO: expectancy positiva en la muestra ${primaryLabel} (n=${primary.closed}); exigir walk-forward antes de capital real`;

  const counterfactuals = computeExitCounterfactuals(trades, klinesBySymbol, [1, 4, 24]);
  const dex = computeDexAnalytics(state.dexPositions || {}, daysElapsed);
  const equity = computeEquityReconciliation(state);

  const distillRecords: any[] = [];
  if (existsSync(args.distillPath)) {
    for (const line of readFileSync(args.distillPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        distillRecords.push(JSON.parse(line));
      } catch {}
    }
  }
  const substitutionForAttribution =
    distillRecords.length > 0
      ? distillRecords
      : trades.filter((t) => t.action.startsWith("TP_") || t.action.startsWith("EMERGENCY"));
  const layaAttribution = computeLayaAttribution(substitutionForAttribution);

  const prices: Record<string, { start: number; end: number }> = {};
  for (const [ticker, list] of Object.entries(klinesBySymbol)) {
    const asset = ticker.replace(/USDT$/, "");
    if (!list || list.length < 2) continue;
    prices[asset] = { start: list[0].close, end: list[list.length - 1].close };
  }
  const allocatedByAsset: Record<string, number> = {};
  for (const [ticker, p] of Object.entries(state.cexPositions || {})) {
    allocatedByAsset[ticker] = (p as any).allocatedCashUsd || 0;
  }
  const benchmark = computeBuyHoldComparison(trades, prices, allocatedByAsset);

  const report = {
    generatedAt: new Date().toISOString(),
    window: {
      startedAt,
      daysElapsed: Math.round(daysElapsed * 100) / 100,
      oosStart,
      oosDays: oosStart ? Math.round(((Date.now() - Date.parse(oosStart)) / 86_400_000) * 100) / 100 : null,
      executionMode: state.executionMode,
      genomeFrozen: state.measurement?.genomeFrozen ?? null,
    },
    equity,
    dex: { ...dex, daysElapsed: Math.round(daysElapsed * 100) / 100 },
    closedFull,
    closedOoS,
    primarySample: primaryLabel,
    robustInference: {
      bootstrap,
      binomialPValue: binomialP,
      effectiveSampleSize: effectiveSampleSize(primary.closed, rho1),
      autocorrelationLag1: round3(rho1),
      riskProfile,
      stopRule,
      eta,
    },
    windowValidity: {
      valid: state.measurement?.windowValid !== false && (state.measurement?.invalidations?.length ?? 0) === 0,
      invalidations: state.measurement?.invalidations ?? [],
      conservationRepairs: state.measurement?.conservationRepairs ?? state.conservationRepairs ?? null,
    },
    benchmark,
    counterfactuals,
    layaAttribution,
    dexRebalanceEventsTotal: state.dexRebalanceEventsTotal ?? null,
  };

  const lines: string[] = [];
  lines.push("=== ALPHA ENGINE / VALIDACION PERIODO PAPER ===");
  lines.push(
    `Ventana: ${startedAt} -> hoy (${report.window.daysElapsed} d) | modo=${state.executionMode} | genomas congelados=${report.window.genomeFrozen}`
  );
  if (oosStart) lines.push(`OOS desde: ${oosStart} (${report.window.oosDays} d)`);
  lines.push("");
  lines.push("--- EQUITY RECONCILIADA ---");
  lines.push(`  Valor desplegado (CEX+DEX): $${equity.deployedValueUsd ?? "n/d"}`);
  lines.push(`  Reserva no operada:        $${equity.untradedReserveUsd ?? "n/d"} (residuo derivado)`);
  lines.push(`  Reserva capturada:         $${equity.unallocatedCashUsd ?? "n/d"}`);
  lines.push(`  Sim equity (total):        $${equity.reconciledUsd}`);
  lines.push(`  Formula legacy:            $${equity.legacyFormulaUsd ?? "n/d"}`);
  lines.push(`  Deriva vs legacy:          $${equity.driftUsd ?? "n/d"} (${equity.driftPct ?? "n/d"}% del capital)`);
  lines.push(
    `  Despliegue vs politica:    $${equity.underDeploymentVsPolicyUsd ?? "n/d"} (objetivo activo $${equity.policyActiveTargetUsd ?? "n/d"}) | capital fantasma $${equity.phantomCapitalUsd ?? "n/d"}`
  );
  lines.push("");
  lines.push("--- CEX: CIERRES (netos de fees y slippage) ---");
  const fmt = (s: typeof closedFull, label: string) => {
    const pf = s.losses === 0 ? "n/d (sin perdidas: PF no es interpretable)" : s.profitFactor;
    lines.push(`  ${label}: n=${s.closed} (${s.wins}W/${s.losses}L) WR=${s.winRatePct}% PF=${pf}`);
    lines.push(
      `     avgWin=${s.avgWinPct}% avgLoss=${s.avgLossPct}% payoff=1:${s.payoffRatio} breakeven WR=${s.breakevenWinRatePct}% deficit=${s.deficitPp} pp`
    );
    lines.push(
      `     expectancy=$${s.expectancyUsd}/trade t=${s.tStat} IC95=[$${s.ci95LowUsd}, $${s.ci95HighUsd}] significativo=${s.statisticallySignificant}`
    );
  };
  fmt(closedFull, "Total");
  if (closedOoS) fmt(closedOoS, "OOS  ");
  lines.push(
    `  Faltan ${(closedOoS ?? closedFull).remainingClosedTrades} cierres para el objetivo de ${(closedOoS ?? closedFull).targetClosedTrades} (muestra ${closedOoS ? "OOS" : "total"})`
  );
  lines.push(
    `  Modelo de IL: ${state.equity?.ilModel ?? "concentrado"} | IL activo $${state.equity?.dexImpermanentLossUsd ?? 0} vs rango completo $${state.equity?.dexImpermanentLossFullRangeUsd ?? 0}`
  );
  lines.push("");
  lines.push("--- DEX ---");
  for (const s of dex.slots) {
    lines.push(
      `  ${s.slot}: fees=$${s.feesUsd} IL=$${s.impermanentLossUsd} gas=$${s.gasUsd} neto=$${s.netPnlUsd} | APR modelado=${s.feeAprPct}% realizado=${s.realizedOverModeledPct}% | gas/fees=${s.gasOverFees}x`
    );
  }
  lines.push(
    `  TOTAL: fees=$${dex.totals.feesUsd} IL=$${dex.totals.ilUsd} gas=$${dex.totals.gasUsd} neto=$${dex.totals.netPnlUsd} (gas/fees=${dex.totals.gasOverFees}x)`
  );
  lines.push("");
  const fh = state.futuresHedge;
  if (fh) {
    const funding = fh.totalAccumulatedFundingUsd ?? fh.accumulatedFundingUsd ?? null;
    const positions = Array.isArray(fh.positions) ? fh.positions.length : null;
    lines.push("");
    lines.push("--- FUTUROS DELTA-NEUTRAL (sombra, sin ejecucion real) ---");
    lines.push(
      `  Posiciones: ${positions ?? "n/d"} | Funding acumulado: ${funding === null ? "n/d" : `$${Number(funding).toFixed(4)}`} | Capital reservado: $${fh.reservedCapitalUsd ?? "n/d"}`
    );
    lines.push("  El short es sombra: el PnL de la pata corta no esta validado contra un exchange real.");
  }
  lines.push("--- BENCHMARK (mismo capital desplegado) ---");
  for (const b of benchmark) {
    lines.push(
      `  ${b.asset}: estrategia=${b.strategyPct}% B&H=${b.buyHoldPct}% delta=${b.deltaPp} pp (desplegado $${b.deployedUsd})`
    );
  }
  lines.push("");
  lines.push("--- CONTRAFACTUAL DE SALIDAS (value added vs mantener) ---");
  for (const c of counterfactuals) {
    lines.push(
      `  ${c.action}: n=${c.n} realizado=$${c.realizedUsd} | +1h=$${c.valueAddedUsdByHorizon.h1} (${c.hitRateByHorizon.h1}%) +4h=$${c.valueAddedUsdByHorizon.h4} +24h=$${c.valueAddedUsdByHorizon.h24} (${c.hitRateByHorizon.h24}%)`
    );
  }
  lines.push("");
  lines.push("--- ATRIBUCION DEL GATILLO ---");
  lines.push(
    `  muestras=${layaAttribution.total} OFI=${layaAttribution.ofi} LAYA=${layaAttribution.laya} BOTH=${layaAttribution.both} OTHER=${layaAttribution.other} (solo-Laya=${layaAttribution.layaOnlySharePct}%)`
  );
  if (primary.closed > 0) {
  lines.push("");
  lines.push("--- INFERENCIA ROBUSTA (sin supuesto de normalidad) ---");
  lines.push(
    `  Bootstrap por bloques: media $${bootstrap.meanUsd} IC95% [$${bootstrap.ci95LowUsd}, $${bootstrap.ci95HighUsd}] bloques=${bootstrap.blockSize} iter=${bootstrap.iterations} significativo=${bootstrap.significant}`
  );
  lines.push(
    `  Autocorrelacion lag-1=${round3(rho1)} -> n efectivo ${effectiveSampleSize(primary.closed, rho1).toFixed(1)} de ${primary.closed} (el t de Student asume independencia)`
  );
  lines.push(
    `  Binomial exacto (WR observado < WR de breakeven): ${primary.wins}W/${primary.closed} contra breakeven ${primary.breakevenWinRatePct}% -> p=${binomialP} ${binomialP < 0.05 ? "(rechaza)" : "(no rechaza)"}`
  );
  lines.push(
    `  Perfil de riesgo: payoff 1:${riskProfile.payoffRatio} | 3 peores trades = ${riskProfile.lossConcentration3Pct}% de la perdida total | t-test apropiado=${!riskProfile.tTestUnsuitable}`
  );
  for (const reason of riskProfile.unsuitabilityReasons) lines.push(`    - ${reason}`);
  }
  lines.push("");
  lines.push("--- VEREDICTO ---");
  // La lectura se emite sobre la muestra OOS (ventana pre-registrada) y combina dos
  // pruebas que NO asumen normalidad: bootstrap por bloques del promedio y test binomial
  // del win rate contra el breakeven. El t de Student se reporta solo como referencia.
  lines.push(`  ${verdict}`);
  if (!primary.statisticallySignificant) {
    lines.push(
      `  Muestra insuficiente: faltan ${primary.remainingClosedTrades} cierres para el objetivo de ${primary.targetClosedTrades} (muestra ${primaryLabel}).`
    );
  }
  if (eta.daysNeeded !== null && primary.closed < primary.targetClosedTrades) {
    lines.push(
      `  Ritmo observado ${eta.ratePerDay}/dia -> ETA al objetivo: ${eta.daysNeeded} dias (${eta.etaIso?.slice(0, 10)})`
    );
  }
  lines.push(`  Regla de parada: ${stopRule.action}`);
  for (const r of stopRule.reasons) lines.push(`    - ${r}`);
  const windowValid = state.measurement?.windowValid !== false && (state.measurement?.invalidations?.length ?? 0) === 0;
  lines.push(
    `  Ventana comparable: ${windowValid ? "SI" : "NO"}${
      state.measurement?.invalidations?.length
        ? ` (${state.measurement.invalidations.length} invalidaciones: ${state.measurement.invalidations
            .slice(-3)
            .map((i: any) => i.reason)
            .join(", ")})`
        : ""
    }`
  );
  if (dex.totals.feesUsd > 0 && dex.totals.gasUsd === 0) {
    lines.push(
      "  DEX sin gas/IL registrados: el estado previo a la correccion no los persistia. Se poblan desde el reinicio."
    );
  }

  const text = lines.join("\n");
  console.log(text);

  if (!existsSync(args.outputDir)) mkdirSync(args.outputDir, { recursive: true });
  const stamp = new Date().toISOString().split("T")[0];
  const jsonPath = join(args.outputDir, `paper_validation_${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  appendFileSync(
    join(args.outputDir, "paper_validation_history.jsonl"),
    JSON.stringify({
      generatedAt: report.generatedAt,
      windowStart: oosStart,
      sampleKind: primaryLabel,
      closed: primary.closed,
      winRatePct: primary.winRatePct,
      profitFactor: primary.profitFactor,
      expectancyUsd: primary.expectancyUsd,
      tStat: primary.tStat,
      breakevenWinRatePct: primary.breakevenWinRatePct,
      deficitPp: primary.deficitPp,
      closedFullSample: closedFull.closed,
      equityReconciledUsd: equity.reconciledUsd,
      equityDriftUsd: equity.driftUsd,
      bootstrapCi95LowUsd: bootstrap.ci95LowUsd,
      bootstrapCi95HighUsd: bootstrap.ci95HighUsd,
      binomialPValue: binomialP,
      stopAction: stopRule.action,
      windowValid: state.measurement?.windowValid !== false,
      dexNetPnlUsd: dex.totals.netPnlUsd,
      dexGasOverFees: dex.totals.gasOverFees,
    }) + "\n",
    "utf-8"
  );
  console.log(`\n[VALIDATION] JSON: ${jsonPath}`);

  if (args.notify) {
    const summary = [
      "[ALPHA ENGINE] Validacion periodo Paper",
      `Muestra: ${primaryLabel} desde ${oosStart ?? startedAt}`,
      `Cierres: ${primary.closed}/${primary.targetClosedTrades} | WR ${primary.winRatePct}% | PF ${primary.profitFactor}`,
      `Breakeven WR ${primary.breakevenWinRatePct}% (deficit ${primary.deficitPp} pp)`,
      `Expectancy $${primary.expectancyUsd}/trade (t=${primary.tStat}) | IC95% bootstrap [$${bootstrap.ci95LowUsd}, $${bootstrap.ci95HighUsd}]`,
      `Binomial vs breakeven p=${binomialP} | parada=${stopRule.action} | ventana ${state.measurement?.windowValid === false ? "INVALIDA" : "comparable"}`,
      `Equity reconciliada $${equity.reconciledUsd} (deriva $${equity.driftUsd})`,
      `DEX neto $${dex.totals.netPnlUsd} (gas/fees ${dex.totals.gasOverFees}x)`,
      verdict,
    ].join("\n");
    try {
      execFileSync("telegram-send", ["-m", summary], { timeout: 20000 });
      console.log("[VALIDATION] Notificacion enviada.");
    } catch (err: any) {
      console.warn(`[VALIDATION] No se pudo notificar: ${err?.message || err}`);
    }
  }
}

main().catch((err) => {
  console.error("[VALIDATION ERROR]", err);
  process.exit(1);
});
