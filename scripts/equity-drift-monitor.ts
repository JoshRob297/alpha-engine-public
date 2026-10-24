#!/usr/bin/env bun
/**
 * Monitor de deriva de la serie de equity.
 *
 * Lee `data/metrics/equity_series.jsonl` (una muestra por hora que escribe el motor) y
 * calcula la PENDIENTE del residuo de conservacion. Un residuo distinto de cero, o una
 * pendiente no nula, es un defecto abierto: es la version "en tiempo real" del invariante
 * agregado, que en el incidente del 2026-10-19 solo se hizo visible despues de 2.9 dias.
 *
 * Uso:
 *   bun run scripts/equity-drift-monitor.ts [--path data/metrics/equity_series.jsonl] [--max-hours 26] [--json]
 *   exit 0 = sano | exit 1 = anomalia | exit 2 = sin muestras suficientes
 */

import { analyzeEquityDrift, readEquitySeries, DEFAULT_SERIES_PATH } from "../src/daemon/metrics-series.js";

const get = (flag: string, fallback?: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const path = get("--path", DEFAULT_SERIES_PATH)!;
const maxHours = parseFloat(get("--max-hours", "26")!);
const asJson = process.argv.includes("--json");

const series = readEquitySeries({ path });
if (series.length < 3) {
  console.error(`[EQUITY MONITOR] Muestras insuficientes en ${path}: ${series.length} (la serie se escribe cada hora).`);
  process.exit(2);
}

const cutoff = Date.now() - maxHours * 3_600_000;
const recent = series.filter((s) => Date.parse(s.ts) >= cutoff);
const analysis = analyzeEquityDrift(recent.length >= 3 ? recent : series);

if (asJson) {
  console.log(JSON.stringify(analysis, null, 2));
} else {
  console.log("=== ALPHA ENGINE / MONITOR DE DERIVA DE EQUITY ===");
  console.log(
    `Muestras: ${analysis.samples} | ${analysis.firstTs ?? "n/d"} -> ${analysis.lastTs ?? "n/d"} (${analysis.hoursCovered} h)`
  );
  console.log(`Residuo de conservacion: actual $${analysis.lastResidualUsd} | maximo absoluto $${analysis.maxAbsResidualUsd}`);
  console.log(
    `Pendiente: residuo $${analysis.residualSlopeUsdPerHour}/h | reserva capturada $${analysis.reserveSlopeUsdPerHour}/h`
  );
  console.log(`Estado: ${analysis.anomaly ? "ANOMALIA" : "SANO"}`);
  for (const r of analysis.anomalyReasons) console.log(`  - ${r}`);
}

if (analysis.anomaly) {
  const msg = [
    "[ALPHA ENGINE] Deriva contable detectada por la serie de equity",
    `Residuo actual $${analysis.lastResidualUsd} (maximo $${analysis.maxAbsResidualUsd})`,
    `Pendiente del residuo $${analysis.residualSlopeUsdPerHour}/h`,
    ...analysis.anomalyReasons,
  ].join("\n");
  try {
    const { execFileSync } = await import("node:child_process");
    execFileSync("telegram-send", ["-m", msg], { timeout: 20_000 });
  } catch {}
  process.exit(1);
}
process.exit(0);
