/**
 * Motor de auditoria: dataset canonico -> veredicto.
 *
 * Separado del CLI para poder testearlo. Recibe un `CanonicalDataset` ya adaptado y
 * aplica el protocolo: PnL neto, inferencia robusta, walk-forward, escalado y regla de
 * parada. La compuerta de suficiencia se aplica ANTES de cualquier veredicto.
 */

import { computeClosedTradeStats, type TradeLike } from "../research/paper-validation.js";
import {
  binomialBelowBreakevenPValue,
  blockBootstrapMean,
  describeRiskProfile,
  effectiveSampleSize,
  evaluateStopRule,
  lag1Autocorrelation,
  type BootstrapResult,
  type RiskProfile,
} from "../research/statistics.js";
import { scalingCurve } from "../research/pnl-reconstruction.js";
import { toAuditTrades, type CanonicalDataset } from "./canonical.js";

export type AuditVerdict = "REFUTADO" | "PARADA RECOMENDADA" | "NO CONCLUYENTE" | "NO REFUTADO" | "NO AUDITABLE";

export interface AuditOptions {
  capitalUsd?: number;
  folds?: number;
  /** Profundidad USD por activo para el modelo de impacto. */
  depthByAssetUsd?: Record<string, number>;
  minClosedForReading?: number;
  /** Ventana OOS: si se pasa, el veredicto se calcula solo con trades posteriores. */
  oosStart?: string;
}

export interface AuditResult {
  verdict: AuditVerdict;
  reason: string;
  dataQuality: CanonicalDataset["quality"];
  sample: {
    closed: number;
    wins: number;
    losses: number;
    winRatePct: number;
    breakevenWinRatePct: number;
    deficitPp: number;
    profitFactor: number;
    avgWinUsd: number;
    avgLossUsd: number;
    payoffRatio: number;
    expectancyUsd: number;
    totalNetUsd: number;
    totalNetPct: number | null;
  } | null;
  inference: {
    bootstrap: BootstrapResult;
    binomialPValue: number;
    autocorrelationLag1: number;
    effectiveN: number;
    riskProfile: RiskProfile;
    stopAction: string;
    stopReasons: string[];
  } | null;
  walkForward: { folds: number; positiveFolds: number; expectancies: number[] } | null;
  scaling: { breakevenCapitalUsd: number | null; points: Array<{ capitalUsd: number; expectancyPct: number }> } | null;
  limitations: string[];
  issues: string[];
}

const DEFAULT_DEPTH: Record<string, number> = { BTCUSDT: 5_000_000, SOLUSDT: 250_000, AEROUSDT: 250_000 };

