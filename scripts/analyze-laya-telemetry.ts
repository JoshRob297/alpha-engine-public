/**
 * AUDITORÍA DE CONVERGENCIA Y DESTILACIÓN: JEV CLOUD VS LAYA SYSTEM 1
 * Analiza 18,486 registros de telemetría real en Compute-node para medir:
 * 1. Divergencia / Consenso entre Jev y Laya.
 * 2. Casos frontera (Edge cases) donde Jev y Laya discreparon.
 * 3. Filtrado de dataset curado para el re-entrenamiento (Fine-Tuning) de Laya.
 */

import { readFileSync, writeFileSync } from "node:fs";

const TELEMETRY_FILE = "/tmp/laya_telemetry.jsonl";
const lines = readFileSync(TELEMETRY_FILE, "utf-8").split("\n").filter(Boolean);

console.log("================================================================================");
console.log("   ANÁLISIS DE TELEMETRÍA Y JUICIOS DE JEV PARA RE-ENTRENAR A LAYA              ");
console.log(`   Registros Reales Capturados: ${lines.length} eventos                         `);
console.log("================================================================================\n");

let solCount = 0;
let btcCount = 0;
let usdCount = 0;
let defensiveCount = 0;
let balancedCount = 0;
let aggressiveCount = 0;

let highToxicJevBalanced = 0; // Discrepancias: Laya vio tóxico pero Jev vio Balanced
let lowToxicJevDefensive = 0; // Discrepancias: Laya vio limpio pero Jev vio Stress

const distillationDataset: any[] = [];

for (const line of lines) {
  try {
    const d = JSON.parse(line);
    if (d.ticker === "SOL") solCount++;
    else if (d.ticker === "BTC") btcCount++;
    else usdCount++;

    if (d.jevRegime === "DEFENSIVE_STRESS") defensiveCount++;
    else if (d.jevRegime === "BALANCED_RANGE") balancedCount++;
    else if (d.jevRegime === "AGGRESSIVE_ACCUMULATION" || d.jevRegime === "EXPANSION_UP") aggressiveCount++;

    // Detección de discrepancias sutiles para destilación
    const isLayaToxic = (d.layaToxicFlow ?? 0) > 0.50;
    const isJevDefensive = d.jevRegime === "DEFENSIVE_STRESS";

    if (isLayaToxic && !isJevDefensive) highToxicJevBalanced++;
    if (!isLayaToxic && isJevDefensive) lowToxicJevDefensive++;

    // Si hay datos completos con confianza alta de Jev, es material de destilación
    if (d.jevConfidence && d.jevConfidence >= 0.70 && d.ofiScore !== undefined) {
      distillationDataset.push({
        input: {
          ticker: d.ticker,
          spreadBps: parseFloat(d.spreadBps?.toFixed(2) || "0"),
          ofiScore: parseFloat(d.ofiScore?.toFixed(3) || "0"),
          depthRatio: parseFloat(d.depthRatio?.toFixed(3) || "1.0"),
          isLiquidityEvaporating: Boolean(d.isLiquidityEvaporating),
        },
        target: {
          regime: d.jevRegime,
          toxicFlow: d.layaToxicFlow ?? 0.20,
          circuitBreaker: Boolean(d.circuitBreakerActive),
          recommendedExposure: d.exposurePct ?? 0.40,
        },
        metadata: {
          timestamp: d.timestamp,
          jevConfidence: d.jevConfidence,
        },
      });
    }
  } catch {}
}

console.log("1. DISTRIBUCIÓN POR ACTIVO:");
console.log(`• SOL : ${solCount} juicios (${((solCount / lines.length) * 100).toFixed(1)}%)`);
console.log(`• BTC : ${btcCount} juicios (${((btcCount / lines.length) * 100).toFixed(1)}%)`);
console.log(`• USD : ${usdCount} juicios (${((usdCount / lines.length) * 100).toFixed(1)}%)\n`);

console.log("2. DISTRIBUCIÓN DE RÉGIMEN (JUICIOS DE JEV):");
console.log(`• BALANCED_RANGE          : ${balancedCount} (${((balancedCount / lines.length) * 100).toFixed(1)}%)`);
console.log(`• DEFENSIVE_STRESS        : ${defensiveCount} (${((defensiveCount / lines.length) * 100).toFixed(1)}%)`);
console.log(`• AGGRESSIVE_ACCUMULATION : ${aggressiveCount} (${((aggressiveCount / lines.length) * 100).toFixed(1)}%)\n`);

console.log("3. ANÁLISIS DE DISCREPANCIA (CONVERGENCIA JEV vs LAYA):");
console.log(`• Laya alertó Toxicidad pero Jev mantuvo Balanced : ${highToxicJevBalanced} casos (Micro-toxicidad transitoria)`);
console.log(`• Jev declaró Stress pero Laya midió Libro Limpio : ${lowToxicJevDefensive} casos (Estrés Macro sin shock en libro)`);
const totalConsensus = lines.length - (highToxicJevBalanced + lowToxicJevDefensive);
console.log(`• TASA DE CONSENSO Y ALINEACIÓN GLOBAL           : ${((totalConsensus / lines.length) * 100).toFixed(2)}%\n`);

console.log("4. PREPARACIÓN PARA RE-ENTRENAMIENTO (FINE-TUNING):");
console.log(`• Muestras de Alta Calidad Filtradas (Confianza >= 0.70): ${distillationDataset.length} pares (Input -> Target)`);

const outCurated = "/tmp/laya_curated_for_retraining.jsonl";
writeFileSync(outCurated, distillationDataset.map((d) => JSON.stringify(d)).join("\n"));
console.log(`• Archivo curado listo para entrenamiento guardado en: ${outCurated}`);
console.log("================================================================================\n");
