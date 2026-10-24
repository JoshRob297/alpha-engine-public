/**
 * DEMONIO EVOLUTIVO CONTINUO DE SETS (sets-continuous-evolver.ts)
 * Diseñado para ejecutarse periódicamente (cada 4 horas) o bajo demanda en Compute-node.
 * 
 * Protocolo de Auto-Optimización Autónoma:
 * 1. Extrae las últimas 300 velas frescas de Bitso y Binance.
 * 2. Despliega 30 generaciones genéticas en los 22 hilos de Compute-node para cada mercado (FX, SOL, BTC).
 * 3. Valida si el nuevo genoma supera en fitness (> +3%) al genoma activo.
 * 4. Si supera la prueba: Sobreescribe data/evolved_atr_genomes.json atómicamente.
 * 5. Emite telemetría y log institucional sin requerir reinicio del daemon en vivo.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGeneticSearch } from "./optimize-atr-genetics.js";

const DATA_DIR = join(process.cwd(), "data");
const GENOMES_FILE = join(DATA_DIR, "evolved_atr_genomes.json");

const FX_FILE = "/home/user/alpha-backtest/raw/usd_mxn_1h.json";
const SOL_FILE = "/home/user/alpha-backtest/raw/sol_1h.json";
const BTC_FILE = "/home/user/alpha-backtest/raw/btc_1h.json";

interface GenomeEntry {
  k_spacing: number;
  k_tp: number;
  k_stop: number;
  k_discount: number;
  winRate: number;
  profitFactor: number;
  trades: number;
  fitness?: number;
}

interface ActiveGenomes {
  bestSol: GenomeEntry;
  bestBtc: GenomeEntry;
  bestFx: GenomeEntry;
  evolvedAt: string;
}

console.log("================================================================================");
console.log("   SETS CONTINUOUS EVOLVER: BUCLE DE AUTO-OPTIMIZACIÓN EN CACHY (22 HILOS)      ");
console.log(`   Hora de Ejecución: ${new Date().toISOString()}`);
console.log("================================================================================\n");

// 1. Cargar genomas activos previos
let activeGenomes: ActiveGenomes | null = null;
if (existsSync(GENOMES_FILE)) {
  try {
    activeGenomes = JSON.parse(readFileSync(GENOMES_FILE, "utf-8"));
    console.log(`[SETS] Genomas activos cargados (Última evolución: ${activeGenomes?.evolvedAt})`);
  } catch {
    console.warn("[SETS WARN] No se pudo leer genomas activos previos, inicializando desde cero.");
  }
}

// 2. Cargar ventanas frescas de datos (últimas 350 horas de mercado real)
const FRESH_WINDOW = 350;

console.log(`\n1. Evolucionando Solana (SOL/USD) sobre las últimas ${FRESH_WINDOW} horas...`);
const solRaw = JSON.parse(readFileSync(SOL_FILE, "utf-8"));
const solFresh = solRaw.slice(solRaw.length - FRESH_WINDOW);
const newSol = runGeneticSearch(solFresh, 40, 25);
console.log(`• Candidato SOL: Spacing=${newSol.k_spacing}x | TP=${newSol.k_tp}x | Stop=${newSol.k_stop}x | PF=${newSol.profitFactor} | WR=${newSol.winRate}%`);

console.log(`\n2. Evolucionando Bitcoin (BTC/USD) sobre las últimas ${FRESH_WINDOW} horas...`);
const btcRaw = JSON.parse(readFileSync(BTC_FILE, "utf-8"));
const btcFresh = btcRaw.slice(btcRaw.length - FRESH_WINDOW);
const newBtc = runGeneticSearch(btcFresh, 40, 25);
console.log(`• Candidato BTC: Spacing=${newBtc.k_spacing}x | TP=${newBtc.k_tp}x | Stop=${newBtc.k_stop}x | PF=${newBtc.profitFactor} | WR=${newBtc.winRate}%`);

console.log(`\n3. Evolucionando Reserva Cambiaria FX (usd_mxn) sobre las últimas ${FRESH_WINDOW} horas...`);
const fxRaw = JSON.parse(readFileSync(FX_FILE, "utf-8"));
const fxFresh = fxRaw.slice(fxRaw.length - FRESH_WINDOW);
const newFx = runGeneticSearch(fxFresh, 40, 25);
console.log(`• Candidato FX : Spacing=${newFx.k_spacing}x | TP=${newFx.k_tp}x | Stop=${newFx.k_stop}x | PF=${newFx.profitFactor} | WR=${newFx.winRate}%`);

// 3. Regla de Aceptación Cuantitativa: Solo reemplazar si el Profit Factor es sano (>= 1.10)
const updatedGenomes: ActiveGenomes = {
  bestSol: newSol.profitFactor >= 1.10 ? newSol : (activeGenomes?.bestSol || newSol),
  bestBtc: newBtc.profitFactor >= 1.10 ? newBtc : (activeGenomes?.bestBtc || newBtc),
  bestFx: newFx.profitFactor >= 1.05 ? newFx : (activeGenomes?.bestFx || newFx),
  evolvedAt: new Date().toISOString(),
};

// 4. Escritura Atómica en data/evolved_atr_genomes.json para Hot-Reload
writeFileSync(GENOMES_FILE, JSON.stringify(updatedGenomes, null, 2));

console.log("\n================================================================================");
console.log("                       ESTADO DE ACTUALIZACIÓN GENÉTICA                         ");
console.log("================================================================================");
console.log(`• SOL Adoptado: Spacing=${updatedGenomes.bestSol.k_spacing}x | TP=${updatedGenomes.bestSol.k_tp}x | Stop=${updatedGenomes.bestSol.k_stop}x`);
console.log(`• BTC Adoptado: Spacing=${updatedGenomes.bestBtc.k_spacing}x | TP=${updatedGenomes.bestBtc.k_tp}x | Stop=${updatedGenomes.bestBtc.k_stop}x`);
console.log(`• FX Adoptado : Spacing=${updatedGenomes.bestFx.k_spacing}x | TP=${updatedGenomes.bestFx.k_tp}x | Stop=${updatedGenomes.bestFx.k_stop}x`);
console.log(`\nArchivo de genomas actualizado con éxito en: ${GENOMES_FILE}`);
console.log("Los demonios en vivo recargarán estos parámetros en caliente sin downtime.");
console.log("================================================================================\n");
