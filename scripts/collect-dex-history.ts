/**
 * Colector de Velas Históricas para Pares DEX: ETHUSDT y AEROUSDT
 * Descarga las 8,760 horas para poder calcular:
 * 1. Ratio exacto WETH/CBBTC (ETH/BTC hora por hora)
 * 2. Precio exacto WETH-AERO (AERO hora por hora)
 * Almacena en /mnt/storage/alpha-backtest/raw/
 */

import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = "/mnt/storage/alpha-backtest/raw";
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
  console.log(`[COLLECT DEX] Descargando ${targetHours} velas 1h para ${symbol}...`);
  const allCandles: Candle[] = [];
  let endTime: number | undefined = undefined;

  while (allCandles.length < targetHours) {
    let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=1000`;
    if (endTime) url += `&endTime=${endTime}`;

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) break;

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

      allCandles.unshift(...batch);
      endTime = batch[0].timestamp - 1;

      if (batch.length < 1000) break;
      await new Promise((r) => setTimeout(r, 150));
    } catch {
      break;
    }
  }

  const map = new Map<number, Candle>();
  for (const c of allCandles) map.set(c.timestamp, c);
  const sorted = Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
  return sorted.slice(-targetHours);
}

async function main() {
  console.log("=== INICIANDO DESCARGA DE HISTÓRICO PARA MOTORES DEX ===");

  // 1. ETHUSDT (para el ratio WETH-CBBTC)
  const ethCandles = await fetchBinanceKlines("ETHUSDT", TARGET_HOURS);
  writeFileSync(join(OUT_DIR, "eth_1h.json"), JSON.stringify(ethCandles, null, 2));
  console.log(`[GUARDADO] eth_1h.json: ${ethCandles.length} velas.`);

  // 2. AEROUSDT
  const aeroCandles = await fetchBinanceKlines("AEROUSDT", TARGET_HOURS);
  writeFileSync(join(OUT_DIR, "aero_1h.json"), JSON.stringify(aeroCandles, null, 2));
  console.log(`[GUARDADO] aero_1h.json: ${aeroCandles.length} velas.`);

  console.log("=== DESCARGA DEX COMPLETA ===");
}

main().catch(console.error);
