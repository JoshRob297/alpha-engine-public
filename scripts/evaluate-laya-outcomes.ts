/**
 * Evaluador de Recompensas y Ground Truth para Laya System 1 (RLCD Pipeline)
 * Lee eventos en data/laya_distillation.jsonl, audita el resultado de mercado
 * y genera datasets curados para el reentrenamiento offline con 22 hilos en Compute-node.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";

const DISTILLATION_PATH = "/home/user/proyectos/alpha-engine/data/laya_distillation.jsonl";
const CURATED_OUTPUT_PATH = "/home/user/proyectos/alpha-engine/data/laya_training_curated.jsonl";

interface DistillationEvent {
  timestamp: string;
  type: string;
  ticker: string;
  book: string;
  metrics: {
    currentGainPct: number;
    ofiScore: number;
    spreadBps: number;
    progressToTp: number;
  };
  layaJudgment: {
    toxicFlow: number;
    meanReversion: number;
  };
  exitAction: string;
  exitReason: string;
}

export function evaluateDistillationEvents(): { evaluated: number; rewardsCalculated: number } {
  if (!existsSync(DISTILLATION_PATH)) {
    console.log("[LAYA EVAL] No se encontro archivo de destilacion.");
    return { evaluated: 0, rewardsCalculated: 0 };
  }

  const rawLines = readFileSync(DISTILLATION_PATH, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  console.log(`[LAYA EVAL] Procesando ${rawLines.length} eventos registrados...`);

  const curatedEntries: any[] = [];
  let evaluated = 0;

  for (const line of rawLines) {
    try {
      const evt: DistillationEvent = JSON.parse(line);
      evaluated++;

      // Calculo de la funcion de recompensa (Reward Function Causal)
      let reward = 0.0;
      let label = "";

      if (evt.exitAction === "FRONT_RUN_EXIT") {
        // Front-run fue exitoso si la toxicidad era real y aseguro ganancias en retroceso
        if (evt.metrics.ofiScore < -0.60 || evt.layaJudgment.toxicFlow > 0.50) {
          reward = +1.0;
          label = "OPTIMAL_PROTECTION";
        } else {
          reward = -0.2;
          label = "PREMATURE_EXIT";
        }
      } else if (evt.exitAction === "TRAILING_EXPANSION") {
        // Expansion fue exitosa si el OFI mostro fuerza real compradora
        if (evt.metrics.ofiScore > 0.50) {
          reward = +1.5;
          label = "ALPHA_CAPTURE";
        } else {
          reward = -0.1;
          label = "OVERSTRETCH";
        }
      } else {
        reward = +0.5;
        label = "STANDARD_EXECUTION";
      }

      curatedEntries.push({
        timestamp: evt.timestamp,
        ticker: evt.ticker,
        input_state: {
          gain: evt.metrics.currentGainPct,
          ofi: evt.metrics.ofiScore,
          spread: evt.metrics.spreadBps,
        },
        action: evt.exitAction,
        reward,
        label,
      });
    } catch {}
  }

  writeFileSync(CURATED_OUTPUT_PATH, curatedEntries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  console.log(`[LAYA EVAL] Curados ${curatedEntries.length} ejemplos con recompensa en ${CURATED_OUTPUT_PATH}`);

  return { evaluated, rewardsCalculated: curatedEntries.length };
}

// Ejecutar directamente si es invocado por CLI o cron
if (import.meta.main) {
  evaluateDistillationEvents();
}
