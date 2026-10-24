/**
 * Estadística de Poder Predictivo (Fase 2 — Validación de señal)
 * Información mutua vía rango (Spearman IC) y AUC (Mann-Whitney) para medir
 * si una señal predice un resultado futuro mejor que un baseline.
 */

/** Ranking promedio (con empates) de un vector. */
export function rank(xs: number[]): number[] {
  const idx = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(xs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based
    for (let k = i; k <= j; k++) ranks[idx[k].i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

/** Coeficiente de Pearson. */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; syy += ys[i] * ys[i];
  }
  const cov = sxy / n - (sx / n) * (sy / n);
  const vx = sxx / n - (sx / n) ** 2;
  const vy = syy / n - (sy / n) ** 2;
  const denom = Math.sqrt(vx * vy);
  return denom > 0 ? cov / denom : 0;
}

/** Information Coefficient (Spearman): correlación de rangos señal vs resultado. */
export function spearmanIC(signal: number[], outcome: number[]): number {
  const n = Math.min(signal.length, outcome.length);
  if (n < 3) return 0;
  return parseFloat(pearson(rank(signal.slice(0, n)), rank(outcome.slice(0, n))).toFixed(4));
}

/**
 * AUC (área bajo ROC) por fórmula de Mann-Whitney.
 * @param scores puntuaciones (mayor = más probable positivo)
 * @param labels 1 = positivo, 0 = negativo
 */
export function auc(scores: number[], labels: number[]): number {
  const pairs: Array<{ s: number; l: number }> = [];
  for (let i = 0; i < scores.length; i++) pairs.push({ s: scores[i], l: labels[i] });
  const pos = pairs.filter((p) => p.l === 1).map((p) => p.s);
  const neg = pairs.filter((p) => p.l === 0).map((p) => p.s);
  if (pos.length === 0 || neg.length === 0) return 0.5;

  // Ranking global; suma de rangos de los positivos.
  const all = [...pos, ...neg];
  const r = rank(all);
  const sumPosRanks = r.slice(0, pos.length).reduce((a, b) => a + b, 0);
  const nP = pos.length;
  const nN = neg.length;
  const u = sumPosRanks - (nP * (nP + 1)) / 2;
  return parseFloat((u / (nP * nN)).toFixed(4));
}

export interface SignalEval {
  n: number;
  ic: number;
  auc: number;
}

/**
 * Evalúa una señal contra un resultado continuo y un umbral de "evento adverso".
 * @param adverseSiNegativo true si el evento adverso es resultado negativo (ej. retorno < -thr).
 */
export function evaluateSignal(
  signal: number[],
  outcome: number[],
  adverseThreshold: number,
  adverseSiNegativo = true
): SignalEval {
  const n = Math.min(signal.length, outcome.length);
  const s = signal.slice(0, n);
  const o = outcome.slice(0, n);
  const ic = spearmanIC(s, o);
  const labels = o.map((v) => (adverseSiNegativo ? (v < -Math.abs(adverseThreshold) ? 1 : 0) : v > Math.abs(adverseThreshold) ? 1 : 0));
  // Para predecir evento adverso negativo, mayor señal debería implicar mayor probabilidad.
  const score = adverseSiNegativo ? s.map((v) => v) : s.map((v) => v);
  return { n, ic, auc: auc(score, labels) };
}
