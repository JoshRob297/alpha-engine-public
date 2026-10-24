/**
 * Monitor Dinámico de Temperatura de Mercado (Agnóstico al Activo)
 * Compara la volatilidad reciente (ATR 14h) frente a la volatilidad histórica base (2 años).
 * 
 * Regímenes de Temperatura:
 * - COLD (< 0.85x): Baja volatilidad. Comprime spacing para capturar micro-rebotes (+fills).
 * - BALANCED (0.85x - 1.15x): Volatilidad normal. Utiliza los multiplicadores base del genoma.
 * - HOT (> 1.15x): Expansión de volatilidad / velas agresivas. Ensancha spacing y stop
 *   para evitar ser sacado prematuramente por mechazos de ruido.
 */

export interface MarketTemperatureState {
  ticker: string;
  recentAtrPct: number;
  baseAtrPct: number;
  temperatureRatio: number;
  regime: "COLD" | "BALANCED" | "HOT";
  spacingMultiplier: number;
  stopMultiplier: number;
  tpMultiplier: number;
}

export class MarketTemperatureMonitor {
  /**
   * Calcula el True Range relativo (TR / close) para una ventana de precios
   */
  public static calculateRecentAtrPct(priceHistory: number[], period = 14): number {
    if (!priceHistory || priceHistory.length < 2) return 0.008; // Fallback prudente (0.8%)
    
    const trs: number[] = [];
    const count = Math.min(priceHistory.length, period + 1);
    const startIdx = priceHistory.length - count;

    for (let i = startIdx + 1; i < priceHistory.length; i++) {
      const prev = priceHistory[i - 1];
      const curr = priceHistory[i];
      const tr = Math.abs(curr - prev) / curr;
      trs.push(tr);
    }

    if (trs.length === 0) return 0.008;
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  }

  /**
   * Evalúa la temperatura y genera los multiplicadores relativos
   * @param ticker Ticker del activo
   * @param priceHistory Buffer de precios recientes (mínimo 14 muestras de 1h)
   * @param historicalBaseAtr ATR histórico de largo plazo (de 2 años en evolved_atr_genomes o serie)
   */
  public static getTemperature(
    ticker: string,
    priceHistory: number[],
    historicalBaseAtr?: number
  ): MarketTemperatureState {
    const recentAtrPct = this.calculateRecentAtrPct(priceHistory, 14);
    
    // Si no se suministra ATR base de 2 años, usar benchmark de referencia por categoría
    const baseAtrPct = historicalBaseAtr && historicalBaseAtr > 0
      ? historicalBaseAtr
      : ticker === "BTC" ? 0.0054 : ticker === "SOL" ? 0.0092 : 0.012;

    const rawRatio = recentAtrPct / baseAtrPct;
    // Acotar el ratio de ajuste entre 0.75x (compresión máxima) y 1.45x (expansión máxima de seguridad)
    const clampedRatio = Math.max(0.75, Math.min(1.45, rawRatio));

    let regime: "COLD" | "BALANCED" | "HOT" = "BALANCED";
    if (clampedRatio < 0.85) regime = "COLD";
    else if (clampedRatio > 1.15) regime = "HOT";

    // En mercados HOT: Spacing y Stop se ensanchan para dar espacio; TP se estira para capturar la expansión
    // En mercados COLD: Spacing se aprieta para hacer más ping-pong; Stop se ajusta
    const spacingMultiplier = parseFloat(clampedRatio.toFixed(2));
    const stopMultiplier = parseFloat((clampedRatio > 1.0 ? clampedRatio : 1.0).toFixed(2));
    const tpMultiplier = parseFloat((clampedRatio > 1.1 ? clampedRatio * 1.05 : clampedRatio).toFixed(2));

    return {
      ticker,
      recentAtrPct,
      baseAtrPct,
      temperatureRatio: parseFloat(rawRatio.toFixed(2)),
      regime,
      spacingMultiplier,
      stopMultiplier,
      tpMultiplier,
    };
  }
}
