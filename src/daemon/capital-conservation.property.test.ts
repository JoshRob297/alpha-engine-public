/**
 * Test de propiedad (fuzz determinista) de conservacion de capital.
 *
 * Objetivo: demostrar que el MODELO contable de buckets conserva el capital bajo
 * secuencias aleatorias de operaciones (apertura/cierre de slots DEX, normalizacion
 * CEX/DEX, financiamiento de deficits, PnL y churn de regimen) y que el test detecta
 * la clase de defecto del incidente del 2026-10-19 (mint de capital inexistente).
 *
 * Invariantes verificados tras CADA operacion:
 *   - auditCapitalConservation(...).needsRepair === false  (la etiqueta nunca excede la caja)
 *   - deployed + reserva + residuoDerivado === capital + PnL realizado (tolerancia 1e-6)
 *   - reserva >= -1e-9  (nunca negativa)
 *
 * Control negativo: mintDexSlotWithoutDebit crea un slot SIN debitar la reserva y debe
 * disparar needsRepair === true (caja real insuficiente para sostener la etiqueta).
 */

import { describe, expect, test } from "bun:test";
import {
  auditCapitalConservation,
  type BucketSnapshot,
  type ConservationReport,
} from "./capital-conservation.js";
import {
  planCapitalNormalization,
  planDexCapitalNormalization,
} from "./capital-normalizer.js";
import {
  decideAppliedRegime,
  initialHysteresisState,
  type RegimeHysteresisState,
} from "./regime-hysteresis.js";

// ---------------------------------------------------------------------------
// PRNG determinista (LCG 32 bits). No usa Math.random global.
// ---------------------------------------------------------------------------

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function rngUsd(rng: () => number, min: number, max: number): number {
  return round4(min + rng() * (max - min));
}

function rngInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

/** Redondeo a 4 decimales, igual que los modulos reales, para que las identidades cierren. */
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Modelo de buckets en memoria (espejo del estado del motor)
// ---------------------------------------------------------------------------

interface ModelBot {
  ticker: string;
  cashUsd: number;
  inventoryValueUsd: number;
  targetUsd: number;
}

interface ModelDexSlot {
  key: string;
  currentCapitalUsd: number;
  initialCapitalUsd: number;
}

interface ModelState {
  capitalUsd: number;
  realizedNetUsd: number;
  bots: ModelBot[];
  dexSlots: ModelDexSlot[];
  /** Etiqueta de reserva capturada (`unallocatedCashUsd`). */
  reserveCapturedUsd: number;
  /** Deficit declarado y no financiado (nunca se acuna capital para cubrirlo). */
  unfundedDeficitUsd: number;
  hysteresis: RegimeHysteresisState;
  nowMs: number;
}

/** Desplegado marcado a mercado = bots (caja + inventario) + capital de slots DEX. */
function totalDeployedUsd(state: ModelState): number {
  let deployed = 0;
  for (const bot of state.bots) deployed += bot.cashUsd + bot.inventoryValueUsd;
  for (const slot of state.dexSlots) deployed += slot.currentCapitalUsd;
  return round4(deployed);
}

function snapshotOf(state: ModelState): BucketSnapshot {
  return {
    capitalUsd: state.capitalUsd,
    realizedNetUsd: state.realizedNetUsd,
    deployedValueUsd: totalDeployedUsd(state),
    capturedReserveUsd: state.reserveCapturedUsd,
  };
}

// Tolerancia del auditor: los modulos reales redondean a 4 decimales, y la
// normalizacion proporcional DEX acumula error de redondeo ~1e-4 por slot.
const CONSERVATION_TOLERANCE_USD = 0.5;

function createModelState(): ModelState {
  const bots: ModelBot[] = [
    { ticker: "BTC", cashUsd: 20, inventoryValueUsd: 5, targetUsd: 45 },
    { ticker: "ETH", cashUsd: 10, inventoryValueUsd: 3, targetUsd: 30 },
    { ticker: "SOL", cashUsd: 5, inventoryValueUsd: 2, targetUsd: 20 },
  ];
  const deployed = bots.reduce((a, b) => a + b.cashUsd + b.inventoryValueUsd, 0);
  return {
    capitalUsd: 200,
    realizedNetUsd: 0,
    bots,
    dexSlots: [],
    // La etiqueta de reserva arranca cuadrada con la caja real.
    reserveCapturedUsd: round4(200 - deployed),
    unfundedDeficitUsd: 0,
    hysteresis: initialHysteresisState(),
    nowMs: 1_700_000_000_000,
  };
}

