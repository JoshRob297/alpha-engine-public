/**
 * FASE 2 CEX CALIBRACIÓN EXACTA (PUNTO DULCE):
 * - BTC: TP calibrado a +1.85% (hasta +2.20% en AGGRESSIVE) -> Captura el rebote antes de agotamiento
 * - SOL: TP ampliado a +3.40% (hasta +4.20% en AGGRESSIVE) -> Deja correr la alta volatilidad de Solana
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type CexRegimePoint } from "./phase1-cex-regimes.js";

const OUT_DIR = existsSync("/mnt/storage/alpha-backtest") ? "/mnt/storage/alpha-backtest" : "/home/user/alpha-backtest";

export interface CexDynamicGridConfig {
  timestamp: number;
  date: string;
  price: number;
  regime: string;
  levels: number;
  spacing: number;
  mult: number;
  tp: number;
  stop: number;
}

function generateSweetSpotGrids(ticker: "BTC" | "SOL") {
  const inputFile = join(OUT_DIR, `${ticker.toLowerCase()}_regimes.json`);
  const outputFile = join(OUT_DIR, `${ticker.toLowerCase()}_dynamic_grids.json`);

  console.log(`[FASE 2 CALIBRACIÓN ASIMÉTRICA] Generando mallas punto dulce para ${ticker}...`);
  if (!existsSync(inputFile)) throw new Error(`Archivo no encontrado: ${inputFile}`);

  const regimes: CexRegimePoint[] = JSON.parse(readFileSync(inputFile, "utf-8"));
  const gridConfigs: CexDynamicGridConfig[] = [];

  for (const pt of regimes) {
    let spacing = ticker === "BTC" ? 0.004 : 0.006;
    let mult = 1.1;
    // Calibración diferenciada por activo:
    // BTC en +1.85% (punto dulce para asegurar antes de retroceso)
    // SOL en +3.40% (aprovecha los impulsos explosivos de Solana)
    let tp = ticker === "BTC" ? 0.0185 : 0.034;
    let stop = 0.075;
    const levels = 2;

    if (pt.regime === "DEFENSIVE_STRESS") {
      spacing = ticker === "BTC" ? 0.006 : 0.009;
      tp = ticker === "BTC" ? 0.014 : 0.024;
      stop = 0.0525;
    } else if (pt.regime === "AGGRESSIVE_ACCUMULATION") {
      spacing = ticker === "BTC" ? 0.0035 : 0.005;
      tp = ticker === "BTC" ? 0.022 : 0.040;
      stop = 0.090;
    }

    gridConfigs.push({
      timestamp: pt.timestamp,
      date: pt.date,
      price: pt.price,
      regime: pt.regime,
      levels,
      spacing,
      mult,
      tp,
      stop,
    });
  }

  writeFileSync(outputFile, JSON.stringify(gridConfigs, null, 2));
  console.log(`  -> Guardado ${outputFile}: ${gridConfigs.length} mallas configuradas.`);
}

function main() {
  console.log("=== INICIANDO FASE 2 CEX: CALIBRACIÓN ASIMÉTRICA PUNTO DULCE ===");
  generateSweetSpotGrids("BTC");
  generateSweetSpotGrids("SOL");
  console.log("=== FASE 2 CALIBRACIÓN COMPLETADA ===\n");
}

main();
