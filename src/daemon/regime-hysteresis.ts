/**
 * Regimen de ASIGNACION de capital (lento) vs regimen tactico (rapido).
 *
 * Defecto observado (19-24 de octubre de 2026): el regimen observado persiste solo
 * 5-9 horas y cada cambio mueve el objetivo de capital en ~40 USD (fiat 30-50%), lo que
 * fuerza al normalizador a mover caja real en ambos sentidos cada pocas horas. El ciclo
 * no era perfectamente neutro: el 2026-10-22 el invariante volvio a detectar un exceso
 * de 10.28 USD (reparado y la ventana invalidada por la propia instrumentacion).
 *
 * Regla nueva: el regimen de ASIGNACION (el que decide CUANTO capital va a cada bucket)
 * solo cambia si el regimen observado se mantiene IGUAL durante al menos
 * `minPersistenceMs` (default 12 h) de tiempo real. El regimen tactico (TP, salidas,
 * stops) sigue con la histeresis rapida de `decideAppliedRegime` (20 min).
 */

export interface AllocationRegimeState {
  /** Regimen aplicado a la asignacion de capital. */
  applied: string | null;
  /** Regimen candidato que se viene observando. */
  candidate: string | null;
  /** Timestamp (ms) desde que el candidato se observa de forma continua. */
  candidateSinceMs: number;
  /** Timestamp (ms) del ultimo cambio aplicado. */
  changedAtMs: number;
  /** Tiempo real (ms) que el regimen observado lleva sin cambiar. */
  persistedMs: number;
}

export function initialAllocationRegimeState(): AllocationRegimeState {
  return { applied: null, candidate: null, candidateSinceMs: 0, changedAtMs: 0, persistedMs: 0 };
}

export interface AllocationRegimeOptions {
  /** Permanencia minima del regimen observado antes de mover capital (ms). */
  minPersistenceMs: number;
}

export const DEFAULT_ALLOCATION_REGIME_OPTIONS: AllocationRegimeOptions = {
  minPersistenceMs: 12 * 60 * 60_000,
};

/**
 * Decide el regimen de asignacion. Funcion pura.
 *
 * - El primer regimen observado se aplica de inmediato (arranque).
 * - Un regimen distinto al aplicado debe persistir `minPersistenceMs` para que el
 *   objetivo de capital se mueva: se trackea el tiempo CONTINUO del candidato.
 * - Si el regimen observado vuelve al aplicado, el candidato se resetea.
 */
export function decideAllocationRegime(
  state: AllocationRegimeState,
  observed: string,
  nowMs: number,
  options: AllocationRegimeOptions = DEFAULT_ALLOCATION_REGIME_OPTIONS
): { state: AllocationRegimeState; applied: string; changed: boolean } {
  if (!observed) observed = state.applied || "BALANCED_RANGE";

  if (state.applied === null) {
    return {
      state: {
        applied: observed,
        candidate: observed,
        candidateSinceMs: nowMs,
        changedAtMs: nowMs,
        persistedMs: 0,
      },
      applied: observed,
      changed: true,
    };
  }

  if (observed === state.applied) {
    return {
      state: {
        applied: state.applied,
        candidate: observed,
        candidateSinceMs: nowMs,
        changedAtMs: state.changedAtMs,
        persistedMs: nowMs - state.changedAtMs,
      },
      applied: state.applied,
      changed: false,
    };
  }

  const candidate = observed === state.candidate ? state.candidate : observed;
  const candidateSinceMs = observed === state.candidate ? state.candidateSinceMs : nowMs;
  const persistedMs = nowMs - candidateSinceMs;

  if (persistedMs >= options.minPersistenceMs) {
    return {
      state: {
        applied: observed,
        candidate: observed,
        candidateSinceMs: nowMs,
        changedAtMs: nowMs,
        persistedMs,
      },
      applied: observed,
      changed: true,
    };
  }

  return {
    state: { applied: state.applied, candidate, candidateSinceMs, changedAtMs: state.changedAtMs, persistedMs },
    applied: state.applied,
    changed: false,
  };
}

export interface RegimeHysteresisState {
  /** Regimen efectivamente aplicado a la asignacion. */
  applied: string | null;
  /** Observaciones consecutivas del regimen observado actual. */
  streak: number;
  /** Timestamp (ms) del ultimo cambio aplicado. */
  changedAtMs: number;
  /** Ultimo regimen observado (para contar la racha). */
  observed: string | null;
}

export interface RegimeHysteresisOptions {
  /** Observaciones consecutivas requeridas para aceptar un cambio. */
  minStreak: number;
  /** Permanencia minima (ms) antes de aceptar un cambio. */
  minHoldMs: number;
}

export const DEFAULT_HYSTERESIS: RegimeHysteresisOptions = { minStreak: 3, minHoldMs: 20 * 60_000 };

export function initialHysteresisState(): RegimeHysteresisState {
  return { applied: null, streak: 0, changedAtMs: 0, observed: null };
}

/**
 * Decide el regimen a aplicar. Funcion pura: devuelve el nuevo estado.
 *
 * El primer regimen observado se aplica de inmediato (arranque sin objetivo).
 */
export function decideAppliedRegime(
  state: RegimeHysteresisState,
  observed: string,
  nowMs: number,
  options: RegimeHysteresisOptions = DEFAULT_HYSTERESIS
): { state: RegimeHysteresisState; applied: string; changed: boolean } {
  if (!observed) observed = state.applied || "BALANCED_RANGE";

  if (state.applied === null) {
    return {
      state: { applied: observed, streak: 1, changedAtMs: nowMs, observed },
      applied: observed,
      changed: true,
    };
  }

  if (observed === state.applied) {
    // Coincide con lo aplicado: sin cambio, racha limpia.
    return {
      state: { ...state, streak: 0, observed },
      applied: state.applied,
      changed: false,
    };
  }

  const streak = state.observed === observed ? state.streak + 1 : 1;
  const heldEnoughMs =
    state.changedAtMs === 0 || nowMs - state.changedAtMs >= options.minHoldMs;

  if (streak >= options.minStreak && heldEnoughMs) {
    return {
      state: { applied: observed, streak: 0, changedAtMs: nowMs, observed },
      applied: observed,
      changed: true,
    };
  }

  return {
    state: { ...state, streak, observed },
    applied: state.applied,
    changed: false,
  };
}
