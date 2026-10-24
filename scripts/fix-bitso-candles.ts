/**
 * Corrector de Descarga de Bitso OHLC (usd_mxn)
 * Mapea correctamente las propiedades de Bitso:
 * first_rate -> open
 * max_rate   -> high
 * min_rate   -> low
 * last_rate  -> close
 * volume     -> volume
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = existsSync("/mnt/storage/alpha-backtest") ? "/mnt/storage/alpha-backtest" : "/home/user/alpha-backtest";
const OUTPUT_FILE = join(OUT_DIR, "raw/usd_mxn_1h.json");

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchRealBitsoOhlc(): Promise<Candle[]> {
  console.log("[COLLECT] Descargando velas horarias reales de Bitso (usd_mxn)...");
  const url = "https://api.bitso.com/v3/ohlc/?book=usd_mxn&time_bucket=3600&limit=1000";
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  if (!data.success || !Array.isArray(data.payload)) {
    throw new Error("Payload inválido de Bitso");
  }

  const candles: Candle[] = [];
  for (const b of data.payload) {
    const open = parseFloat(b.first_rate);
    const high = parseFloat(b.max_rate);
    const low = parseFloat(b.min_rate);
    const close = parseFloat(b.last_rate);
    const volume = parseFloat(b.volume);

    if (!isNaN(open) && !isNaN(high) && !isNaN(low) && !isNaN(close) && open > 0) {
      candles.push({
        timestamp: b.bucket_start_time,
        open,
        high,
        low,
        close,
        volume,
      });
    }
  }

  // Ordenar cronológicamente
  candles.sort((a, b) => a.timestamp - b.timestamp);
  return candles;
}

async function main() {
  const candles = await fetchRealBitsoOhlc();
  console.log(`[EXITO] Descargadas ${candles.length} velas reales de Bitso.`);
  console.log(`Muestra vela 0:`, candles[0]);
  console.log(`Muestra vela final:`, candles[candles.length - 1]);

  writeFileSync(OUTPUT_FILE, JSON.stringify(candles, null, 2));
  console.log(`Guardado en: ${OUTPUT_FILE}`);
}

main().catch(console.error);
