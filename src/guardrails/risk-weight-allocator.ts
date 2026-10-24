export interface AssetCandidate {
  ticker: string;
  name?: string;
  volatility?: number; // Varianza o volatilidad anualizada / semanal (0.01 - 2.0)
  sortino?: number;    // Sortino ratio histórico
  liquidityScore?: number; // 0.1 a 1.0 (profundidad de libro o TVL relativo)
  isAnchor?: boolean;  // True para activos de reserva / blue-chips (ej. BTC, WETH-cbBTC)
}

export interface WeightAllocationResult {
  weights: Record<string, number>; // Ticker -> Ponderación normalizada (suma 1.0)
  cashReservePct: number;          // Porcentaje sugerido de reserva fiduciaria líquida (0.35 - 0.50)
  rationale: string;
}

/**
 * Optimizador de Paridad de Riesgo Causal para N Activos
 * Elimina cualquier constante fija (70/30, 80/20) y calcula
 * la frontera de ponderación óptima mediante Sortino, Volatilidad y Liquidez.
 */
export function calculateDynamicRiskWeights(
  candidates: AssetCandidate[],
  marketRegime: 'ACCUMULATE' | 'DEFENSIVE' | 'VOLATILE_CRASH' | 'BALANCED_RANGE' = 'BALANCED_RANGE'
): WeightAllocationResult {
  if (candidates.length === 0) {
    return { weights: {}, cashReservePct: 0.40, rationale: 'No candidates provided' };
  }

  // 1. Determinar Reserva Fiduciaria según Régimen de Estrés
  let cashReservePct = 0.40;
  if (marketRegime === 'VOLATILE_CRASH') {
    cashReservePct = 0.50; // Elevar colchón de liquidez ante liquidaciones
  } else if (marketRegime === 'ACCUMULATE') {
    cashReservePct = 0.35; // Desplegar más capital en zonas de descuento
  }

  if (candidates.length === 1) {
    const single = candidates[0].ticker;
    return {
      weights: { [single]: 1.0 },
      cashReservePct,
      rationale: `Single asset allocation for ${single} under ${marketRegime} regime.`
    };
  }

  // 2. Calcular Puntaje de Calidad Causal por Activo
  // Score = (Sortino * Liquidity) / (Volatilidad * BetaPenalty)
  const scores: Record<string, number> = {};
  let totalScore = 0;

  for (const c of candidates) {
    const vol = Math.max(c.volatility || 0.30, 0.05);
    const sortino = Math.max(c.sortino || 1.2, 0.2);
    const liq = Math.max(c.liquidityScore || 0.8, 0.1);
    const anchorBonus = c.isAnchor || c.ticker.includes("BTC") || c.ticker.includes("ETH") ? 1.5 : 1.0;

    const rawScore = (sortino * liq * anchorBonus) / vol;
    scores[c.ticker] = rawScore;
    totalScore += rawScore;
  }

  // 3. Normalización con Restricción de Concentración Máxima
  // Ningún activo individual supera el 75% si hay múltiples activos
  // Ningún activo no-ancla supera el 35% del total
  const unconstrainedWeights: Record<string, number> = {};
  for (const c of candidates) {
    unconstrainedWeights[c.ticker] = scores[c.ticker] / (totalScore || 1);
  }

  const finalWeights: Record<string, number> = {};
  let allocatedWeight = 0;

  for (const c of candidates) {
    const isAnchor = c.isAnchor || c.ticker.includes("BTC") || c.ticker.includes("ETH");
    const maxCap = isAnchor ? 0.75 : 0.35;
    const minFloor = 0.10; // Garantizar participación mínima a todo activo aprobado

    let w = Math.min(Math.max(unconstrainedWeights[c.ticker], minFloor), maxCap);
    finalWeights[c.ticker] = w;
    allocatedWeight += w;
  }

  // Re-normalizar para que sume exactamente 1.0
  const normalizedWeights: Record<string, number> = {};
  for (const ticker of Object.keys(finalWeights)) {
    normalizedWeights[ticker] = parseFloat((finalWeights[ticker] / allocatedWeight).toFixed(4));
  }

  return {
    weights: normalizedWeights,
    cashReservePct,
    rationale: `Dynamic causal parity across ${candidates.length} assets. Regime: ${marketRegime}. Total normalized.`
  };
}
