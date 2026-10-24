/**
 * DESCARGADOR DE HISTORIA PROFUNDA (2 AÑOS COMPLETOS / 17,520 HORAS)
 * Extrae velas horarias continuas desde Binance Spot API para SOL/USDT y BTC/USDT.
 */

import { writeFileSync, existsSync } from "node:fs";

async function fetchBinanceKlines(symbol: string, totalHours: number): Promise<any[]> {
  const limit = 1000;
  const candles: any[] = [];
  let endTime: number | null = null;

  console.log(`Iniciando descarga de ${totalHours} horas para ${symbol}...`);

  while (candles.length < totalHours) {
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
        console.error(`Error HTTP ${res.status} descargando ${symbol}`);
        break;
      }
      const rawKlines: any[] = await res.json();
      if (rawKlines.length === 0) break;

      const formatted = rawKlines.map((k) => ({
        timestamp: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));

      // Invertir para ordenar cronológicamente
      candles.unshift(...formatted);
      endTime = rawKlines[0][0] - 1; // Mover hacia atrás en el tiempo

      process.stdout.write(`• ${symbol}: ${candles.length} de ${totalHours} horas descargadas...\r`);
      await new Promise((r) => setTimeout(r, 200)); // Rate limit respetuoso
    } catch (err: any) {
      console.warn(`\nReintento de red para ${symbol}: ${err?.message || err}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Eliminar duplicados si los hubiera
  const uniqueMap = new Map();
  candles.forEach((c) => uniqueMap.set(c.timestamp, c));
  const sorted = Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);

  console.log(`\nDescarga de ${symbol} completada: ${sorted.length} horas obtenidas.`);
  return sorted.slice(sorted.length - totalHours);
}

async function main() {
  const TARGET_HOURS = 17520; // 2 años completos (365 * 2 * 24)

  const sol2y = await fetchBinanceKlines("SOLUSDT", TARGET_HOURS);
  writeFileSync("/mnt/storage/alpha-backtest/raw/sol_2y_1h.json", JSON.stringify(sol2y));

  const btc2y = await fetchBinanceKlines("BTCUSDT", TARGET_HOURS);
  writeFileSync("/mnt/storage/alpha-backtest/raw/btc_2y_1h.json", JSON.stringify(btc2y));

  console.log("\n================================================================================");
  console.log("DATASETS HISTÓRICOS DE 2 AÑOS (17,520 HORAS) GUARDADOS CON ÉXITO EN /mnt/storage");
  console.log("================================================================================\n");
}

main().catch((err) => console.error("Error fatal en descarga:", err));
