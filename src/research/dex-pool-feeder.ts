/**
 * DEX Pool Feeder en Tiempo Real
 * Consulta la API publica de DeFiLlama Yields y filtra los pools
 * concentrados mas liquidos y con mayor rendimiento organico en Base L2.
 */

export interface QualifiedDexPool {
  poolId: string;
  symbol: string;
  project: string;
  chain: string;
  tvlUsd: number;
  feeAprPct: number;
  volume24hUsd: number;
  underlyingTokens: string[];
}

export async function fetchTopBaseConcentratedPools(minTvlUsd = 1_000_000, minVol24hUsd = 1_000_000): Promise<QualifiedDexPool[]> {
  let json: any = null;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch("https://yields.llama.fi/pools", { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`DeFiLlama Yields HTTP status: ${res.status}`);
      json = await res.json();
      break;
    } catch (err) {
      if (attempt === maxRetries) {
        console.warn(`[RESEARCH FEEDER] Fallo al consultar yields.llama.fi tras ${maxRetries} intentos:`, err);
        return [];
      }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }

  if (!json || !Array.isArray(json.data)) return [];

  const allowedProtocols = ["aerodrome-slipstream", "uniswap-v3"];

  const qualified: QualifiedDexPool[] = json.data
    .filter((p: any) =>
      p.chain === "Base" &&
      allowedProtocols.includes(p.project) &&
      p.tvlUsd >= minTvlUsd &&
      (p.volumeUsd1d || 0) >= minVol24hUsd &&
      p.apyBase > 5.0 // Minimo 5% APR de comisiones puras
    )
    .map((p: any) => ({
      poolId: p.pool,
      symbol: p.symbol,
      project: p.project,
      chain: p.chain,
      tvlUsd: parseFloat(p.tvlUsd.toFixed(2)),
      feeAprPct: parseFloat((p.apyBase || 0).toFixed(2)),
      volume24hUsd: parseFloat((p.volumeUsd1d || 0).toFixed(2)),
      underlyingTokens: p.underlyingTokens || [],
    }))
    // Ordenar de mayor a menor retorno de comisiones
    .sort((a: QualifiedDexPool, b: QualifiedDexPool) => b.feeAprPct - a.feeAprPct);

  return qualified.slice(0, 10);
}
