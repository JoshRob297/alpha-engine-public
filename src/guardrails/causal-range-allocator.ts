/**
 * Optimizador de Rangos Concentrados Causal (Jev + Sets) para DEX
 * Modula el ancho y la asimetría del rango de liquidez en Base L2 (Aerodrome Slipstream)
 * según el régimen macroeconómico determinado por TypeSafe Jev.
 */

export interface ConcentratedRangeBounds {
  lowerPrice: number;
  upperPrice: number;
  widthPct: number;
  asymmetryRatio: number;
  description: string;
}

/**
 * Calcula los límites inferior y superior del rango concentrado
 * @param currentPrice Precio actual del par en el pool
 * @param jevRegime Régimen de mercado ('AGGRESSIVE_ACCUMULATION' | 'BALANCED_RANGE' | 'DEFENSIVE_STRESS')
 * @param riskWeight Ponderación de riesgo del activo (0.1 a 1.0)
 * @param temperatureMultiplier Multiplicador térmico del mercado (0.75x a 1.45x)
 */
export function calculateCausalConcentratedRange(
  currentPrice: number,
  jevRegime = "BALANCED_RANGE",
  riskWeight = 0.5,
  temperatureMultiplier = 1.0
): ConcentratedRangeBounds {
  let lowerPct: number;
  let upperPct: number;
  let description: string;

  switch (jevRegime) {
    case "DEFENSIVE_STRESS":
      // Régimen de alto estrés/volatilidad: Rango amplio simétrico (+-12%) para evitar impermanent loss y churn
      lowerPct = 0.12;
      upperPct = 0.12;
      description = "DEFENSIVE_WIDE_RANGE (+-12.0%)";
      break;

    case "AGGRESSIVE_ACCUMULATION":
      // Régimen alcista con impulso comprador: Rango asimétrico (-4% a la baja / +8.5% al alza)
      lowerPct = 0.04;
      upperPct = 0.085;
      description = "AGGRESSIVE_ASYMMETRIC_RANGE (-4.0% / +8.5%)";
      break;

    case "BALANCED_RANGE":
    default:
      // Régimen de rango medio / balanceado: Rango óptimo (+-6.5%) para máxima captura de comisiones pasivas
      lowerPct = 0.065;
      upperPct = 0.065;
      description = "BALANCED_FEE_MAXIMIZER (+-6.5%)";
      break;
  }

  // Modulación adicional por paridad de riesgo
  const riskAdjustment = (1 - riskWeight) * 0.02; // Hasta +2% de margen si el activo es más volátil/satélite
  
  // Modulación térmica del rango (0.75x a 1.45x)
  const clampedTemp = Math.max(0.75, Math.min(1.45, temperatureMultiplier));
  const finalLowerPct = (lowerPct + riskAdjustment) * clampedTemp;
  const finalUpperPct = (upperPct + riskAdjustment) * clampedTemp;

  const lowerPrice = currentPrice * (1 - finalLowerPct);
  const upperPrice = currentPrice * (1 + finalUpperPct);
  const widthPct = (finalLowerPct + finalUpperPct) * 100;
  const asymmetryRatio = finalUpperPct / finalLowerPct;

  return {
    lowerPrice: parseFloat(lowerPrice.toFixed(6)),
    upperPrice: parseFloat(upperPrice.toFixed(6)),
    widthPct: parseFloat(widthPct.toFixed(2)),
    asymmetryRatio: parseFloat(asymmetryRatio.toFixed(2)),
    description: `${description} [Temp: ${clampedTemp.toFixed(2)}x]`,
  };
}
