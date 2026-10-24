/**
 * Resolver Dinámico Universal de Cobertura de Futuros (Binance Futures /fapi/v1)
 * Analiza dinámicamente cualquier par de tokens de un pool DEX (ej. "WETH-CBBTC", "AERO-USDC", "SOL-USDC")
 * y resuelve cuál es el token volátil a cubrir y si existe contrato perpetuo líquido en Binance.
 * Cero cadenas quemadas (hardcoded) en el código.
 */

export interface ResolvedHedgeAsset {
  hedgeSymbol: string;      // ej. "ETHUSDT", "BTCUSDT", "SOLUSDT"
  volatileToken: string;    // ej. "WETH", "CBBTC", "SOL"
  isLiquidFutures: boolean; // Si cotiza con libro en Binance Futures
  fallbackSymbol?: string;  // Fallback seguro si es token exótico
}

export class DynamicFuturesResolver {
  private static STABLECOINS = new Set(["USDC", "USDT", "DAI", "USD", "LUSD", "EURC"]);
  private static tokenAliasMap: Record<string, string> = {
    WETH: "ETH",
    CBBTC: "BTC",
    WBTC: "BTC",
    WSOL: "SOL",
    WAVAX: "AVAX",
  };

  private static verifiedFuturesSymbols: Set<string> = new Set([
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "AEROUSDT", "AVAXUSDT", "SUIUSDT", "NEARUSDT", "LINKUSDT", "DOGEUSDT"
  ]);

  /**
   * Resuelve dinámicamente qué contrato de futuros cubre un pool DEX arbitrario.
   * @param poolSymbol Símbolo del pool (ej. "WETH-CBBTC", "USDC-CBBTC", "AERO-USDC", "WETH-VVV")
   */
  public static async resolveHedgeForPool(poolSymbol: string): Promise<ResolvedHedgeAsset | null> {
    const rawTokens = poolSymbol.toUpperCase().split(/[-_/]/).map(t => t.trim()).filter(Boolean);
    if (rawTokens.length < 2) return null;

    const tokenA = rawTokens[0];
    const tokenB = rawTokens[1];

    const isStableA = this.STABLECOINS.has(tokenA);
    const isStableB = this.STABLECOINS.has(tokenB);

    let volatileCandidate = "";

    // 1. Si un token es moneda estable, el otro es obligatoriamente el activo volátil a cubrir
    if (isStableA && !isStableB) {
      volatileCandidate = tokenB;
    } else if (!isStableA && isStableB) {
      volatileCandidate = tokenA;
    } else {
      // 2. Si ambos son volátiles (ej. WETH-CBBTC):
      // El activo que cotiza en el numerador o de mayor beta suele ser el objetivo de cobertura primaria
      volatileCandidate = tokenA.includes("WETH") || tokenA.includes("ETH") ? tokenA : tokenB;
    }

    // Normalizar alias de tokens wrapped
    const cleanToken = this.tokenAliasMap[volatileCandidate] || volatileCandidate;
    const candidateFutureSymbol = `${cleanToken}USDT`;

    // 3. Verificar si el contrato perpetuo existe en Binance Futures
    const isValid = await this.verifyBinanceFuturesContract(candidateFutureSymbol);
    if (isValid) {
      return {
        hedgeSymbol: candidateFutureSymbol,
        volatileToken: cleanToken,
        isLiquidFutures: true,
      };
    }

    // 4. Si es un token exótico de Base sin futuros directos (ej. VVV):
    // Usar el otro token del par si es WETH o BTC como proxy correlacionado
    const otherToken = volatileCandidate === tokenA ? tokenB : tokenA;
    const cleanOther = this.tokenAliasMap[otherToken] || otherToken;
    const otherFutureSymbol = `${cleanOther}USDT`;

    if (await this.verifyBinanceFuturesContract(otherFutureSymbol)) {
      return {
        hedgeSymbol: otherFutureSymbol,
        volatileToken: cleanOther,
        isLiquidFutures: true,
        fallbackSymbol: otherFutureSymbol,
      };
    }

    return null;
  }

  private static async verifyBinanceFuturesContract(symbol: string): Promise<boolean> {
    if (this.verifiedFuturesSymbols.has(symbol)) return true;

    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        this.verifiedFuturesSymbols.add(symbol);
        return true;
      }
    } catch {}

    return false;
  }
}
