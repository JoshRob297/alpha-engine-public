#!/usr/bin/env bun
/**
 * Estabilidad walk-forward (folds) de la muestra primaria.
 *
 * Que hace: parte la muestra de cierres en K folds CONSECUTIVOS en el tiempo y calcula
 * expectancy / win rate / profit factor en cada uno. La pregunta que responde no es
 * "cuanto gana" sino "el resultado se sostiene en todos los tramos o depende de uno".
 *
 * Que NO hace (limitacion declarada): no es un re-entrenamiento por fold. Un walk-forward
 * real exige re-ejecutar la ventana fold a fold sobre inputs grabados (ver
 * `src/guardrails/input-recorder.ts` + `scripts/replay-decisions.ts`). Esto es la
 * estabilidad temporal de los CIERRES observados, que es la parte que ya se puede medir.
 *
 * Uso:
 *   bun run scripts/walk-forward-stability.ts --state ./data/engine_state.json [--folds 4] [--since ISO] [--json]
 */

import { existsSync, readFileSync } from "node:fs";
import { computeClosedTradeStats, type TradeLike } from "../src/research/paper-validation.js";

const get = (flag: string, fallback?: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const statePath = get("--state", "./data/engine_state.json");
const folds = Math.max(2, parseInt(get("--folds", "4")!, 10));
const since = get("--since", process.env.MEASUREMENT_STARTED_AT || "");
const asJson = process.argv.includes("--json");

if (!existsSync(statePath)) {
  console.error(`[WALK-FORWARD] Estado no encontrado: ${statePath}`);
  process.exit(2);
}

const state = JSON.parse(readFileSync(statePath, "utf-8"));
let trades: TradeLike[] = (state.history || []).filter((t: TradeLike) => (t.pnlNet || 0) !== 0);
if (since) trades = trades.filter((t) => Date.parse(t.timestamp) >= Date.parse(since));
trades = [...trades].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

if (trades.length < folds * 3) {
  console.error(
    `[WALK-FORWARD] Muestra insuficiente: ${trades.length} cierres para ${folds} folds (minimo ${folds * 3}). Acumular y repetir.`
  );
  process.exit(3);
}

const perFold = Math.floor(trades.length / folds);
const results = [];
for (let f = 0; f < folds; f++) {
  const start = f * perFold;
  const end = f === folds - 1 ? trades.length : start + perFold;
  const slice = trades.slice(start, end);
  const stats = computeClosedTradeStats(slice, slice.length);
  results.push({
    fold: f + 1,
    from: slice[0].timestamp,
    to: slice[slice.length - 1].timestamp,
    closed: stats.closed,
    winRatePct: stats.winRatePct,
    profitFactor: stats.profitFactor,
    expectancyUsd: stats.expectancyUsd,
    netUsd: round(slice.reduce((a, t) => a + (t.pnlNet || 0), 0), 4),
  });
}

const expectancies = results.map((r) => r.expectancyUsd);
const mean = expectancies.reduce((a, v) => a + v, 0) / expectancies.length;
const variance =
  expectancies.length > 1
    ? expectancies.reduce((a, v) => a + (v - mean) ** 2, 0) / (expectancies.length - 1)
    : 0;
const positiveFolds = results.filter((r) => r.expectancyUsd > 0).length;
const signConsistent = positiveFolds === results.length || positiveFolds === 0;

const summary = {
  folds,
  since: since || null,
  trades: trades.length,
  perFold,
  meanExpectancyUsd: round(mean, 5),
  betweenFoldSdUsd: round(Math.sqrt(variance), 5),
  positiveFolds,
  signConsistent,
  stability: signConsistent ? "ESTABLE (mismo signo en todos los tramos)" : "INESTABLE (el signo cambia entre tramos)",
  results,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("=== ALPHA ENGINE / ESTABILIDAD WALK-FORWARD (folds temporales) ===");
  console.log(
    `Muestra: ${trades.length} cierres${since ? ` desde ${since}` : ""} en ${folds} folds consecutivos (~${perFold} por fold)`
  );
  console.log("");
  console.log("  Fold | Desde                | Hasta                | n  | WR%    | PF     | Expectancy | Neto");
  for (const r of results) {
    console.log(
      `  ${String(r.fold).padStart(4)} | ${r.from.slice(0, 19)} | ${r.to.slice(0, 19)} | ${String(r.closed).padStart(2)} | ${String(r.winRatePct).padStart(6)} | ${String(r.profitFactor).padStart(6)} | ${String(r.expectancyUsd).padStart(10)} | ${r.netUsd}`
    );
  }
  console.log("");
  console.log(
    `  Media entre folds: $${summary.meanExpectancyUsd}/trade | desviacion entre folds $${summary.betweenFoldSdUsd} | folds positivos ${positiveFolds}/${folds}`
  );
  console.log(`  Estabilidad: ${summary.stability}`);
  console.log(
    "  Nota: esto mide estabilidad temporal de los cierres observados, no un re-entrenamiento por fold."
  );
}

function round(v: number, digits = 5): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}
