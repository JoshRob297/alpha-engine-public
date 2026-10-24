/**
 * FASE 1 CEX: Pre-Computación Determinística de Regímenes para BTC y SOL
 * Procesa las 8,760 velas de Binance (btc_1h.json y sol_1h.json)
 * y genera métricas de microestructura, OFI, spreads y clasificación de régimen.
 * Salidas:
 * - /mnt/storage/alpha-backtest/btc_regimes.json
 * - /mnt/storage/alpha-backtest/sol_regimes.json
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = existsSync("/mnt/storage/alpha-backtest") ? "/mnt/storage/alpha-backtest" : "/home/user/alpha-backtest";

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CexRegimePoint {
  timestamp: number;
  date: string;
  price: number;
  regime: "AGGRESSIVE_ACCUMULATION" | "BALANCED_RANGE" | "DEFENSIVE_STRESS";
  toxicFlow: number;
  regimeStress: number;
  spreadBps: number;
  ofiScore: number;
  volatilityPct: number;
}

function processAssetRegimes(ticker: "BTC" | "SOL"): CexRegimePoint[] {
  const inputFile = join(OUT_DIR, `raw/${ticker.toLowerCase()}_1h.json`);
  const outputFile = join(OUT_DIR, `${ticker.toLowerCase()}_regimes.json`);

  console.log(`[FASE 1 CEX] Procesando ${ticker} desde ${inputFile}...`);
  if (!existsSync(inputFile)) {
    throw new Error(`Archivo no encontrado: ${inputFile}`);
  }

  const candles: Candle[] = JSON.parse(readFileSync(inputFile, "utf-8"));
  console.log(`  -> Velas cargadas para ${ticker}: ${candles.length}`);

  const closePrices = candles.map((c) => c.close);
  const results: CexRegimePoint[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const midPrice = c.close;
    const range = Math.max(0.0001, c.high - c.low);
    const body = c.close - c.open;
    const bodyRatio = body / range;

    const volPct = (range / midPrice) * 100;
    // Spreads y volatilidad calibrados al activo (SOL es más volátil que BTC)
    const baseSpread = ticker === "BTC" ? 6 : 14;
    const spreadBps = Math.max(baseSpread, Math.min(50, baseSpread + volPct * (ticker === "BTC" ? 5 : 8)));
    const ofiScore = Math.max(-0.85, Math.min(0.85, bodyRatio * 0.75));

    // Cálculo de medias móviles sin look-ahead (EMA20 vs EMA50)
    let ema20 = midPrice;
    let ema50 = midPrice;
    if (i >= 50) {
      const slice50 = closePrices.slice(i - 50, i);
      ema50 = slice50.reduce((a, b) => a + b, 0) / 50;
      const slice20 = closePrices.slice(i - 20, i);
      ema20 = slice20.reduce((a, b) => a + b, 0) / 20;
    }

    // Métricas de estrés de microestructura equivalentes a Laya System 1
    const toxicThresholdVol = ticker === "BTC" ? 1.8 : 2.8;
    const toxicFlow = volPct > toxicThresholdVol ? 0.82 : Math.max(0.05, Math.min(0.85, 0.12 + (volPct / toxicThresholdVol) * 0.60));
    const regimeStress = spreadBps > (ticker === "BTC" ? 25 : 35) ? 0.78 : Math.max(0.05, Math.min(0.80, spreadBps / 35));

    // Clasificación de Régimen
    let regime: CexRegimePoint["regime"] = "BALANCED_RANGE";
    if (toxicFlow > 0.65 || regimeStress > 0.65 || volPct > (ticker === "BTC" ? 2.5 : 4.0)) {
      regime = "DEFENSIVE_STRESS";
    } else if (ema20 > ema50 * 1.003 && ofiScore > 0.15) {
      regime = "AGGRESSIVE_ACCUMULATION";
    }

    results.push({
      timestamp: c.timestamp,
      date: new Date(c.timestamp).toISOString(),
      price: midPrice,
      regime,
      toxicFlow: parseFloat(toxicFlow.toFixed(3)),
      regimeStress: parseFloat(regimeStress.toFixed(3)),
      spreadBps: parseFloat(spreadBps.toFixed(1)),
      ofiScore: parseFloat(ofiScore.toFixed(2)),
      volatilityPct: parseFloat(volPct.toFixed(3)),
    });
  }

  writeFileSync(outputFile, JSON.stringify(results, null, 2));
  console.log(`[GUARDADO] ${outputFile}: ${results.length} registros generados.`);

  const counts = {
    BALANCED_RANGE: results.filter((r) => r.regime === "BALANCED_RANGE").length,
    AGGRESSIVE_ACCUMULATION: results.filter((r) => r.regime === "AGGRESSIVE_ACCUMULATION").length,
    DEFENSIVE_STRESS: results.filter((r) => r.regime === "DEFENSIVE_STRESS").length,
  };
  console.log(`  • BALANCED_RANGE          : ${counts.BALANCED_RANGE} horas (${((counts.BALANCED_RANGE / results.length) * 100).toFixed(1)}%)`);
  console.log(`  • AGGRESSIVE_ACCUMULATION : ${counts.AGGRESSIVE_ACCUMULATION} horas (${((counts.AGGRESSIVE_ACCUMULATION / results.length) * 100).toFixed(1)}%)`);
  console.log(`  • DEFENSIVE_STRESS        : ${counts.DEFENSIVE_STRESS} horas (${((counts.DEFENSIVE_STRESS / results.length) * 100).toFixed(1)}%)\n`);

  return results;
}

function main() {
  console.log("=== INICIANDO FASE 1 CEX: PRE-COMPUTACIÓN DE REGÍMENES PARA BTC Y SOL ===");
  processAssetRegimes("BTC");
  processAssetRegimes("SOL");
  console.log("=== FASE 1 CEX COMPLETADA CON ÉXITO ===");
}

main();
