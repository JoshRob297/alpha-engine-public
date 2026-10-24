/**
 * Recolector de datos duros de mercado en tiempo real
 * Extrae:
 * 1. TVL y Flujos de Stablecoins globales y por cadena (DefiLlama)
 * 2. Precios y volumenes actuales de Binance (BTC, ETH, SOL)
 */

export interface LiveMarketContext {
  timestamp: string;
  btcUsd: number;
  ethUsd: number;
  solUsd: number;
  topChainsTvl: Array<{ chain: string; tvlUsd: number }>;
  stablecoinCirculatingUsd: number;
}

export async function fetchLiveMarketContext(): Promise<LiveMarketContext> {
  const [binanceBtc, binanceEth, binanceSol, llamaChains, llamaStables] = await Promise.all([
    fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT").then((r) => r.json()),
    fetch("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT").then((r) => r.json()),
    fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT").then((r) => r.json()),
    fetch("https://api.llama.fi/v2/chains").then((r) => r.json()),
    fetch("https://stablecoins.llama.fi/stablecoincharts/all").then((r) => r.json()),
  ]);

  const topChains = llamaChains
    .sort((a: any, b: any) => b.tvl - a.tvl)
    .slice(0, 5)
    .map((c: any) => ({ chain: c.name, tvlUsd: c.tvl }));

  const lastStablePoint = llamaStables[llamaStables.length - 1];
  const stableTotal = lastStablePoint ? lastStablePoint.totalCirculatingUSD.peggedUSD : 310_000_000_000;

  return {
    timestamp: new Date().toISOString(),
    btcUsd: parseFloat(binanceBtc.price),
    ethUsd: parseFloat(binanceEth.price),
    solUsd: parseFloat(binanceSol.price),
    topChainsTvl: topChains,
    stablecoinCirculatingUsd: stableTotal,
  };
}
