/**
 * Order Flow Imbalance (OFI) & Book Depth Analyzer
 * Calcula la presion neta del libro de ordenes en los primeros niveles (L2)
 * para detectar evaporacion de liquidez compradora antes de caidas de precio.
 */

export interface OrderBookLevelRaw {
  price: number;
  amount: number;
}

export interface BookDepthSnapshot {
  bids: OrderBookLevelRaw[];
  asks: OrderBookLevelRaw[];
  timestamp: number;
}

export interface OFIMetrics {
  ofiScore: number; // Normalizado entre -1.0 (presion vendedora extrema) y +1.0 (presion compradora)
  top3BidVolumeUsd: number;
  top3AskVolumeUsd: number;
  depthRatio: number; // Ratio bids / (bids + asks)
  isLiquidityEvaporating: boolean; // True si el lado comprador cayo bruscamente
}

export class OrderFlowImbalanceAnalyzer {
  private lastSnapshot: BookDepthSnapshot | null = null;

  /**
   * Calcula el OFI ponderado por distancia de los primeros 3 niveles
   */
  public analyze(current: BookDepthSnapshot): OFIMetrics {
    const topBids = current.bids.slice(0, 3);
    const topAsks = current.asks.slice(0, 3);

    // Calcular volumen total en los primeros 3 niveles
    let top3BidVol = 0;
    let top3AskVol = 0;

    topBids.forEach((b, idx) => {
      const weight = 1 / (idx + 1); // Ponderacion: Nivel 1 pesa 1.0, Nivel 2 pesa 0.5, Nivel 3 pesa 0.33
      top3BidVol += b.price * b.amount * weight;
    });

    topAsks.forEach((a, idx) => {
      const weight = 1 / (idx + 1);
      top3AskVol += a.price * a.amount * weight;
    });

    const totalDepth = top3BidVol + top3AskVol;
    const depthRatio = totalDepth > 0 ? top3BidVol / totalDepth : 0.5;

    let ofiRaw = top3BidVol - top3AskVol;
    let isLiquidityEvaporating = false;

    // Comparar con el snapshot previo para detectar delta y evaporacion
    if (this.lastSnapshot) {
      const prevBidsVol = this.lastSnapshot.bids.slice(0, 3).reduce((acc, b) => acc + b.price * b.amount, 0);
      const curBidsVol = topBids.reduce((acc, b) => acc + b.price * b.amount, 0);

      // Si el volumen comprador cayo mas del 40% en una ventana corta sin trades proporcionales
      if (curBidsVol < prevBidsVol * 0.60) {
        isLiquidityEvaporating = true;
      }
    }

    this.lastSnapshot = current;

    // Normalizar OFI entre -1.0 y 1.0
    const ofiScore = totalDepth > 0 ? (top3BidVol - top3AskVol) / totalDepth : 0;

    return {
      ofiScore: parseFloat(ofiScore.toFixed(4)),
      top3BidVolumeUsd: parseFloat(top3BidVol.toFixed(2)),
      top3AskVolumeUsd: parseFloat(top3AskVol.toFixed(2)),
      depthRatio: parseFloat(depthRatio.toFixed(4)),
      isLiquidityEvaporating,
    };
  }
}
