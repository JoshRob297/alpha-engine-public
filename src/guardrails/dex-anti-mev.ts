/**
 * GOBERNANZA ANTI-MEV Y REBALANCEO ESCALONADO PARA DEX (BASE L2)
 * Protege las transacciones en Aerodrome Slipstream contra Sandwich Attacks y Front-Running.
 */

export interface DexAntiMevConfig {
  maxAllowedSlippageBps: number; // Máximo 15 bps (0.15%)
  preventiveRebalanceThresholdPct: number; // 85% del borde del rango
}

export const DEFAULT_DEX_ANTI_MEV_CONFIG: DexAntiMevConfig = {
  maxAllowedSlippageBps: 15, // 0.15% estricto anti-sandwich
  preventiveRebalanceThresholdPct: 0.85, // Rebalanceo preventivo al 85% del rango
};

export interface DexPositionBounds {
  lowerPrice: number;
  upperPrice: number;
}

export function evaluateDexPreventiveTrigger(
  currentPrice: number,
  bounds: DexPositionBounds,
  config: DexAntiMevConfig = DEFAULT_DEX_ANTI_MEV_CONFIG
): { shouldRebalancePreventively: boolean; triggerReason: string | null } {
  const rangeSpan = bounds.upperPrice - bounds.lowerPrice;
  const lowerThreshold = bounds.lowerPrice + rangeSpan * (1 - config.preventiveRebalanceThresholdPct);
  const upperThreshold = bounds.upperPrice - rangeSpan * (1 - config.preventiveRebalanceThresholdPct);

  if (currentPrice <= lowerThreshold) {
    return {
      shouldRebalancePreventively: true,
      triggerReason: "PREVENTIVE_LOWER_EDGE_85_REACHED",
    };
  }

  if (currentPrice >= upperThreshold) {
    return {
      shouldRebalancePreventively: true,
      triggerReason: "PREVENTIVE_UPPER_EDGE_85_REACHED",
    };
  }

  return { shouldRebalancePreventively: false, triggerReason: null };
}

/**
 * Calcula el amountOutMinimum estricto para evitar pérdidas por arbitraje MEV
 */
export function calculateAntiMevAmountOutMin(
  expectedAmountOut: bigint,
  maxSlippageBps: number = 15
): bigint {
  const slippageFactor = 10000n - BigInt(maxSlippageBps);
  return (expectedAmountOut * slippageFactor) / 10000n;
}