// ---------------------------------------------------------------------------
// Invariantes
// ---------------------------------------------------------------------------

function checkInvariants(
  state: ModelState,
  seed: number,
  opIndex: number,
  label: string,
  toleranceUsd = CONSERVATION_TOLERANCE_USD
): ConservationReport {
  const deployedUsd = totalDeployedUsd(state);
  const report = auditCapitalConservation(
    {
      capitalUsd: state.capitalUsd,
      realizedNetUsd: state.realizedNetUsd,
      deployedValueUsd: deployedUsd,
      capturedReserveUsd: state.reserveCapturedUsd,
    },
    toleranceUsd
  );

  const ctx = `seed=${seed} op=${opIndex} [${label}] deployed=${deployedUsd} reserva=${state.reserveCapturedUsd} cajaReal=${report.totalCashUsd}`;

  // La etiqueta nunca puede exceder la caja real.
  expect(report.needsRepair, `needsRepair inesperado: ${ctx}`).toBe(false);

  // La reserva jamas es negativa.
  expect(state.reserveCapturedUsd >= -1e-9, `reserva negativa: ${ctx}`).toBe(true);

  // Identidad contable exacta.
  const lhs = deployedUsd + state.reserveCapturedUsd + report.derivedUntradedReserveUsd;
  const rhs = state.capitalUsd + state.realizedNetUsd;
  expect(
    Math.abs(lhs - rhs) <= 1e-6,
    `identidad rota: ${ctx} lhs=${lhs} rhs=${rhs} diff=${lhs - rhs}`
  ).toBe(true);

  return report;
}

// ---------------------------------------------------------------------------
// Operaciones (usan las funciones REALES del repo donde aplica)
// ---------------------------------------------------------------------------

/** Financia el slot desde la reserva. Si no hay caja, no abre. */
function openDexSlot(state: ModelState, key: string, capitalUsd: number): boolean {
  const requested = round4(capitalUsd);
  const funded = round4(Math.min(requested, Math.max(0, state.reserveCapturedUsd)));
  if (funded <= 0) return false;
  state.reserveCapturedUsd = round4(state.reserveCapturedUsd - funded);
  state.dexSlots.push({ key, currentCapitalUsd: funded, initialCapitalUsd: funded });
  return true;
}

/** Devuelve el capital actual del slot a la reserva y lo borra. */
function closeDexSlot(state: ModelState, key: string): boolean {
  const idx = state.dexSlots.findIndex((s) => s.key === key);
  if (idx < 0) return false;
  const slot = state.dexSlots[idx]!;
  state.reserveCapturedUsd = round4(state.reserveCapturedUsd + slot.currentCapitalUsd);
  state.dexSlots.splice(idx, 1);
  return true;
}

/** Normaliza DEX contra el presupuesto del regimen usando la funcion real. */
function normalizeDex(state: ModelState, targetTotalUsd: number): void {
  const plan = planDexCapitalNormalization(
    state.dexSlots.map((s) => ({
      key: s.key,
      currentCapitalUsd: s.currentCapitalUsd,
      initialCapitalUsd: s.initialCapitalUsd,
    })),
    targetTotalUsd,
    state.reserveCapturedUsd
  );
  for (const move of plan.moves) {
    const slot = state.dexSlots.find((s) => s.key === move.key);
    if (!slot) continue;
    slot.currentCapitalUsd = move.newCurrentCapitalUsd;
    slot.initialCapitalUsd = move.newInitialCapitalUsd;
  }
  state.reserveCapturedUsd = round4(state.reserveCapturedUsd + plan.reserveDeltaUsd);
  state.unfundedDeficitUsd = round4(state.unfundedDeficitUsd + plan.unfundedDeficitUsd);
}

/** Normaliza CEX contra los objetivos por bot usando la funcion real. */
function normalizeCex(state: ModelState): void {
  const plan = planCapitalNormalization(
    state.bots.map((b) => ({
      ticker: b.ticker,
      cashUsd: b.cashUsd,
      inventoryValueUsd: b.inventoryValueUsd,
      targetUsd: b.targetUsd,
    })),
    state.reserveCapturedUsd
  );
  for (const move of plan.moves) {
    const bot = state.bots.find((b) => b.ticker === move.ticker);
    if (!bot) continue;
    bot.cashUsd = round4(bot.cashUsd + move.deltaUsd);
  }
  state.reserveCapturedUsd = round4(state.reserveCapturedUsd + plan.reserveDeltaUsd);
}

