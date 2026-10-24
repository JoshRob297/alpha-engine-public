/**
 * Normalizacion de capital: alinea el capital realmente retenido por cada bot CEX
 * con el objetivo que le asigna la politica de regimen.
 *
 * Motivo: el asignador fijaba `allocatedCashUsd` (una etiqueta) pero nunca movia
 * caja. Los bots creados bajo una politica previa conservaban su dinero, de modo que
 * el capital desplegado excedia el presupuesto del regimen (evidencia: desplegado
 * 121.62 USD contra 100 de politica, hueco de conservacion de 23.09 USD sobre 200).
 * El excedente se retira a una reserva real y contabilizada en lugar de quedar
 * implicito, para que la suma de buckets cuadre con el capital inicial mas el PnL.
 *
 * Funcion pura: no toca estado, solo decide los movimientos.
 */

export interface NormalizableBot {
  ticker: string;
  cashUsd: number;
  inventoryValueUsd: number;
  targetUsd: number;
}

export interface NormalizationMove {
  ticker: string;
  /** Positivo = ingresa caja al bot; negativo = la retira hacia la reserva. */
  deltaUsd: number;
  direction: "TO_RESERVE" | "FROM_RESERVE";
}

export interface NormalizationPlan {
  moves: NormalizationMove[];
  reserveDeltaUsd: number;
  overAllocatedUsd: number;
  underAllocatedUsd: number;
}

export function planCapitalNormalization(
  bots: NormalizableBot[],
  availableReserveUsd: number,
  tolerance = 0.05
): NormalizationPlan {
  const excesses: Array<{ bot: NormalizableBot; amount: number }> = [];
  const deficits: Array<{ bot: NormalizableBot; amount: number }> = [];

  for (const bot of bots) {
    if (!bot.targetUsd || bot.targetUsd <= 0) continue;
    const nav = bot.cashUsd + bot.inventoryValueUsd;
    const toleranceUsd = bot.targetUsd * tolerance;

    if (nav - bot.targetUsd > toleranceUsd) {
      // Solo se puede retirar caja disponible: el inventario no se liquida aqui.
      const withdrawable = Math.max(0, Math.min(nav - bot.targetUsd, bot.cashUsd));
      if (withdrawable > 0) excesses.push({ bot, amount: withdrawable });
    } else if (bot.targetUsd - nav > toleranceUsd) {
      deficits.push({ bot, amount: bot.targetUsd - nav });
    }
  }

  const overAllocatedUsd = excesses.reduce((a, e) => a + e.amount, 0);
  const underAllocatedUsd = deficits.reduce((a, d) => a + d.amount, 0);

  const moves: NormalizationMove[] = excesses.map((e) => ({
    ticker: e.bot.ticker,
    deltaUsd: -round(e.amount),
    direction: "TO_RESERVE" as const,
  }));

  let pool = availableReserveUsd + overAllocatedUsd;
  let deployed = 0;
  for (const d of deficits) {
    if (pool <= 0) break;
    const give = Math.min(d.amount, pool);
    pool -= give;
    deployed += give;
    moves.push({ ticker: d.bot.ticker, deltaUsd: round(give), direction: "FROM_RESERVE" });
  }

  const reserveDeltaUsd = round(overAllocatedUsd - deployed);
  return { moves, reserveDeltaUsd, overAllocatedUsd: round(overAllocatedUsd), underAllocatedUsd: round(underAllocatedUsd) };
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}

export interface NormalizableDexSlot {
  key: string;
  currentCapitalUsd: number;
  initialCapitalUsd: number;
}

export interface DexNormalizationMove {
  key: string;
  newCurrentCapitalUsd: number;
  newInitialCapitalUsd: number;
  deltaUsd: number;
}

export interface DexNormalizationPlan {
  moves: DexNormalizationMove[];
  reserveDeltaUsd: number;
  overAllocatedUsd: number;
  underAllocatedUsd: number;
  unfundedDeficitUsd: number;
}

/**
 * Normaliza el capital de los slots DEX contra el presupuesto del regimen.
 *
 * Reglas:
 *  - Excedente: se retira capital de los slots (proporcional) hacia la reserva capturada.
 *  - Deficit: se rellena SOLO con caja ya existente (nunca se acuna capital).
 *  - Lo que no se puede financiar se reporta como `unfundedDeficitUsd`.
 *
 * El retiro es contable (el modelo no ejecuta withdraw on-chain en PAPER), pero queda
 * registrado como movimiento de reserva para que la suma de buckets cuadre.
 */
export function planDexCapitalNormalization(
  slots: NormalizableDexSlot[],
  targetTotalUsd: number,
  availableCashUsd: number,
  tolerance = 0.05
): DexNormalizationPlan {
  const total = slots.reduce((a, s) => a + s.currentCapitalUsd, 0);
  const moves: DexNormalizationMove[] = [];

  if (!targetTotalUsd || targetTotalUsd <= 0 || slots.length === 0) {
    return { moves, reserveDeltaUsd: 0, overAllocatedUsd: 0, underAllocatedUsd: 0, unfundedDeficitUsd: 0 };
  }

  const toleranceUsd = targetTotalUsd * tolerance;
  const delta = total - targetTotalUsd;

  if (delta > toleranceUsd) {
    const factor = targetTotalUsd / total;
    let withdrawn = 0;
    for (const s of slots) {
      const newCurrent = round(s.currentCapitalUsd * factor);
      const newInitial = round(s.initialCapitalUsd * factor);
      const moveDelta = round(newCurrent - s.currentCapitalUsd);
      withdrawn += -moveDelta;
      moves.push({ key: s.key, newCurrentCapitalUsd: newCurrent, newInitialCapitalUsd: newInitial, deltaUsd: moveDelta });
    }
    return {
      moves,
      reserveDeltaUsd: round(withdrawn),
      overAllocatedUsd: round(withdrawn),
      underAllocatedUsd: 0,
      unfundedDeficitUsd: 0,
    };
  }

  if (-delta > toleranceUsd) {
    const deficit = -delta;
    const funded = Math.max(0, Math.min(deficit, availableCashUsd));
    if (funded <= 0) {
      // Sin caja disponible no se acuna capital: se reporta el deficit sin financiar.
      return { moves, reserveDeltaUsd: 0, overAllocatedUsd: 0, underAllocatedUsd: 0, unfundedDeficitUsd: round(deficit) };
    }
    const factor = (total + funded) / total;
    for (const s of slots) {
      const newCurrent = round(s.currentCapitalUsd * factor);
      const newInitial = round(s.initialCapitalUsd * factor);
      moves.push({
        key: s.key,
        newCurrentCapitalUsd: newCurrent,
        newInitialCapitalUsd: newInitial,
        deltaUsd: round(newCurrent - s.currentCapitalUsd),
      });
    }
    return {
      moves,
      reserveDeltaUsd: round(-funded),
      overAllocatedUsd: 0,
      underAllocatedUsd: round(funded),
      unfundedDeficitUsd: round(deficit - funded),
    };
  }

  return { moves, reserveDeltaUsd: 0, overAllocatedUsd: 0, underAllocatedUsd: 0, unfundedDeficitUsd: 0 };
}
