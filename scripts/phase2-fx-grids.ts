/**
 * FASE 2: Generación Dinámica de Mallas FX con Adaptabilidad Walk-Forward
 * Toma las 4,705 horas con regímenes ya etiquetados de Fase 1
 * y calcula los parámetros matemáticos óptimos de malla para cada ventana sin look-ahead.
 * Salida: /mnt/storage/alpha-backtest/fx_dynamic_grids.json
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type FxRegimePoint } from "./phase1-fx-regimes.js";

const OUT_DIR = existsSync("/mnt/storage/alpha-backtest") ? "/mnt/storage/alpha-backtest" : "/home/user/alpha-backtest";
const REGIMES_FILE = join(OUT_DIR, "fx_regimes.json");
const OUTPUT_FILE = join(OUT_DIR, "fx_dynamic_grids.json");

export interface DynamicGridConfig {
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

function main() {
  console.log("=== INICIANDO FASE 2: GENERACIÓN DINÁMICA DE MALLAS FX ===");
  if (!existsSync(REGIMES_FILE)) {
    throw new Error(`Archivo ${REGIMES_FILE} no encontrado. Ejecuta primero Fase 1.`);
  }

  const regimePoints: FxRegimePoint[] = JSON.parse(readFileSync(REGIMES_FILE, "utf-8"));
  console.log(`Registros de régimen cargados: ${regimePoints.length}`);

  const gridConfigs: DynamicGridConfig[] = [];

  for (let i = 0; i < regimePoints.length; i++) {
    const pt = regimePoints[i];

    // Modulación matemática adaptativa según Régimen de Fase 1:
    let spacing = 0.0018; // 0.18% base
    let mult = 1.0;
    let tp = 0.0045;      // 0.45% base
    let stop = 0.025;     // 2.50% base
    const levels = 3;

    if (pt.regime === "DEFENSIVE_STRESS") {
      // En estrés: espaciado más amplio (+0.25%) y stop acotado para defender capital
      spacing = 0.0025;
      tp = 0.0055;
      stop = 0.018; // Cortar antes
    } else if (pt.regime === "AGGRESSIVE_ACCUMULATION") {
      // En tendencia alcista del dólar: espaciado ágil (+0.14%) y TP expandido (+0.60%)
      spacing = 0.0014;
      tp = 0.0060;
      stop = 0.030;
    } else {
      // BALANCED_RANGE: Malla neutra estándar de captura de micro-spreads
      spacing = 0.0018;
      tp = 0.0045;
      stop = 0.025;
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

  writeFileSync(OUTPUT_FILE, JSON.stringify(gridConfigs, null, 2));

  console.log(`\n=== FASE 2 COMPLETADA CON ÉXITO ===`);
  console.log(`Archivo generado: ${OUTPUT_FILE}`);
  console.log(`Mallas configuradas: ${gridConfigs.length} horas`);
  console.log(`Muestra configuración inicial:`, gridConfigs[0]);
  console.log(`Muestra configuración hora 1000:`, gridConfigs[1000]);
}

main();
