/**
 * FASE 1: Pre-Computación Determinística de Regímenes y Toxicidad FX
 * Clasifica las 4,705 velas horarias de Bitso usd_mxn según volatilidad,
 * tendencia EMA20/50 y OFI sintético para generar el dataset congelado.
 * Salida: /mnt/storage/alpha-backtest/fx_regimes.json
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = existsSync("/mnt/storage/alpha-backtest") ? "/mnt/storage/alpha-backtest" : "/home/user/alpha-backtest";
const INPUT_FILE = join(OUT_DIR, "raw/usd_mxn_1h.json");
const OUTPUT_FILE = join(OUT_DIR, "fx_regimes.json");

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FxRegimePoint {
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

function main() {
  console.log("=== INICIANDO FASE 1: PRE-COMPUTACIÓN DETERMINÍSTICA DE REGÍMENES FX ===");
  if (!existsSync(INPUT_FILE)) {
    throw new Error(`Archivo ${INPUT_FILE} no encontrado.`);
  }

  const rawCandles: Candle[] = JSON.parse(readFileSync(INPUT_FILE, "utf-8"));
  console.log(`Velas cargadas de usd_mxn: ${rawCandles.length}`);

  const results: FxRegimePoint[] = [];
  const startTime = Date.now();
  const closePrices = rawCandles.map((c) => c.close);

  for (let i = 0; i < rawCandles.length; i++) {
    const c = rawCandles[i];
    const midPrice = c.close;
    const range = Math.max(0.0001, c.high - c.low);
    const body = c.close - c.open;
    const bodyRatio = body / range;

    const volPct = (range / midPrice) * 100;
    const spreadBps = Math.max(8, Math.min(40, 12 + volPct * 6));
    const ofiScore = Math.max(-0.85, Math.min(0.85, bodyRatio * 0.70));

    // Cálculo de medias móviles sin look-ahead
    let ema20 = midPrice;
    let ema50 = midPrice;
    if (i >= 50) {
      const slice50 = closePrices.slice(i - 50, i);
      ema50 = slice50.reduce((a, b) => a + b, 0) / 50;
      const slice20 = closePrices.slice(i - 20, i);
      ema20 = slice20.reduce((a, b) => a + b, 0) / 20;
    }

    // Métricas de estrés de microestructura idénticas a Laya System 1
    const toxicFlow = volPct > 0.65 ? 0.78 : Math.max(0.08, Math.min(0.85, 0.15 + (range / midPrice) * 50));
    const regimeStress = spreadBps > 28 ? 0.75 : Math.max(0.05, Math.min(0.80, (spreadBps / 35)));

    // Clasificación Causal de Régimen Cambiario
    let regime: FxRegimePoint["regime"] = "BALANCED_RANGE";
    if (toxicFlow > 0.65 || regimeStress > 0.65 || volPct > 0.85) {
      regime = "DEFENSIVE_STRESS"; // Volatilidad aguda o spread amplio
    } else if (ema20 > ema50 * 1.0015 && ofiScore > 0.15) {
      regime = "AGGRESSIVE_ACCUMULATION"; // Dólar fortaleciéndose
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

  writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));

  const counts = {
    BALANCED_RANGE: results.filter((r) => r.regime === "BALANCED_RANGE").length,
    AGGRESSIVE_ACCUMULATION: results.filter((r) => r.regime === "AGGRESSIVE_ACCUMULATION").length,
    DEFENSIVE_STRESS: results.filter((r) => r.regime === "DEFENSIVE_STRESS").length,
  };

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n=== FASE 1 COMPLETADA EN ${elapsed}s ===`);
  console.log(`Archivo generado: ${OUTPUT_FILE}`);
  console.log(`Total registros : ${results.length}`);
  console.log("Distribución de Regímenes:");
  console.log(`  • BALANCED_RANGE          : ${counts.BALANCED_RANGE} horas (${((counts.BALANCED_RANGE / results.length) * 100).toFixed(1)}%)`);
  console.log(`  • AGGRESSIVE_ACCUMULATION : ${counts.AGGRESSIVE_ACCUMULATION} horas (${((counts.AGGRESSIVE_ACCUMULATION / results.length) * 100).toFixed(1)}%)`);
  console.log(`  • DEFENSIVE_STRESS        : ${counts.DEFENSIVE_STRESS} horas (${((counts.DEFENSIVE_STRESS / results.length) * 100).toFixed(1)}%)`);
}

main();
