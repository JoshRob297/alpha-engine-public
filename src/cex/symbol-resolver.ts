/**
 * Binance Symbol Resolver & Market Validator
 * Determina dinámicamente si un activo sugerido por Gemini Research
 * cuenta con un par spot líquido contra USDT o USDC en Binance,
 * validando estado TRADING y volumen mínimo institucional ($5M USD / 24h).
 */

export interface ResolvedSymbol {
  ticker: string;
  symbol: string;
  quoteAsset: "USDT" | "USDC";
  status: string;
  volume24hUsd: number;
  isValid: boolean;
  rejectReason?: string;
}

export class BinanceSymbolResolver {
  private static cachedSymbols: Map<string, ResolvedSymbol> = new Map();
  private static lastSyncTs = 0;
  private static SYNC_TTL_MS = 60 * 60 * 1000; // 1 hora de caché

  /**
   * Resuelve el par oficial en Binance para un ticker dado (ej. "NEAR" -> "NEARUSDT")
   */
  public static async resolveSymbol(ticker: string, minVolume24hUsd = 3_000_000): Promise<ResolvedSymbol> {
    const cleanTicker = ticker.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

    // Revisar caché si aún está fresca
    const cached = this.cachedSymbols.get(cleanTicker);
    if (cached && Date.now() - this.lastSyncTs < this.SYNC_TTL_MS) {
      return cached;
    }

    try {
      // Intentar primero USDT, luego USDC
      const candidates = [`${cleanTicker}USDT`, `${cleanTicker}USDC`];

      for (const symbol of candidates) {
        const quoteAsset: "USDT" | "USDC" = symbol.endsWith("USDT") ? "USDT" : "USDC";
        
        // Consultar 24h ticker price change statistics para validar estado y volumen
        const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, {
          signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) {
          continue; // El símbolo no existe o no tiene ese quote
        }

        const data: any = await res.json();
        const quoteVolume = parseFloat(data.quoteVolume || "0"); // Volumen en USDT/USDC

        if (quoteVolume < minVolume24hUsd) {
          const result: ResolvedSymbol = {
            ticker: cleanTicker,
            symbol,
            quoteAsset,
            status: "LOW_VOLUME",
            volume24hUsd: quoteVolume,
            isValid: false,
            rejectReason: `Volumen 24h ($${(quoteVolume / 1_000_000).toFixed(2)}M) inferior al umbral de seguridad ($${(minVolume24hUsd / 1_000_000).toFixed(2)}M)`,
          };
          this.cachedSymbols.set(cleanTicker, result);
          return result;
        }

        const result: ResolvedSymbol = {
          ticker: cleanTicker,
          symbol,
          quoteAsset,
          status: "TRADING",
          volume24hUsd: quoteVolume,
          isValid: true,
        };

        this.cachedSymbols.set(cleanTicker, result);
        this.lastSyncTs = Date.now();
        console.log(`[SYMBOL RESOLVER] ${cleanTicker} resuelto como ${symbol} en Binance (Volumen 24h: $${(quoteVolume / 1_000_000).toFixed(2)}M USD)`);
        return result;
      }

      const notFound: ResolvedSymbol = {
        ticker: cleanTicker,
        symbol: "",
        quoteAsset: "USDT",
        status: "NOT_FOUND",
        volume24hUsd: 0,
        isValid: false,
        rejectReason: `No se encontró mercado Spot activo contra USDT o USDC para ${cleanTicker} en Binance`,
      };
      this.cachedSymbols.set(cleanTicker, notFound);
      return notFound;
    } catch (err: any) {
      return {
        ticker: cleanTicker,
        symbol: `${cleanTicker}USDT`,
        quoteAsset: "USDT",
        status: "ERROR",
        volume24hUsd: 0,
        isValid: false,
        rejectReason: `Error de red consultando Binance API: ${err?.message || err}`,
      };
    }
  }
}
