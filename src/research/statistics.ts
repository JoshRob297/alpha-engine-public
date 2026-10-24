/**
 * Estadistica robusta para el veredicto de validacion.
 *
 * Motivo: el perfil de resultados de la corrida NO es normal. La muestra observada
 * tiene forma bimodal (muchas ganancias pequenas de +0.58% y unas pocas
 * EMERGENCY_DELEVERAGE de -3.60%) y los cierres estan autocorrelacionados (las mallas
 * hacen ping-pong sobre el mismo recorrido de precio). Con ese perfil:
 *   - el t de Student sobreestima la evidencia (asume iid y normalidad),
 *   - el IC95% clasico es demasiado estrecho,
 *   - y el tamano de muestra "efectivo" es menor que n.
 *
 * Este modulo provee alternativas que no asumen normalidad:
 *   - bootstrap por bloques del promedio (preserva autocorrelacion),
 *   - test binomial exacto del win rate contra el win rate de breakeven,
 *   - tamano de muestra efectivo ajustado por autocorrelacion,
 *   - perfil de riesgo (concentracion de perdidas, idoneidad del t-test),
 *   - regla de parada pre-registrada y ETA al objetivo.
 *
 * Todo puro y deterministico (PRNG sembrado): los resultados son reproducibles.
 */

export interface BootstrapResult {
  meanUsd: number;
  ci95LowUsd: number;
  ci95HighUsd: number;
  /** El IC95% excluye 0. */
  significant: boolean;
  blockSize: number;
  iterations: number;
  seed: number;
}

export interface RiskProfile {
  n: number;
  wins: number;
  losses: number;
  winRatePct: number;
  meanWinUsd: number;
  meanLossUsd: number;
  payoffRatio: number;
  /** Peor trade en USD (negativo). */
  worstTradeUsd: number;
  /** Fraccion de la perdida total aportada por los 3 peores trades. */
  lossConcentration3Pct: number;
  /** Fraccion del resultado total aportada por el mejor trade. */
  bestWinSharePct: number;
  /** El t-test de Student no es apropiado para este perfil. */
  tTestUnsuitable: boolean;
  unsuitabilityReasons: string[];
}

export interface StopRuleInput {
  n: number;
  expectancyUsd: number;
  bootstrap: BootstrapResult;
  /** p-valor del test binomial exacto (WR observado < WR de breakeven). */
  binomialPValue: number;
  /** Cierres minimos para emitir una lectura (pre-registrado). */
  minClosedForReading: number;
}

export type StopAction = "CONTINUE" | "STOP_RECOMMENDED" | "REFUTED";

export interface StopRuleResult {
  action: StopAction;
  reasons: string[];
}

/** PRNG determinista (algoritmo de Lehmer, 32 bits). */
export function createSeededRandom(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

/** Autocorrelacion de lag 1 (Pearson sobre pares consecutivos). */
export function lag1Autocorrelation(x: number[]): number {
  if (x.length < 3) return 0;
  const mean = x.reduce((a, v) => a + v, 0) / x.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - mean;
    den += d * d;
    if (i > 0) num += d * (x[i - 1] - mean);
  }
  if (den === 0) return 0;
  return Math.max(-0.99, Math.min(0.99, num / den));
}

/**
 * Tamano de muestra efectivo ante autocorrelacion AR(1):
 *   n_eff = n * (1 - rho) / (1 + rho)
 */
export function effectiveSampleSize(n: number, rho1: number): number {
  if (n <= 0) return 0;
  const rho = Math.max(-0.99, Math.min(0.99, rho1));
  return Math.max(1, (n * (1 - rho)) / (1 + rho));
}

/** Tamano de bloque sugerido para el bootstrap circular. */
export function suggestBlockSize(n: number, rho1: number): number {
  if (n < 4) return 1;
  const rho = Math.max(0, Math.min(0.99, rho1));
  // n^(1/3) corregido por la persistencia observada.
  const base = Math.pow(n, 1 / 3);
  return Math.max(1, Math.min(n, Math.round(base * (1 + 2 * rho))));
}

/**
 * Bootstrap circular por bloques de la media. No asume normalidad y preserva
 * la estructura de dependencia dentro de cada bloque.
 */
