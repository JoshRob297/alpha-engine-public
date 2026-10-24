/**
 * DESCARGADOR DE HISTORIA PROFUNDA PARA ACTIVOS ALTERNATIVOS DE BINANCE
 * Descarga hasta 17,520 horas (2 años) para AVAXUSDT y SUIUSDT directamente de Binance Spot.
 */

import { writeFileSync } from "node:fs";

async function fetchBinanceHistorical(symbol: string, targetHours: number): Promise<any[]> {
  const limit = 1000;
  const candles: any[] = [];
  let endTime: number | null = null;

  console.log(`Iniciando descarga histórica para ${symbol} (Objetivo: ${targetHours} horas)...`);

  while (candles.length < targetHours) {
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", "1h");
    url.searchParams.set("limit", limit.toString());
    if (endTime) {
      url.searchParams.set("endTime", endTime.toString());
    }

    try {
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        console.error(`Error HTTP ${res.status} en ${symbol}`);
        break;
      }
      const rawKlines: any[] = await res.json();
      if (rawKlines.length === 0) {
        console.log(`\nLlegamos al origen histórico de listado de ${symbol} en Binance.`);
        break;
      }

      const formatted = rawKlines.map((k) => ({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));

      candles.unshift(...formatted);
      endTime = rawKlines[0][0] - 1;

      process.stdout.write(`• ${symbol}: ${candles.length} de ${targetHours} horas obtenidas...\r`);
      await new Promise((r) => setTimeout(r, 200));
    } catch (err: any) {
      console.warn(`\nReintento de red para ${symbol}: ${err?.message || err}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const uniqueMap = new Map();
  candles.forEach((c) => uniqueMap.set(c.timestamp, c));
  const sorted = Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);

  console.log(`\nDescarga de ${symbol} finalizada: ${sorted.length} horas cronológicas puras.`);
  return sorted;
}

async function main() {
  const TARGET_HOURS = 17520; // 2 años

  // 1. AVAX
  const avaxData = await fetchBinanceHistorical("AVAXUSDT", TARGET_HOURS);
  writeFileSync("/mnt/storage/alpha-backtest/raw/avax_2y_1h.json", JSON.stringify(avaxData));

  // 2. SUI
  const suiData = await fetchBinanceHistorical("SUIUSDT", TARGET_HOURS);
  writeFileSync("/mnt/storage/alpha-backtest/raw/sui_2y_1h.json", JSON.stringify(suiData));

  console.log("\n================================================================================");
  console.log("DATASETS HISTÓRICOS DE AVAX Y SUI GUARDADOS CON ÉXITO EN /mnt/storage/alpha-backtest/raw/");
  console.log("================================================================================\n");
}

main().catch((err) => console.error("Error en descarga:", err));
