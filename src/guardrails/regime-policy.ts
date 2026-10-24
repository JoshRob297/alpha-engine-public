/**
 * Política Unificada de Régimen Causal y Perfiles de Activo (Regime Policy)
 * Fuente de verdad institucional para la modulación causal de:
 * 1. Ponderación macro de capital (Reserva Stablecoin vs CEX Spot vs DEX LP)
 * 2. Criterios de toma de beneficios y gobernanza de salidas (TP1, TP2, Front-Run)
 *    diferenciados por perfil de activo (ANCHOR, BETA, FIAT).
 * 
 * Regla de Front-Run Universal:
 * El piso mínimo de escape con beneficio (frontRunMin) es ágil (+0.65% para CEX, +0.25% para FIAT)
 * para asegurar cualquier ganancia neta ante peligro inminente en el libro de órdenes.
 */

export type AssetProfile = "ANCHOR" | "BETA" | "FIAT";

export interface RegimePolicy {
  /** Porcentaje del capital total asignado a la reserva líquida en stablecoin (USDT/USDC) */
  fiatPct: number;
  /** Proporción del capital activo (1 - fiatPct) asignada a mallas spot CEX (BTC, SOL, etc.) */
  cexPct: number;
  /** Proporción del capital activo (1 - fiatPct) asignada a provisión DEX LP (Aerodrome) */
  dexPct: number;
  /** Umbral porcentual de ganancia mínima requerida para ejecutar TP1 parcial (DCA Out 1) */
  tp1Threshold: number;
  /** Umbral porcentual de ganancia mínima requerida para ejecutar TP2 parcial (DCA Out 2) */
  tp2Threshold: number;
  /** Ganancia mínima requerida para que Front-Run Exit liquide antes de un muro tóxico */
  frontRunMin: number;
  /** Descripción causal para telemetría y dashboard */
  rationale: string;
}

/**
 * Clasifica dinámicamente cualquier activo según su perfil cuantitativo
 * sin depender de listas estáticas cerradas.
 */
export function getAssetProfile(ticker: string, volatility?: number): AssetProfile {
  const t = ticker.toUpperCase().replace(/[^A-Z]/g, "");
  if (t === "USD" || t === "USDC" || t === "USDT") return "FIAT";
  if (typeof volatility === "number") {
    return volatility >= 0.45 ? "BETA" : "ANCHOR";
  }
  if (t === "BTC" || t === "ETH") return "ANCHOR";
  return "BETA"; // Cualquier nuevo activo elegido por Research (SOL, XRP, AVAX, SUI...) entra como BETA
}

export function getRegimePolicy(regime: string, tickerOrProfile: string | AssetProfile = "ANCHOR"): RegimePolicy {
  const profile: AssetProfile =
    tickerOrProfile === "ANCHOR" || tickerOrProfile === "BETA" || tickerOrProfile === "FIAT"
      ? tickerOrProfile
      : getAssetProfile(tickerOrProfile);

  // 1. Perfil FIAT (Reserva Stablecoin - Maker Fee = 0.60%, Roundtrip = 1.20%)
  if (profile === "FIAT") {
    switch (regime) {
      case "AGGRESSIVE_ACCUMULATION":
        return {
          fiatPct: 0.30,
          cexPct: 0.65,
          dexPct: 0.35,
          tp1Threshold: 1.80,
          tp2Threshold: 2.40,
          frontRunMin: 1.35,
          rationale: "Régimen AGGRESSIVE (FIAT): TP1 a +1.80% (+0.60% neto post-fee 1.20%).",
        };
      case "DEFENSIVE_STRESS":
        return {
          fiatPct: 0.50,
          cexPct: 0.40,
          dexPct: 0.60,
          tp1Threshold: 1.40,
          tp2Threshold: 1.80,
          frontRunMin: 1.25,
          rationale: "Régimen DEFENSIVE (FIAT): TP1 a +1.40% (+0.20% neto post-fee 1.20%).",
        };
      case "BALANCED_RANGE":
      default:
        return {
          fiatPct: 0.40,
          cexPct: 0.50,
          dexPct: 0.50,
          tp1Threshold: 1.60,
          tp2Threshold: 2.10,
          frontRunMin: 1.30,
          rationale: "Régimen BALANCED (FIAT): TP1 a +1.60% (+0.40% neto post-fee 1.20%).",
        };
    }
  }

  // 2. Perfil BETA (Activos de Alto Momentum y Volatilidad Explosiva: SOL, XRP, AVAX, etc.)
  if (profile === "BETA") {
    switch (regime) {
      case "AGGRESSIVE_ACCUMULATION":
        return {
          fiatPct: 0.30,
          cexPct: 0.65,
          dexPct: 0.35,
          tp1Threshold: 4.00,
          tp2Threshold: 5.50,
          frontRunMin: 0.65,
          rationale: "Régimen AGGRESSIVE (BETA): TP1 ampliado a +4.00% con escape ágil (+0.65%).",
        };
      case "DEFENSIVE_STRESS":
        return {
          fiatPct: 0.50,
          cexPct: 0.40,
          dexPct: 0.60,
          tp1Threshold: 2.40,
          tp2Threshold: 3.50,
          frontRunMin: 0.60,
          rationale: "Régimen DEFENSIVE (BETA): TP1 ágil al +2.40% con escape proactivo (+0.60%).",
        };
      case "BALANCED_RANGE":
      default:
        return {
          fiatPct: 0.40,
          cexPct: 0.50,
          dexPct: 0.50,
          tp1Threshold: 3.40,
          tp2Threshold: 4.80,
          frontRunMin: 0.65,
          rationale: "Régimen BALANCED (BETA): TP1 calibrado al +3.40% con escape ágil (+0.65%).",
        };
    }
  }

  // 3. Perfil ANCHOR (Activos Institucionales de Gran Liquidez: BTC, ETH)
  // Re-calibrado con la nueva geometría causal: TP1 +2.40%, TP2 +3.80% para Risk/Reward positivo frente a stops
  switch (regime) {
    case "AGGRESSIVE_ACCUMULATION":
      return {
        fiatPct: 0.30,
        cexPct: 0.65,
        dexPct: 0.35,
        tp1Threshold: 2.80, // Expansión en impulso fuerte
        tp2Threshold: 4.20,
        frontRunMin: 0.85,
        rationale: "Régimen AGGRESSIVE (ANCHOR): TP1 expandido al +2.80% con escape proactivo (+0.85%).",
      };

    case "DEFENSIVE_STRESS":
      return {
        fiatPct: 0.50,
        cexPct: 0.40,
        dexPct: 0.60,
        tp1Threshold: 1.80, // Defensa ágil en estrés
        tp2Threshold: 2.60,
        frontRunMin: 0.70,
        rationale: "Régimen DEFENSIVE (ANCHOR): TP1 defensivo al +1.80% para asegurar capital rápido.",
      };

    case "BALANCED_RANGE":
    default:
      return {
        fiatPct: 0.40,
        cexPct: 0.50,
        dexPct: 0.50,
        tp1Threshold: 2.40, // Nueva geometría institucional: cubre con holgura el stop sintético (-2.5%)
        tp2Threshold: 3.80,
        frontRunMin: 0.80,
        rationale: "Régimen BALANCED (ANCHOR): TP1 calibrado a +2.40% con TP2 a +3.80% (Risk/Reward positivo).",
      };
  }
}