/**
 * Financia el deficit de un slot con caja existente. Lo que no alcanza queda
 * declarado en `unfundedDeficitUsd` sin crear capital.
 */
function fundSlotFromDeficit(state: ModelState, key: string, desiredCapitalUsd: number): void {
  const slot = state.dexSlots.find((s) => s.key === key);
  if (!slot) return;
  const gap = round4(Math.max(0, round4(desiredCapitalUsd) - slot.currentCapitalUsd));
  const funded = round4(Math.min(gap, Math.max(0, state.reserveCapturedUsd)));
  slot.currentCapitalUsd = round4(slot.currentCapitalUsd + funded);
  slot.initialCapitalUsd = round4(slot.initialCapitalUsd + funded);
  state.reserveCapturedUsd = round4(state.reserveCapturedUsd - funded);
  state.unfundedDeficitUsd = round4(state.unfundedDeficitUsd + (gap - funded));
}

/** PnL realizado: entra al ledger y al cash del bot para que el modelo siga cerrando. */
function accruePnl(state: ModelState, ticker: string, deltaUsd: number): void {
  const bot = state.bots.find((b) => b.ticker === ticker);
  if (!bot) return;
  let delta = round4(deltaUsd);
  if (delta < 0) delta = round4(Math.max(delta, -bot.cashUsd));
  bot.cashUsd = round4(bot.cashUsd + delta);
  state.realizedNetUsd = round4(state.realizedNetUsd + delta);
}

/** Churn de regimen mediado por histeresis: solo reescribe objetivos si hay cambio aplicado. */
const REGIME_BUDGET_USD = 150;
const REGIME_WEIGHTS: Record<string, Record<string, number>> = {
  BALANCED_RANGE: { BTC: 0.3, ETH: 0.2, SOL: 0.15 },
  TREND_UP: { BTC: 0.4, ETH: 0.25, SOL: 0.1 },
  HIGH_VOL: { BTC: 0.15, ETH: 0.1, SOL: 0.05 },
};

function advanceRegime(state: ModelState, observed: string, elapsedMs: number): boolean {
  state.nowMs += elapsedMs;
  const result = decideAppliedRegime(state.hysteresis, observed, state.nowMs);
  state.hysteresis = result.state;
  if (!result.changed) return false;
  const weights = REGIME_WEIGHTS[result.applied];
  if (!weights) return false;
  for (const bot of state.bots) {
    const weight = weights[bot.ticker];
    if (weight === undefined) continue;
    bot.targetUsd = round4(REGIME_BUDGET_USD * weight);
  }
  return true;
}

/** DEFECTO DEL INCIDENTE: crea el slot acreditando capital SIN debitar la reserva. */
function mintDexSlotWithoutDebit(state: ModelState, key: string, capitalUsd: number): void {
  state.dexSlots.push({
    key,
    currentCapitalUsd: round4(capitalUsd),
    initialCapitalUsd: round4(capitalUsd),
  });
}

// ---------------------------------------------------------------------------
// Dispatcher aleatorio
// ---------------------------------------------------------------------------

interface OpContext {
  nextKey: () => string;
}

