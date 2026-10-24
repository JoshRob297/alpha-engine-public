/**
 * Binance Futures Public/Private Feeder
 * Consulta en tiempo real tasas de fondeo (Funding Rates), Mark Price
 * y métricas de mercado de futuros perpetuos en Binance (/fapi/v1).
 */

export interface FundingRateInfo {
  symbol: string;
  fundingRate: number;       // ej. 0.0001 = 0.01%
  fundingTime: number;       // Timestamp del próximo cobro/pago
  aprAnnualizedPct: number;  // (fundingRate * 3 * 365) * 100
  markPrice: number;
}

export class BinanceFuturesFeeder {
  private static cachedFunding: Map<string, { data: FundingRateInfo; ts: number }> = new Map();
  private static CACHE_TTL_MS = 60_000; // 1 minuto de cache

  /**
   * Obtiene la tasa de fondeo actual y el Mark Price para un símbolo de futuros (ej. "BTCUSDT", "ETHUSDT").
   */
  public static async fetchCurrentFundingRate(symbol: string): Promise<FundingRateInfo | null> {
    const cleanSymbol = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const now = Date.now();

    const cached = this.cachedFunding.get(cleanSymbol);
    if (cached && now - cached.ts < this.CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      // 1. Consultar Mark Price y Funding Rate estimado en Binance Futures API pública
      const url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${cleanSymbol}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        console.warn(`[FUTURES FEEDER] Error HTTP ${res.status} para ${cleanSymbol}`);
        return null;
      }

      const data = await res.json();
      const fundingRate = parseFloat(data.lastFundingRate || "0.0001");
      const markPrice = parseFloat(data.markPrice || "0");
      const fundingTime = parseInt(data.nextFundingTime || "0", 10);
      const aprAnnualizedPct = fundingRate * 3 * 365 * 100;

      const result: FundingRateInfo = {
        symbol: cleanSymbol,
        fundingRate,
        fundingTime,
        aprAnnualizedPct,
        markPrice,
      };

      this.cachedFunding.set(cleanSymbol, { data: result, ts: now });
      return result;
    } catch (err: any) {
      console.warn(`[FUTURES FEEDER ERROR] Fallo consultando ${cleanSymbol}:`, err?.message || err);
      return null;
    }
  }

  /**
   * Consulta en lote las tasas de fondeo para múltiples símbolos.
   */
  public static async fetchBatchFundingRates(symbols: string[]): Promise<Record<string, FundingRateInfo>> {
    const results: Record<string, FundingRateInfo> = {};
    const promises = symbols.map(async (s) => {
      const info = await this.fetchCurrentFundingRate(s);
      if (info) results[info.symbol] = info;
    });

    await Promise.all(promises);
    return results;
  }
}
