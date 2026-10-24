/**
 * Serie temporal del equity (detector de deriva).
 *
 * Motivo: el 2026-10-19 la fuga contable fue visible en EVENTOS de alerta. Sin una
 * serie, la unica forma de detectarla era esperar a que el invariante gritara. Una
 * muestra por hora permite ver la PENDIENTE del residuo y detectar la proxima fuga
 * en horas en lugar de dias.
 *
 * El residuo de conservacion es
 *   residual = reconciledUsd - (capitalUsd + realizedNetUsd)
 * y debe ser cero por construccion. Cualquier pendiente no nula es un defecto abierto.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_SERIES_PATH = "data/metrics/equity_series.jsonl";

export interface EquitySample {
  ts: string;
  capitalUsd: number;
  realizedNetUsd: number;
  deployedUsd: number;
  capturedReserveUsd: number;
  untradedReserveUsd: number;
  reconciledUsd: number;
  /** Reparaciones de conservacion acumuladas. */
  repairs?: number;
  /** Ventana OOS sin invalidaciones. */
  windowValid?: boolean;
  mode?: string;
}

export interface EquityDriftAnalysis {
  samples: number;
  firstTs: string | null;
  lastTs: string | null;
  hoursCovered: number;
  lastResidualUsd: number;
  maxAbsResidualUsd: number;
  /** Pendiente del residuo en USD por hora (regresion simple). */
  residualSlopeUsdPerHour: number;
  /** Pendiente de la reserva capturada en USD por hora. */
  reserveSlopeUsdPerHour: number;
  anomaly: boolean;
  anomalyReasons: string[];
}

export function appendEquitySample(sample: EquitySample, options: { path?: string; maxLines?: number } = {}): void {
  const path = options.path ?? DEFAULT_SERIES_PATH;
  const maxLines = options.maxLines ?? 5000;
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (existsSync(path)) {
    try {
      const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim().length > 0).length;
      if (lines >= maxLines) renameSync(path, `${path}.1`);
    } catch {}
  }
  appendFileSync(path, JSON.stringify(sample) + "\n", "utf-8");
}

export function readEquitySeries(options: { path?: string; maxLines?: number } = {}): EquitySample[] {
  const path = options.path ?? DEFAULT_SERIES_PATH;
  const maxLines = options.maxLines ?? 100_000;
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(-maxLines)
      .map((l) => {
        try {
          return JSON.parse(l) as EquitySample;
        } catch {
          return null;
        }
      })
      .filter((s): s is EquitySample => s !== null && typeof s.ts === "string");
  } catch {
    return [];
  }
}

function slopePerHour(samples: EquitySample[], pick: (s: EquitySample) => number): number {
  if (samples.length < 3) return 0;
  const t0 = Date.parse(samples[0].ts);
  const xs = samples.map((s) => (Date.parse(s.ts) - t0) / 3_600_000);
  const ys = samples.map(pick);
  const mx = xs.reduce((a, v) => a + v, 0) / xs.length;
  const my = ys.reduce((a, v) => a + v, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** Analiza la serie y marca anomalias de conservacion. */
export function analyzeEquityDrift(samples: EquitySample[], toleranceUsd = 0.5): EquityDriftAnalysis {
  const residual = (s: EquitySample) => s.reconciledUsd - (s.capitalUsd + s.realizedNetUsd);
  const residuals = samples.map(residual);
  const firstTs = samples.length ? samples[0].ts : null;
  const lastTs = samples.length ? samples[samples.length - 1].ts : null;
  const hoursCovered = samples.length >= 2 ? (Date.parse(lastTs!) - Date.parse(firstTs!)) / 3_600_000 : 0;
  const lastResidualUsd = samples.length ? round(residuals[residuals.length - 1]) : 0;
  const maxAbsResidualUsd = residuals.length ? round(Math.max(...residuals.map((r) => Math.abs(r)))) : 0;
  const residualSlopeUsdPerHour = round(slopePerHour(samples, residual));
  const reserveSlopeUsdPerHour = round(slopePerHour(samples, (s) => s.capturedReserveUsd));

  const anomalyReasons: string[] = [];
  if (Math.abs(lastResidualUsd) > toleranceUsd) {
    anomalyReasons.push(`Residuo de conservacion actual $${lastResidualUsd} (tolerancia $${toleranceUsd})`);
  }
  if (Math.abs(residualSlopeUsdPerHour) > 0.05) {
    anomalyReasons.push(
      `Pendiente del residuo $${residualSlopeUsdPerHour}/h: la contabilidad se esta abriendo en tiempo real`
    );
  }
  if (samples.length && samples[samples.length - 1].windowValid === false) {
    anomalyReasons.push("La ventana OOS tiene invalidaciones registradas");
  }
  const repairsDelta =
    samples.length >= 2 ? (samples[samples.length - 1].repairs ?? 0) - (samples[0].repairs ?? 0) : samples.length === 1 ? (samples[0].repairs ?? 0) : 0;
  if (repairsDelta > 0) {
    anomalyReasons.push(`${repairsDelta} reparacion(es) de conservacion DENTRO de la ventana analizada`);
  }

  return {
    samples: samples.length,
    firstTs,
    lastTs,
    hoursCovered: round(hoursCovered, 2),
    lastResidualUsd,
    maxAbsResidualUsd,
    residualSlopeUsdPerHour,
    reserveSlopeUsdPerHour,
    anomaly: anomalyReasons.length > 0,
    anomalyReasons,
  };
}

function round(v: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}
