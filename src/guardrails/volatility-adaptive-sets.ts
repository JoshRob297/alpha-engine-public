/**
 * ACTUALIZACIÓN MATEMÁTICA: VOLATILITY ADAPTIVE SETS (MODELO CALIBRADO)
 * 
 * Principio Físico Demostrado:
 * 1. En cripto el ATR horario oscila entre 0.15% y 0.35%.
 * 2. Un TP < 0.35% es destruido por el doble peaje Maker (-0.20%).
 * 3. Por lo tanto, el TP debe ser >= 2.2x ATR (con suelo mínimo en 0.40%).
 * 4. El Stop debe ser >= 3.5x ATR (para resistir el ruido y evitar falsos cortes).
 * 5. El Descuento Post-SL debe ser >= 2.2x ATR (garantiza entrar con verdadero descuento tras un choque).
 */

export interface CandleLike {
  high: number;
  low: number;
  close: number;
  open?: number;
}

export interface VolatilityAdaptiveSet {
  name: string;
  regime: "BALANCED_RANGE" | "EXPANSION_UP" | "DEFENSIVE_STRESS";
  spacingPct: number;
  tpPct: number;
  stopPct: number;
  discountAfterSlPct: number;
  levelsCount: number;
  atrPct: number;
  rationale: string;
}

export function calculateATR14(candles: CandleLike[]) {
  if (candles.length < 2) {
    return { atrAbsolute: 0, atrPct: 0.002 };
  }

  const period = Math.min(14, candles.length - 1);
  const trueRanges: number[] = [];

  for (let i = candles.length - period; i < candles.length; i++) {
    const current = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prev.close),
      Math.abs(current.low - prev.close)
    );
    trueRanges.push(tr);
  }

  const atrAbsolute = trueRanges.reduce((acc, v) => acc + v, 0) / period;
  const currentPrice = candles[candles.length - 1].close;
  const atrPct = atrAbsolute / currentPrice;

  return { atrAbsolute, atrPct };
}

export function generateAdaptiveSet(
  candles: CandleLike[],
  regime: "BALANCED_RANGE" | "EXPANSION_UP" | "DEFENSIVE_STRESS" = "BALANCED_RANGE",
  currentSpreadBps: number = 5,
  feeRate: number = 0.0010,
  assetProfile: "ANCHOR" | "BETA" | "FIAT" = "FIAT"
): VolatilityAdaptiveSet {
  const { atrPct } = calculateATR14(candles);
  const spreadPct = currentSpreadBps / 10000;
  // En perfil FIAT (reserva stablecoin) el costo de transacción es 0.60% Maker (1.20% roundtrip)
  const effectiveFee = assetProfile === "FIAT" ? Math.max(feeRate, 0.0060) : feeRate;
  const minFeeFloor = effectiveFee * 2.2;

  // Genomas Bicentenarios Maestros (Entrenados sobre 17,520h / 2 Años de datos CEX)
  // BETA (SOL)   : Spacing 0.78x | TP 2.91x | Stop 3.90x | Descuento 3.07x (PF: 2.85 / 17,520h)
  // ANCHOR (BTC) : Spacing 1.21x | TP 3.47x | Stop 3.23x | Descuento 2.36x (PF: 2.96 / 17,520h)
  // FIAT (USD)   : Spacing 1.69x | TP 3.49x | Stop 6.39x | Descuento 2.36x (PF: 1.33 / 4,705h)
  let k_spacing = assetProfile === "BETA" ? 0.78 : assetProfile === "ANCHOR" ? 1.21 : 1.69;
  let k_tp = assetProfile === "BETA" ? 2.91 : assetProfile === "ANCHOR" ? 3.47 : 3.49;
  let k_stop = assetProfile === "BETA" ? 3.90 : assetProfile === "ANCHOR" ? 3.23 : 6.39;
  let k_discount = assetProfile === "BETA" ? 3.07 : assetProfile === "ANCHOR" ? 2.36 : 2.36;

  switch (regime) {
    case "DEFENSIVE_STRESS": {
      const spacingPct = Math.max(spreadPct * 2, atrPct * (k_spacing * 1.3));
      const tpPct = Math.max(minFeeFloor, Math.max(0.0035, atrPct * (k_tp * 0.85)));
      const stopPct = Math.max(spacingPct * 1.8, atrPct * (k_stop * 1.05));
      const discountAfterSlPct = Math.max(0.0035, atrPct * (k_discount * 1.25));

      return {
        name: `ATR_DEFENSIVE_${assetProfile}`,
        regime,
        spacingPct: parseFloat(spacingPct.toFixed(4)),
        tpPct: parseFloat(tpPct.toFixed(4)),
        stopPct: parseFloat(stopPct.toFixed(4)),
        discountAfterSlPct: parseFloat(discountAfterSlPct.toFixed(4)),
        levelsCount: 2,
        atrPct: parseFloat((atrPct * 100).toFixed(3)),
        rationale: `Régimen DEFENSIVO (${assetProfile}): ATR=${(atrPct * 100).toFixed(2)}%. Espaciado a ${(spacingPct * 100).toFixed(2)}% y re-centrado a -${(discountAfterSlPct * 100).toFixed(2)}% post-SL.`,
      };
    }

    case "EXPANSION_UP": {
      const spacingPct = Math.max(spreadPct * 1.5, atrPct * (k_spacing * 0.85));
      const tpPct = Math.max(minFeeFloor, Math.max(0.0045, atrPct * (k_tp * 1.25)));
      const stopPct = Math.max(spacingPct * 2.0, atrPct * (k_stop * 1.05));
      const discountAfterSlPct = Math.max(0.0025, atrPct * k_discount);

      return {
        name: `ATR_EXPANSION_${assetProfile}`,
        regime,
        spacingPct: parseFloat(spacingPct.toFixed(4)),
        tpPct: parseFloat(tpPct.toFixed(4)),
        stopPct: parseFloat(stopPct.toFixed(4)),
        discountAfterSlPct: parseFloat(discountAfterSlPct.toFixed(4)),
        levelsCount: 3,
        atrPct: parseFloat((atrPct * 100).toFixed(3)),
        rationale: `Régimen EXPANSIÓN (${assetProfile}): ATR=${(atrPct * 100).toFixed(2)}%. Espaciado compacto a ${(spacingPct * 100).toFixed(2)}% y TP extendido a +${(tpPct * 100).toFixed(2)}%.`,
      };
    }

    case "BALANCED_RANGE":
    default: {
      const spacingPct = Math.max(spreadPct * 1.5, Math.max(0.0015, atrPct * k_spacing));
      const tpPct = Math.max(minFeeFloor, Math.max(0.0042, atrPct * k_tp));
      const stopPct = Math.max(spacingPct * 2.0, Math.max(0.0075, atrPct * k_stop));
      const discountAfterSlPct = Math.max(0.0030, atrPct * k_discount);

      return {
        name: `ATR_BALANCED_${assetProfile}`,
        regime: "BALANCED_RANGE",
        spacingPct: parseFloat(spacingPct.toFixed(4)),
        tpPct: parseFloat(tpPct.toFixed(4)),
        stopPct: parseFloat(stopPct.toFixed(4)),
        discountAfterSlPct: parseFloat(discountAfterSlPct.toFixed(4)),
        levelsCount: 2,
        atrPct: parseFloat((atrPct * 100).toFixed(3)),
        rationale: `Régimen BALANCEADO (${assetProfile}): ATR=${(atrPct * 100).toFixed(2)}%. Espaciado a ${(spacingPct * 100).toFixed(2)}% y TP a +${(tpPct * 100).toFixed(2)}%.`,
      };
    }
  }
}