export function runAudit(dataset: CanonicalDataset, opts: AuditOptions = {}): AuditResult {
  const limitations: string[] = [];
  const quality = dataset.quality;

  if (quality.sufficiency === "INSUFFICIENT") {
    return {
      verdict: "NO AUDITABLE",
      reason: "Datos insuficientes para emitir un veredicto: no se inventan costes ni granularidad.",
      dataQuality: quality,
      sample: null,
      inference: null,
      walkForward: null,
      scaling: null,
      limitations: quality.reasons,
      issues: dataset.issues,
    };
  }
  if (quality.sufficiency === "PARTIAL") {
    limitations.push(
      `Calidad de datos PARTIAL (${quality.coveragePct}% verificable, ${quality.rowsWithFees}/${quality.totalRows} con costes): el neto puede estar sobreestimado.`
    );
  }

  const allTrades = toAuditTrades(dataset);
  const trades = opts.oosStart
    ? allTrades.filter((t) => Date.parse(t.timestamp) >= Date.parse(opts.oosStart!))
    : allTrades;

  if (trades.length === 0) {
    return {
      verdict: "NO AUDITABLE",
      reason: opts.oosStart
        ? `Sin operaciones cerradas posteriores a ${opts.oosStart}.`
        : "El dataset no contiene operaciones cerradas con timestamp valido.",
      dataQuality: quality,
      sample: null,
      inference: null,
      walkForward: null,
      scaling: null,
      limitations,
      issues: dataset.issues,
    };
  }

  const stats = computeClosedTradeStats(trades as TradeLike[], trades.length);
  const pnls = trades.map((t) => t.pnlNet);
  const bootstrap = blockBootstrapMean(pnls);
  const rho = lag1Autocorrelation(pnls);
  const binomialP = binomialBelowBreakevenPValue(stats.wins, stats.closed, stats.breakevenWinRatePct);
  const profile = describeRiskProfile(pnls);
  const stopRule = evaluateStopRule({
    n: stats.closed,
    expectancyUsd: stats.expectancyUsd,
    bootstrap,
    binomialPValue: binomialP,
    minClosedForReading: opts.minClosedForReading ?? 30,
  });

  // Walk-forward: folds consecutivos sobre la muestra (estabilidad del signo).
  const folds = Math.max(2, opts.folds ?? 4);
  const perFold = Math.max(1, Math.floor(trades.length / folds));
  const expectancies: number[] = [];
  let positiveFolds = 0;
  for (let f = 0; f < folds; f++) {
    const slice = trades.slice(f * perFold, f === folds - 1 ? trades.length : (f + 1) * perFold);
    if (slice.length === 0) continue;
    const exp = slice.reduce((a, t) => a + (t.pnlNet || 0), 0) / slice.length;
    expectancies.push(round(exp, 5));
    if (exp > 0) positiveFolds++;
  }

  const capitalUsd = opts.capitalUsd ?? dataset.account.capitalUsd ?? 0;
  const totalNet = round(pnls.reduce((a, v) => a + v, 0), 4);

  let scaling: AuditResult["scaling"] = null;
  if (capitalUsd > 0) {
    const depth = opts.depthByAssetUsd ?? DEFAULT_DEPTH;
    const curve: Array<{ capitalUsd: number; expectancyPct: number }> = [];
    let breakeven: number | null = null;
    for (const mult of [1, 2, 10, 50, 200]) {
      const cap = capitalUsd * mult;
      const point = scalingCurve(trades as any, cap, depth);
      curve.push({ capitalUsd: cap, expectancyPct: round(point.expectancyPct, 4) });
      if (point.breakevenCapitalUsd !== null && Number.isFinite(point.breakevenCapitalUsd)) {
        breakeven = round(point.breakevenCapitalUsd, 2);
      }
    }
    scaling = { breakevenCapitalUsd: breakeven, points: curve };
    limitations.push(
      "Escalado con profundidad asumida por activo (BTC 5M, resto 250k) y fee 10 bps: el breakeven de capital depende de esos supuestos."
    );
  }

  if (stats.closed < 30) limitations.push(`Muestra chica (${stats.closed} cierres): lectura preliminar.`);
  limitations.push("El veredicto cubre la estrategia y su historial, no el broker ni la custodia.");
  if (quality.rowsWithSlippage === 0) limitations.push("Sin datos de slippage: el neto no incluye impacto de ejecucion.");

  const verdict: AuditVerdict =
    stopRule.action === "REFUTED"
      ? "REFUTADO"
      : stopRule.action === "STOP_RECOMMENDED"
      ? "PARADA RECOMENDADA"
      : stats.expectancyUsd > 0 && bootstrap.significant
      ? "NO REFUTADO"
      : "NO CONCLUYENTE";

  const reason =
    verdict === "REFUTADO"
      ? "Expectancy neta negativa con IC95% por debajo de cero y win rate por debajo del breakeven con significancia."
      : verdict === "PARADA RECOMENDADA"
      ? "Expectancy neta negativa con IC95% por debajo de cero (el win rate no rechaza el breakeven)."
      : verdict === "NO REFUTADO"
      ? "Expectancy neta positiva con IC95% por encima de cero: exigir walk-forward antes de capital real."
      : "Sin evidencia suficiente para afirmar ni refutar la ventaja en la muestra.";

  return {
    verdict,
    reason,
    dataQuality: quality,
    sample: {
      closed: stats.closed,
      wins: stats.wins,
      losses: stats.losses,
      winRatePct: stats.winRatePct,
      breakevenWinRatePct: stats.breakevenWinRatePct,
      deficitPp: stats.deficitPp,
      profitFactor: stats.profitFactor,
      avgWinUsd: stats.avgWinUsd,
      avgLossUsd: stats.avgLossUsd,
      payoffRatio: stats.payoffRatio,
      expectancyUsd: stats.expectancyUsd,
      totalNetUsd: totalNet,
      totalNetPct: capitalUsd > 0 ? round((totalNet / capitalUsd) * 100, 2) : null,
    },
    inference: {
      bootstrap,
      binomialPValue: binomialP,
      autocorrelationLag1: round(rho, 3),
      effectiveN: round(effectiveSampleSize(stats.closed, rho), 1),
      riskProfile: profile,
      stopAction: stopRule.action,
      stopReasons: stopRule.reasons,
    },
    walkForward: { folds: expectancies.length, positiveFolds, expectancies },
    scaling,
    limitations,
    issues: dataset.issues,
  };
}

function round(v: number, d = 4): number {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}
