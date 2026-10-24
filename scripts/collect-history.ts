/**
 * Colector de Datos Historicos para Replay Ciego (1 Año)
 * Descarga velas 1h de Binance (BTC, SOL), Bitso (USD/MXN) y funding rates.
 * Almacena en /mnt/storage/alpha-backtest/raw/
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = "/mnt/storage/alpha-backtest/raw";
if (!existsSync(OUT_DIR)) {
  mkdirSync(OUT_DIR, { recursive: true });
}

// 8760 horas = 365 días
const TARGET_HOURS = 8760;

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchBinanceKlines(symbol: string, targetHours: number): Promise<Candle[]> {
  console.log(`[COLLECT] Descargando ${targetHours} velas 1h para ${symbol}...`);
  const allCandles: Candle[] = [];
  let endTime: number | undefined = undefined;

  while (allCandles.length < targetHours) {
    let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000`;
    if (endTime) {
      url += `&endTime=${endTime}`;
    }

    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} al descargar ${symbol}`);
    }

    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) break;

    const batch: Candle[] = raw.map((c: any) => ({
      timestamp: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));

    // Prepend porque vamos hacia atrás en el tiempo
    allCandles.unshift(...batch);
    endTime = batch[0].timestamp - 1;

    console.log(`  -> ${symbol}: ${allCandles.length}/${targetHours} velas recolectadas (hasta ${new Date(batch[0].timestamp).toISOString()})`);
    if (batch.length < 1000) break;
    await new Promise((r) => setTimeout(r, 200)); // Rate limit defensivo
  }

  // Orden cronológico estricto y deduplicación por timestamp
  const map = new Map<number, Candle>();
  for (const c of allCandles) {
    map.set(c.timestamp, c);
  }

  const sorted = Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
  return sorted.slice(-targetHours);
}

async function fetchBitsoOhlc(book: string, targetHours: number): Promise<Candle[]> {
  console.log(`[COLLECT] Descargando velas 1h para ${book} desde Bitso...`);
  // Bitso OHLC devuelve hasta 300 o 1000 según endpoint
  const url = `https://api.bitso.com/v3/ohlc/?book=${book}&time_bucket=3600&limit=300`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.payload)) {
        return data.payload.map((c: any) => ({
          timestamp: new Date(c.bucket_start_time).getTime(),
          open: parseFloat(c.open),
          high: parseFloat(c.high),
          low: parseFloat(c.low),
          close: parseFloat(c.close),
          volume: parseFloat(c.volume),
        }));
      }
    }
  } catch (err: any) {
    console.warn(`[WARN] Bitso OHLC no devolvió histórico completo: ${err?.message}`);
  }
  return [];
}

async function fetchFundingRates(symbol: string): Promise<Array<{ timestamp: number; rate: number }>> {
  console.log(`[COLLECT] Descargando funding rates para ${symbol}...`);
  try {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1000`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        return data.map((d: any) => ({
          timestamp: d.fundingTime,
          rate: parseFloat(d.fundingRate),
        }));
      }
    }
  } catch {}
  return [];
}

async function main() {
  console.log("=== INICIANDO DESCARGA DE HISTÓRICO PARA REPLAY CIEGO ===");
  console.log(`Destino: ${OUT_DIR}`);

  // 1. BTCUSDT (1 año)
  const btcCandles = await fetchBinanceKlines("BTCUSDT", TARGET_HOURS);
  writeFileSync(join(OUT_DIR, "btc_1h.json"), JSON.stringify(btcCandles, null, 2));
  console.log(`[GUARDADO] btc_1h.json: ${btcCandles.length} velas.`);

  // 2. SOLUSDT (1 año)
  const solCandles = await fetchBinanceKlines("SOLUSDT", TARGET_HOURS);
  writeFileSync(join(OUT_DIR, "sol_1h.json"), JSON.stringify(solCandles, null, 2));
  console.log(`[GUARDADO] sol_1h.json: ${solCandles.length} velas.`);

  // 3. Bitso USD_MXN (OHLC)
  const usdMxn = await fetchBitsoOhlc("usd_mxn", TARGET_HOURS);
  writeFileSync(join(OUT_DIR, "usd_mxn_1h.json"), JSON.stringify(usdMxn, null, 2));
  console.log(`[GUARDADO] usd_mxn_1h.json: ${usdMxn.length} velas.`);

  // 4. Funding Rates
  const btcFunding = await fetchFundingRates("BTCUSDT");
  writeFileSync(join(OUT_DIR, "btc_funding.json"), JSON.stringify(btcFunding, null, 2));
  console.log(`[GUARDADO] btc_funding.json: ${btcFunding.length} registros.`);

  // 5. DEX Pools Snapshot de referencia
  const dexSnapshot = {
    BTC: { symbol: "WETH-CBBTC", protocol: "Aerodrome Slipstream", feeAprPct: 68.92, tvlUsd: 1_730_000, price: 0.032 },
    AERO: { symbol: "WETH-AERO", protocol: "Aerodrome Slipstream", feeAprPct: 548.5, tvlUsd: 2_340_000, price: 0.88 },
    YIELD: { symbol: "USDC-CBBTC", protocol: "Aerodrome Slipstream", feeAprPct: 231.25, tvlUsd: 7_190_000, price: 84000.0 },
  };
  writeFileSync(join(OUT_DIR, "dex_snapshot.json"), JSON.stringify(dexSnapshot, null, 2));
  console.log(`[GUARDADO] dex_snapshot.json guardado.`);

  console.log("\n=== RECOLECCIÓN HISTÓRICA COMPLETA ===");
}

main().catch((err) => {
  console.error("[FATAL ERROR EN COLECTOR]:", err);
  process.exit(1);
});
