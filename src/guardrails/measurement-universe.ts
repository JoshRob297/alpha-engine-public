/**
 * Congelamiento del universo de medicion.
 *
 * Defecto metodologico que corrige: `GENOME_FREEZE` congela genomas, pero durante la
 * ventana OOS el motor seguia admitiendo activos nuevos (watchlist aprobada por el
 * research semanal) y pools nuevos (seleccion en vivo desde DeFiLlama con filtro de
 * APR). Eso convierte la muestra en seleccion adaptativa dentro del test pre-registrado:
 * el universo deja de estar especificado de antemano y la lectura OOS pierde validez.
 *
 * Regla: con la ventana congelada, solo se operan los activos y pools registrados en
 * `data/measurement_universe.json` al inicio de la ventana. Cualquier admision queda
 * registrada como `UNIVERSE_ADMISSION` y marca la ventana como expandida (el reporte
 * lo expone como invalidez de la muestra).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_UNIVERSE_PATH = "data/measurement_universe.json";

export interface MeasurementUniverse {
  windowStartedAt: string | null;
  assets: string[];
  pools: string[];
  createdAt: string;
  note?: string;
}

export interface UniverseDecision {
  allowed: string[];
  rejected: string[];
}

export interface UniverseAdmission {
  kind: "ASSET" | "POOL";
  key: string;
  ts: string;
  allowed: boolean;
  reason: string;
}

export function loadUniverse(path = DEFAULT_UNIVERSE_PATH): MeasurementUniverse | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as MeasurementUniverse;
    if (!Array.isArray(parsed.assets) || !Array.isArray(parsed.pools)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveUniverse(universe: MeasurementUniverse, path = DEFAULT_UNIVERSE_PATH): void {
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(universe, null, 2), "utf-8");
}

/**
 * Congela el universo actual. No sobreescribe uno existente salvo `force`: un universo
 * ya fijado es parte del protocolo (cambiarlo invalida la ventana).
 */
export function freezeUniverse(
  assets: string[],
  pools: string[],
  windowStartedAt: string | null,
  options: { path?: string; force?: boolean; now?: string } = {}
): { universe: MeasurementUniverse; created: boolean } {
  const path = options.path ?? DEFAULT_UNIVERSE_PATH;
  const existing = loadUniverse(path);
  if (existing && !options.force) return { universe: existing, created: false };
  const universe: MeasurementUniverse = {
    windowStartedAt,
    assets: [...new Set(assets)].sort(),
    pools: [...new Set(pools)].sort(),
    createdAt: options.now ?? new Date().toISOString(),
    note: "Universo congelado de la ventana OOS: activos y pools operables durante la medicion.",
  };
  saveUniverse(universe, path);
  return { universe, created: true };
}

/**
 * Aplica el congelamiento. `allowExpansion` (env UNIVERSE_ALLOW_EXPANSION=true) admite
 * lo nuevo pero el llamador DEBE registrar la admision y marcar la ventana como
 * expandida: la muestra deja de ser estrictamente pre-especificada.
 */
export function applyUniverseFreeze(
  candidates: string[],
  universe: MeasurementUniverse | null,
  kind: "ASSET" | "POOL",
  allowExpansion = false,
  now = new Date().toISOString()
): { decision: UniverseDecision; admissions: UniverseAdmission[] } {
  if (!universe) return { decision: { allowed: candidates, rejected: [] }, admissions: [] };

  const frozen = new Set(kind === "ASSET" ? universe.assets : universe.pools);
  const allowed: string[] = [];
  const rejected: string[] = [];
  const admissions: UniverseAdmission[] = [];

  for (const key of candidates) {
    if (frozen.has(key)) {
      allowed.push(key);
      continue;
    }
    if (allowExpansion) {
      allowed.push(key);
      admissions.push({
        kind,
        key,
        ts: now,
        allowed: true,
        reason: `Admision dentro de la ventana congelada (universo fijado el ${universe.createdAt}): la muestra deja de ser pre-especificada.`,
      });
    } else {
      rejected.push(key);
      admissions.push({
        kind,
        key,
        ts: now,
        allowed: false,
        reason: `Bloqueado por congelamiento del universo (${kind === "ASSET" ? "activos" : "pools"} fijados el ${universe.createdAt}).`,
      });
    }
  }

  return { decision: { allowed, rejected }, admissions };
}

/** La ventana tiene admisiones => la muestra no es estrictamente pre-especificada. */
export function universeExpanded(admissions: UniverseAdmission[]): boolean {
  return admissions.some((a) => a.allowed);
}