export function blockBootstrapMean(
  values: number[],
  options: { iterations?: number; blockSize?: number; seed?: number; alpha?: number } = {}
): BootstrapResult {
  const n = values.length;
  const iterations = options.iterations ?? 4000;
  const seed = options.seed ?? 20261019;
  const alpha = options.alpha ?? 0.05;
  if (n === 0) {
    return { meanUsd: 0, ci95LowUsd: 0, ci95HighUsd: 0, significant: false, blockSize: 1, iterations, seed };
  }
  const mean = values.reduce((a, v) => a + v, 0) / n;
  const rho = lag1Autocorrelation(values);
  const blockSize = Math.max(1, Math.min(n, options.blockSize ?? suggestBlockSize(n, rho)));

  const rand = createSeededRandom(seed);
  const means: number[] = [];
  const blocks = Math.ceil(n / blockSize);

  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    let count = 0;
    for (let b = 0; b < blocks; b++) {
      const start = Math.floor(rand() * n);
      for (let k = 0; k < blockSize && count < n; k++) {
        sum += values[(start + k) % n];
        count++;
      }
    }
    means.push(sum / count);
  }

  means.sort((a, b) => a - b);
  const loIdx = Math.floor((alpha / 2) * means.length);
  const hiIdx = Math.min(means.length - 1, Math.ceil((1 - alpha / 2) * means.length) - 1);
  const ci95LowUsd = round(means[loIdx], 5);
  const ci95HighUsd = round(means[hiIdx], 5);

  return {
    meanUsd: round(mean, 5),
    ci95LowUsd,
    ci95HighUsd,
    significant: ci95LowUsd > 0 || ci95HighUsd < 0,
    blockSize,
    iterations,
    seed,
  };
}

/** log(gamma(x)) por Lanczos (para el binomial exacto sin desbordar). */
function logGamma(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i] / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function logBinomialPmf(k: number, n: number, p: number): number {
  if (p <= 0) return k === 0 ? 0 : -Infinity;
  if (p >= 1) return k === n ? 0 : -Infinity;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p);
}

/**
 * p-valor exacto bilateral del test binomial (suma de todos los resultados con
 * probabilidad menor o igual a la observada). Estable numericamente via log-gamma.
 */
export function binomialTwoSidedPValue(successes: number, n: number, p0: number): number {
  if (n <= 0) return 1;
  const observed = logBinomialPmf(successes, n, p0);
  let total = 0;
  for (let k = 0; k <= n; k++) {
    const lp = logBinomialPmf(k, n, p0);
    if (lp <= observed + 1e-9) total += Math.exp(lp);
  }
  return Math.min(1, round(total, 6));
}

/**
 * Test unilateral: el win rate observado esta POR DEBAJO del win rate de
 * breakeven (la hipotesis que importa para refutar la ventaja).
 */
export function binomialBelowBreakevenPValue(successes: number, n: number, breakevenWinRatePct: number): number {
  const p0 = Math.max(0.0001, Math.min(0.9999, breakevenWinRatePct / 100));
  if (n <= 0) return 1;
  let total = 0;
  for (let k = 0; k <= successes; k++) total += Math.exp(logBinomialPmf(k, n, p0));
  return Math.min(1, round(total, 6));
}

