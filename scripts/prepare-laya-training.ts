/**
 * SCRIPT DE PREPARACIÓN DE ENTRENAMIENTO PARA LAYA (DISTILLED FROM JEV CLOUD)
 * Convierte los pares capturados de telemetría a formato de fine-tuning / distill
 * para que Laya System 1 replique a Jev Cloud con latencia de 3ms.
 */

import { readFileSync, writeFileSync } from "node:fs";

const RAW_CURATED = "/tmp/laya_curated_for_retraining.jsonl";
const lines = readFileSync(RAW_CURATED, "utf-8").split("\n").filter(Boolean);

console.log(`Procesando ${lines.length} registros curados para entrenamiento de Laya...`);

const trainingSamples = lines.map((l) => {
  const d = JSON.parse(l);
  return {
    state: {
      ticker: d.input.ticker,
      spread_bps: d.input.spreadBps,
      ofi: d.input.ofiScore,
      depth_ratio: d.input.depthRatio,
      evaporating: d.input.isLiquidityEvaporating,
    },
    decision: {
      regime: d.target.regime,
      circuit_breaker: d.target.circuitBreaker,
      exposure: d.target.recommendedExposure,
    },
  };
});

const outTrainingPath = "/tmp/laya_finetune_ready.json";
writeFileSync(outTrainingPath, JSON.stringify(trainingSamples, null, 2));

console.log(`Archivo de entrenamiento generado con éxito en: ${outTrainingPath}`);
console.log(`Total muestras listas para destilación: ${trainingSamples.length}`);
