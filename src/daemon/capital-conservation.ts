/**
 * Auditoria de conservacion de capital.
 *
 * Modelo de tres estados de dinero:
 *   - desplegado (bots CEX + slots DEX), marcado a mercado,
 *   - reserva capturada (`unallocatedCashUsd`), una ETIQUETA de cuanto capital se
 *     retiro de los buckets a la caja,
 *   - caja no desplegada, residuo derivado.
 *
 * El total contable confiable es `capital + PnL realizado - valor desplegado`:
 * eso es la caja que existe de verdad. La reserva capturada es una etiqueta que
 * puede sobre-creditarse (defecto real observado: 236.43 USD de reserva contra
 * 96.77 USD de caja existente, 2.9 dias despues del arranque de la ventana).
 *
 * Este modulo detecta la incoherencia y calcula la correccion. La reparacion es
 * legitima porque la posicion marcada a mercado es la fuente de verdad y la
 * etiqueta de reserva es el residuo, no al reves.
 */

export interface BucketSnapshot {
  /** Capital nominal inicial (constante). */
  capitalUsd: number;
  /** PnL realizado neto de costes, del ledger de operaciones cerradas. */
  realizedNetUsd: number;
  /** Valor a mercado de lo desplegado (CEX NAV + capital DEX). */
  deployedValueUsd: number;
  /** Etiqueta de reserva capturada por normalizacion (`unallocatedCashUsd`). */
  capturedReserveUsd: number;
}

export interface ConservationReport {
  /** Caja total existente = capital + PnL realizado - desplegado. */
  totalCashUsd: number;
  /** Residuo derivado = caja total - reserva capturada. */
  derivedUntradedReserveUsd: number;
  /** Cuanto excede la etiqueta de reserva a la caja real (mint acumulado). */
  overshootUsd: number;
  /** Cuanto queda por debajo (sintoma de valor destruido o retirado sin credito). */
  shortfallUsd: number;
  /** Fraccion de la caja total que representa la desviacion etiqueta vs caja. */
  overshootPct: number;
  /** La etiqueta no puede sostenerse: hay que corregirla a totalCashUsd. */
  needsRepair: boolean;
  /** Valor al que debe quedar la reserva capturada si needsRepair. */
  repairToUsd: number;
  severity: "OK" | "WARN" | "CRITICAL";
}

/**
 * @param toleranceUsd Tolerancia absoluta en USD (redondeos y marcado a mercado).
 */
export function auditCapitalConservation(
  snapshot: BucketSnapshot,
  toleranceUsd = 0.5
): ConservationReport {
  const totalCashUsd = round(snapshot.capitalUsd + snapshot.realizedNetUsd - snapshot.deployedValueUsd);
  const derivedUntradedReserveUsd = round(totalCashUsd - snapshot.capturedReserveUsd);
  const overshootUsd = round(Math.max(0, snapshot.capturedReserveUsd - totalCashUsd));
  const shortfallUsd = round(Math.max(0, totalCashUsd - snapshot.capturedReserveUsd));
  const overshootPct =
    snapshot.capitalUsd > 0 ? round((overshootUsd / snapshot.capitalUsd) * 100) : 0;

  const needsRepair = overshootUsd > toleranceUsd;
  const severity: ConservationReport["severity"] = needsRepair
    ? overshootUsd > snapshot.capitalUsd * 0.02
      ? "CRITICAL"
      : "WARN"
    : "OK";

  return {
    totalCashUsd,
    derivedUntradedReserveUsd,
    overshootUsd,
    shortfallUsd,
    overshootPct,
    needsRepair,
    repairToUsd: needsRepair ? totalCashUsd : round(snapshot.capturedReserveUsd),
    severity,
  };
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/**
 * Holgura no etiquetada (punto ciego del invariante agregado).
 *
 * `auditCapitalConservation` solo detecta cuando la etiqueta de reserva EXCEDE la caja
 * real. Si existe holgura (`derivedUntradedReserveUsd > 0`), acuñar un monto menor a esa
 * holgura es invisible para el agregado: el capital aparece "en la caja" que nunca se
 * etiqueto. En una corrida sana la holgura es chica (el normalizador mueve el excedente a
 * la reserva capturada y rellena deficits); una holgura persistente y grande es sintoma de
 * valor creado sin causa o de normalizacion detenida.
 *
 * Este detector es de SEÑAL (no repara): el limite es una politica, no una identidad.
 */
export function auditReserveSlack(
  derivedUntradedReserveUsd: number,
  capitalUsd: number,
  reserveTargetUsd: number,
  options: { minAbsoluteUsd?: number; maxShareOfTarget?: number } = {}
): { excessUsd: number; suspicious: boolean; thresholdUsd: number } {
  const minAbsoluteUsd = options.minAbsoluteUsd ?? 2;
  const maxShareOfTarget = options.maxShareOfTarget ?? 0.15;
  const thresholdUsd = Math.max(minAbsoluteUsd, reserveTargetUsd * maxShareOfTarget);
  const excessUsd = round(Math.max(0, derivedUntradedReserveUsd - thresholdUsd));
  return {
    excessUsd,
    suspicious: excessUsd > 0 && capitalUsd > 0,
    thresholdUsd: round(thresholdUsd),
  };
}
