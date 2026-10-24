/**
 * Ventana de medicion out-of-sample del periodo Paper.
 *
 * Con GENOME_FREEZE=true se congelan:
 *   - la persistencia de genomas (JIT evolution),
 *   - la recalibracion reactiva (SETS trigger),
 *   - la evolucion al onboardear un activo nuevo.
 *
 * Razon: sin congelar, la corrida deja de ser out-of-sample (los genomas se
 * re-ajustan con datos que incluyen el propio periodo de prueba). Con esto la
 * ventana es un test limpio y auditable.
 */

/** Cierres necesarios para rechazar expectancy=0 al 95% con el efecto observado. */
export const MEASUREMENT_TARGET_CLOSED_TRADES = 191;

export function isGenomeFrozen(): boolean {
  return process.env.GENOME_FREEZE === "true";
}

export function getMeasurementWindow() {
  const frozen = isGenomeFrozen();
  return {
    genomeFrozen: frozen,
    startedAt: process.env.MEASUREMENT_STARTED_AT || null,
    targetClosedTrades: MEASUREMENT_TARGET_CLOSED_TRADES,
    state: frozen
      ? "MEDICION_OOS_ACTIVA"
      : "MEDICION_OOS_INACTIVA (genomas libres de re-evolucionar: resultados no son OOS)",
  };
}

export function logMeasurementWindowBanner(log: (msg: string) => void = console.log): void {
  const w = getMeasurementWindow();
  log(
    `[MEASUREMENT WINDOW] ${w.state} | inicio=${w.startedAt || "n/d"} | objetivo=${w.targetClosedTrades} cierres`
  );
}
