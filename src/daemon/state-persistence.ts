/**
 * Capa de Persistencia Atómica y Restauración de Estado (Alpha Engine)
 * Maneja la lectura segura y escritura atómica (temp + rename) de engine_state.json
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";

export const STATE_FILE = existsSync("./data/engine_state.json")
  ? "./data/engine_state.json"
  : existsSync("/home/user/proyectos/alpha-engine/data/engine_state.json")
  ? "/home/user/proyectos/alpha-engine/data/engine_state.json"
  : "./data/engine_state.json";

export interface PersistentStateData {
  pulseCount?: number;
  startedAt?: string;
  history?: any[];
  cex?: Record<string, any>;
  dex?: Record<string, any>;
  futuresHedge?: { positions?: any[] } & Record<string, any>;
  unallocatedCashUsd?: number;
  dexRebalanceEventsTotal?: number;
  regimeHysteresis?: Record<string, any>;
  conservationRepairs?: number;
  capitalMovedTotalUsd?: number;
  windowInvalidations?: Array<{ ts: string; reason: string; detail: string }>;
}

export class StatePersistenceManager {
  private stateFilePath: string;

  constructor(filePath = STATE_FILE) {
    this.stateFilePath = filePath;
  }

  public load(): PersistentStateData | null {
    if (!existsSync(this.stateFilePath)) return null;
    try {
      const raw = readFileSync(this.stateFilePath, "utf-8");
      return JSON.parse(raw) as PersistentStateData;
    } catch (err) {
      console.error("[STATE_PERSISTENCE LOAD ERROR]:", err);
      return null;
    }
  }

  public saveAtomic(payload: Record<string, any>): void {
    const tempFile = `${this.stateFilePath}.tmp.${Date.now()}`;
    try {
      writeFileSync(tempFile, JSON.stringify(payload, null, 2));
      renameSync(tempFile, this.stateFilePath);
    } catch (err) {
      console.error("[STATE_PERSISTENCE SAVE ERROR]:", err);
    }
  }

  public getFilePath(): string {
    return this.stateFilePath;
  }
}
