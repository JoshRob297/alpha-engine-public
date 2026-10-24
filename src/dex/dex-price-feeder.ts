/**
 * Cliente de Precios y Pools en Tiempo Real para Base L2
 * Consulta DexScreener y DeFiLlama sin claves comerciales ni valores quemados.
 */

export interface DexLivePrice {
  symbol: string;
  priceUsd: number;
  priceNative?: number;
  volume24hUsd: number;
  liquidityUsd: number;
}

// Token Addresses oficiales en Base L2
const BASE_TOKEN_ADDRESSES: Record<string, string> = {
  AERO: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
  WETH: "0x4200000000000000000000000000000000000006",
  CBBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

export async function fetchLiveDexTokenPrice(ticker: string): Promise<number | null> {
  const address = BASE_TOKEN_ADDRESSES[ticker.toUpperCase()];
  if (!address) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data.pairs) && data.pairs.length > 0) {
      // Filtrar el par con mayor liquidez en red Base
      const basePairs = data.pairs.filter((p: any) => p.chainId === "base");
      const bestPair = (basePairs.length > 0 ? basePairs : data.pairs).sort(
        (a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      )[0];

      const price = parseFloat(bestPair.priceUsd);
      return isNaN(price) ? null : price;
    }
  } catch {}
  return null;
}

/**
 * Calcula el ratio de precio relativo en vivo para un pool de paridad (ej. WETH / cbBTC)
 */
export async function fetchLivePoolRatio(token0: string, token1: string): Promise<number | null> {
  const [p0, p1] = await Promise.all([
    fetchLiveDexTokenPrice(token0),
    fetchLiveDexTokenPrice(token1),
  ]);

  if (p0 && p1 && p1 > 0) {
    return p0 / p1;
  }
  return null;
}
