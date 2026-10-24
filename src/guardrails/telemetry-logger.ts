/**
 * Laya / Jev Continuous Telemetry Logger
 * Registra cada pulso de microestructura, decisión tomada (exposición, toxicidad, OFI)
 * y precios para permitir el reentrenamiento supervisado y por refuerzo (RLCD) continuo.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface TelemetryPulseItem {
  timestamp: string;
  ticker: string;
  book: string;
  midPrice: number;
  spreadBps: number;
  ofiScore: number;
  depthRatio: number;
  isLiquidityEvaporating: boolean;
  layaToxicFlow: number;
  jevRegime: string;
  jevConfidence: number;
  exposurePct: number;
  circuitBreakerActive: boolean;
  gridLevelsActive: number;
}

export class TelemetryLogger {
  private filePath: string;
  private lastLogTs: Map<string, number> = new Map();
  private minIntervalMs: number;

  constructor(filePath = "./data/laya_telemetry.jsonl", minIntervalMs = 30_000) {
    this.filePath = filePath;
    this.minIntervalMs = minIntervalMs; // Muestra cada 30 segundos por par para no saturar disco
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  public recordPulse(item: TelemetryPulseItem) {
    const now = Date.now();
    const last = this.lastLogTs.get(item.ticker) || 0;
    if (now - last < this.minIntervalMs) {
      return;
    }

    this.lastLogTs.set(item.ticker, now);
    try {
      const line = JSON.stringify(item) + "\n";
      appendFileSync(this.filePath, line, "utf-8");
    } catch (err) {
      console.error("[TELEMETRY LOGGER ERROR]:", err);
    }
  }
}
