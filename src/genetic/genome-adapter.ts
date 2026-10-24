/**
 * Adaptador Unificado de Genomas (Alpha Engine)
 * Fuente única de verdad para normalizar las dos representaciones de genoma:
 *  1. Genome de ejecución (porcentajes): { family, spacing, tp, stop, ... }
 *  2. Genoma ATR evolucionado (múltiplos de ATR): { k_spacing, k_tp, k_stop, k_discount }
 *
 * Cualquier carga de genoma (cold-start o hot-swap) DEBE pasar por `adaptEvolvedAtrGenome`
 * para garantizar que GridBot nunca reciba campos `undefined` (que producían NaN en el stop).
 */

import { DEFAULT_GENOME, type Genome } from "./bot.js";

export interface EvolvedAtrGenome {
  k_spacing: number;
  k_tp: number;
  k_stop: number;
  k_discount?: number;
  fitness?: number;
  profitFactor?: number;
  winRate?: number;
  dataset?: string;
  [k: string]: any;
}

/** Factores de conversión Múltiplo-ATR -> porcentaje (calibrados con genomas bicentenarios). */
export const ATR_TO_PCT = {
  spacing: 0.005,
  tp: 0.008,
  stop: 0.015,
} as const;

/** Pisos de seguridad para evitar genomas degenerados (spacing/tp/stop en fracción). */
export const GENOME_FLOORS = {
  spacing: 0.003,
  tp: 0.02,
  stop: 0.04,
} as const;

/** Verifica si el objeto ya cumple el contrato de ejecución `Genome`. */
export function isConcreteGenome(g: any): g is Genome {
  return Boolean(g) && typeof g.family === "number" && typeof g.spacing === "number";
}

/** Verifica si el objeto es un genoma ATR evolucionado. */
export function isEvolvedAtrGenome(g: any): g is EvolvedAtrGenome {
  return Boolean(g) && typeof g.k_spacing === "number";
}

/**
 * Normaliza cualquier genoma crudo a la interfaz `Genome` de ejecución.
 * Aplica los pisos de seguridad y cae al genoma por defecto si es inválido.
 */
export function adaptEvolvedAtrGenome(raw: any, fallback: Genome = DEFAULT_GENOME): Genome {
  if (isConcreteGenome(raw)) return raw;
  if (!isEvolvedAtrGenome(raw)) return fallback;

  return {
    family: 3, // RANGE GRID
    lookback: 54,
    entryZ: 2.0,
    levels: 2,
    mult: 1.1,
    spacing: Math.max(GENOME_FLOORS.spacing, (raw.k_spacing || 1.0) * ATR_TO_PCT.spacing),
    tp: Math.max(GENOME_FLOORS.tp, (raw.k_tp || 3.0) * ATR_TO_PCT.tp),
    stop: Math.max(GENOME_FLOORS.stop, (raw.k_stop || 3.5) * ATR_TO_PCT.stop),
  };
}