function applyRandomOp(state: ModelState, rng: () => number, ctx: OpContext): string {
  const roll = rng();
  const hasSlots = state.dexSlots.length > 0;
  const hasBots = state.bots.length > 0;

  if (roll < 0.18) {
    // Apertura de slot DEX financiada con reserva.
    const key = ctx.nextKey();
    const amount = rngUsd(rng, 5, 60);
    const opened = openDexSlot(state, key, amount);
    return opened ? `openDexSlot(${key}, ${amount})` : `openDexSlot(${key}) SIN CAJA`;
  }

  if (roll < 0.33 && hasSlots) {
    const slot = pick(rng, state.dexSlots);
    closeDexSlot(state, slot.key);
    return `closeDexSlot(${slot.key})`;
  }

  if (roll < 0.51 && hasSlots) {
    const target = rngUsd(rng, 10, 180);
    normalizeDex(state, target);
    return `normalizeDex(target=${target})`;
  }

  if (roll < 0.69 && hasBots) {
    normalizeCex(state);
    return "normalizeCex()";
  }

  if (roll < 0.81 && hasSlots) {
    const slot = pick(rng, state.dexSlots);
    const desired = round4(slot.currentCapitalUsd + rngUsd(rng, 1, 40));
    fundSlotFromDeficit(state, slot.key, desired);
    return `fundSlotFromDeficit(${slot.key}, ${desired})`;
  }

  if (roll < 0.95 && hasBots) {
    const bot = pick(rng, state.bots);
    const delta = rngUsd(rng, -6, 8);
    accruePnl(state, bot.ticker, delta);
    return `accruePnl(${bot.ticker}, ${delta})`;
  }

  const observed = pick(rng, ["BALANCED_RANGE", "TREND_UP", "HIGH_VOL"]);
  const elapsed = rngInt(rng, 0, 45) * 60_000;
  const changed = advanceRegime(state, observed, elapsed);
  return `advanceRegime(${observed}, +${elapsed}ms)${changed ? " CAMBIO" : ""}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("propiedad: conservacion de capital bajo operaciones aleatorias", () => {
  test("200 secuencias de 20 operaciones conservan el capital y no acunan reserva", () => {
    const SEQUENCES = 200;
    const OPS_PER_SEQUENCE = 20;

    for (let seq = 0; seq < SEQUENCES; seq++) {
      const seed = 0xc0ffee + seq * 7919;
      const rng = createRng(seed);
      const state = createModelState();
      let keyCounter = 0;
      const ctx: OpContext = { nextKey: () => `dex-${keyCounter++}` };

      checkInvariants(state, seed, 0, "estado inicial");

      for (let op = 1; op <= OPS_PER_SEQUENCE; op++) {
        const label = applyRandomOp(state, rng, ctx);
        checkInvariants(state, seed, op, label);
      }

      // Control negativo por secuencia: acunar capital sin debito SIEMPRE debe detectarse.
      const before = auditCapitalConservation(snapshotOf(state), CONSERVATION_TOLERANCE_USD);
      const slack = before.derivedUntradedReserveUsd; // caja real aun no etiquetada
      mintDexSlotWithoutDebit(state, `mint-${seq}`, slack + 5);
      const after = auditCapitalConservation(snapshotOf(state), CONSERVATION_TOLERANCE_USD);
      expect(
        after.needsRepair,
        `control negativo no detectado: seed=${seed} slack=${slack}`
      ).toBe(true);
      expect(after.overshootUsd, `overshoot insuficiente: seed=${seed}`).toBeGreaterThan(0.5);
    }
  });

  test("el defecto del incidente (mint sin debito) se detecta sobre un estado cuadrado", () => {
    const state = createModelState();
    const clean = auditCapitalConservation(snapshotOf(state));
    expect(clean.needsRepair).toBe(false);

    // Abrir un slot legitimo retira la caja de la reserva: sigue cuadrado.
    expect(openDexSlot(state, "dex-legit", 25)).toBe(true);
    const legit = auditCapitalConservation(snapshotOf(state));
    expect(legit.needsRepair, "la apertura legitima no debe disparar reparacion").toBe(false);

    // El mismo slot, ahora acunado sin debito, deja la etiqueta por encima de la caja.
    mintDexSlotWithoutDebit(state, "dex-mint", 25);
    const minted = auditCapitalConservation(snapshotOf(state));
    expect(minted.needsRepair).toBe(true);
    expect(minted.overshootUsd).toBeCloseTo(25, 4);
    expect(minted.severity).toBe("CRITICAL");
    expect(minted.repairToUsd).toBeCloseTo(minted.totalCashUsd, 4);
  });

  test("el deficit DEX sin caja queda declarado sin crear capital", () => {
    const state = createModelState();
    // Drenar la reserva dentro de slots para dejar caja disponible en cero.
    let counter = 0;
    while (state.reserveCapturedUsd > 0.01) {
      if (!openDexSlot(state, `drain-${counter++}`, state.reserveCapturedUsd)) break;
    }
    checkInvariants(state, 42, 0, "reserva drenada");

    const slotsTotal = state.dexSlots.reduce((a, s) => a + s.currentCapitalUsd, 0);
    const unfundedBefore = state.unfundedDeficitUsd;
    normalizeDex(state, slotsTotal + 50);
    checkInvariants(state, 42, 1, "normalizeDex sin caja");

    expect(state.unfundedDeficitUsd).toBeGreaterThan(unfundedBefore);
    expect(state.unfundedDeficitUsd).toBeCloseTo(50, 2);
  });
});