/** Perfil de riesgo y idoneidad del t-test. */
export function describeRiskProfile(pnls: number[]): RiskProfile {
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const grossWin = wins.reduce((a, v) => a + v, 0);
  const grossLoss = Math.abs(losses.reduce((a, v) => a + v, 0));
  const meanWinUsd = wins.length ? grossWin / wins.length : 0;
  const meanLossUsd = losses.length ? grossLoss / losses.length : 0;
  const worstTradeUsd = n ? Math.min(...pnls) : 0;
  const bestWinUsd = n ? Math.max(...pnls) : 0;

  const sortedLosses = [...losses].sort((a, b) => a - b);
  const worst3 = Math.abs(sortedLosses.slice(0, 3).reduce((a, v) => a + v, 0));
  const lossConcentration3Pct = grossLoss > 0 ? round((worst3 / grossLoss) * 100, 2) : 0;
  const totalResult = pnls.reduce((a, v) => a + v, 0);
  const bestWinSharePct = totalResult !== 0 ? round((bestWinUsd / totalResult) * 100, 2) : 0;

  const reasons: string[] = [];
  if (losses.length > 0 && wins.length > 0 && meanLossUsd > meanWinUsd * 3) {
    reasons.push(
      `Payoff muy asimetrico (avgLoss $${round(meanLossUsd, 4)} vs avgWin $${round(meanWinUsd, 4)}): la media la dominan pocos eventos`
    );
  }
  if (lossConcentration3Pct > 40) {
    reasons.push(`Los 3 peores trades concentran ${lossConcentration3Pct}% de la perdida total`);
  }
  if (Math.abs(bestWinSharePct) > 200) {
    reasons.push(`El mejor trade representa ${bestWinSharePct}% del resultado total`);
  }
  const rho = lag1Autocorrelation(pnls);
  if (Math.abs(rho) > 0.2) {
    reasons.push(
      `Autocorrelacion lag-1 ${round(rho, 3)}: los cierres no son independientes (n efectivo ${round(effectiveSampleSize(n, rho), 1)} de ${n})`
    );
  }

  return {
    n,
    wins: wins.length,
    losses: losses.length,
    winRatePct: n ? round((wins.length / n) * 100, 2) : 0,
    meanWinUsd: round(meanWinUsd, 5),
    meanLossUsd: round(meanLossUsd, 5),
    payoffRatio: meanWinUsd > 0 ? round(meanLossUsd / meanWinUsd, 3) : 0,
    worstTradeUsd: round(worstTradeUsd, 5),
    lossConcentration3Pct,
    bestWinSharePct,
    tTestUnsuitable: reasons.length > 0,
    unsuitabilityReasons: reasons,
  };
}

/**
 * Regla de parada pre-registrada. No decide "ganar": decide cuando la evidencia
 * ya permite cerrar la linea de trading sin esperar los 191 cierres.
 */
export function evaluateStopRule(input: StopRuleInput): StopRuleResult {
  const reasons: string[] = [];
  const { n, expectancyUsd, bootstrap, binomialPValue, minClosedForReading } = input;

  if (n < minClosedForReading) {
    return { action: "CONTINUE", reasons: [`Muestra insuficiente (${n}/${minClosedForReading}) para lectura alguna`] };
  }

  const negativeCertain = bootstrap.ci95HighUsd < 0;
  const wrBelowBreakevenSignificant = binomialPValue < 0.05;

  if (expectancyUsd < 0 && negativeCertain && wrBelowBreakevenSignificant) {
    reasons.push(
      `Expectancy negativa con IC95% enteramente bajo cero [$${bootstrap.ci95LowUsd}, $${bootstrap.ci95HighUsd}]`
    );
    reasons.push(`Win rate por debajo del breakeven con significancia (p=${binomialPValue})`);
    return { action: "REFUTED", reasons };
  }
  if (expectancyUsd < 0 && negativeCertain) {
    reasons.push(
      `Expectancy negativa con IC95% bajo cero [$${bootstrap.ci95LowUsd}, $${bootstrap.ci95HighUsd}] pero el win rate no rechaza el breakeven (p=${binomialPValue})`
    );
    return { action: "STOP_RECOMMENDED", reasons };
  }
  reasons.push(
    `Sin evidencia suficiente: expectancy $${expectancyUsd} con IC95% [$${bootstrap.ci95LowUsd}, $${bootstrap.ci95HighUsd}]`
  );
  return { action: "CONTINUE", reasons };
}

/** ETA al objetivo de cierres segun el ritmo observado. */
export function estimateDaysToTarget(
  closedSoFar: number,
  daysElapsed: number,
  targetClosed: number
): { ratePerDay: number | null; daysNeeded: number | null; etaIso: string | null } {
  if (closedSoFar <= 0 || daysElapsed <= 0) return { ratePerDay: null, daysNeeded: null, etaIso: null };
  const ratePerDay = closedSoFar / daysElapsed;
  const remaining = Math.max(0, targetClosed - closedSoFar);
  if (ratePerDay <= 0) return { ratePerDay: 0, daysNeeded: null, etaIso: null };
  const daysNeeded = remaining / ratePerDay;
  const eta = new Date(Date.now() + daysNeeded * 86_400_000);
  return {
    ratePerDay: round(ratePerDay, 3),
    daysNeeded: round(daysNeeded, 1),
    etaIso: eta.toISOString(),
  };
}

function round(v: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}
