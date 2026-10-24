import { describe, expect, test } from "bun:test";
import { decideAppliedRegime, initialHysteresisState } from "./regime-hysteresis.js";

const OPTS = { minStreak: 3, minHoldMs: 20 * 60_000 };

describe("histeresis de regimen macro", () => {
  test("el primer regimen observado se aplica de inmediato", () => {
    const r = decideAppliedRegime(initialHysteresisState(), "AGGRESSIVE_ACCUMULATION", 1_000, OPTS);
    expect(r.applied).toBe("AGGRESSIVE_ACCUMULATION");
    expect(r.changed).toBe(true);
  });

  test("una alternancia aislada no cambia el regimen aplicado", () => {
    let s = {
      applied: "AGGRESSIVE_ACCUMULATION",
      streak: 0,
      changedAtMs: 0,
      observed: "AGGRESSIVE_ACCUMULATION" as string | null,
    };
    const r = decideAppliedRegime(s, "DEFENSIVE_STRESS", 1_000, OPTS);
    expect(r.applied).toBe("AGGRESSIVE_ACCUMULATION");
    expect(r.changed).toBe(false);
    expect(r.state.streak).toBe(1);
  });

  test("una racha de N observaciones acepta el cambio si ya se cumplio la permanencia", () => {
    const t0 = 0;
    let state = decideAppliedRegime(initialHysteresisState(), "AGGRESSIVE_ACCUMULATION", t0, OPTS).state;
    // Cambio a DEFENSIVE observado 3 veces, con permanencia ya cumplida (pasaron 30 min).
    const t = 30 * 60_000;
    let r = decideAppliedRegime(state, "DEFENSIVE_STRESS", t, OPTS);
    expect(r.changed).toBe(false);
    r = decideAppliedRegime(r.state, "DEFENSIVE_STRESS", t + 10_000, OPTS);
    expect(r.changed).toBe(false);
    r = decideAppliedRegime(r.state, "DEFENSIVE_STRESS", t + 20_000, OPTS);
    expect(r.changed).toBe(true);
    expect(r.applied).toBe("DEFENSIVE_STRESS");
  });

  test("la permanencia minima bloquea el cambio aunque la racha este completa", () => {
    const state = {
      applied: "AGGRESSIVE_ACCUMULATION",
      streak: 2,
      changedAtMs: 100_000,
      observed: "DEFENSIVE_STRESS" as string | null,
    };
    const r = decideAppliedRegime(state, "DEFENSIVE_STRESS", 110_000, OPTS);
    expect(r.changed).toBe(false);
    expect(r.applied).toBe("AGGRESSIVE_ACCUMULATION");
  });

  test("volver al regimen aplicado reinicia la racha", () => {
    const state = {
      applied: "BALANCED_RANGE",
      streak: 2,
      changedAtMs: 0,
      observed: "DEFENSIVE_STRESS" as string | null,
    };
    const r = decideAppliedRegime(state, "BALANCED_RANGE", 1_000, OPTS);
    expect(r.state.streak).toBe(0);
    expect(r.changed).toBe(false);
  });

  test("la racha se reinicia cuando el regimen observado alterna", () => {
    const opts = { minStreak: 3, minHoldMs: 0 };
    let s = decideAppliedRegime(initialHysteresisState(), "AGGRESSIVE_ACCUMULATION", 0, opts).state;
    let r = decideAppliedRegime(s, "DEFENSIVE_STRESS", 1, opts);
    expect(r.state.streak).toBe(1);
    r = decideAppliedRegime(r.state, "BALANCED_RANGE", 2, opts);
    expect(r.state.streak).toBe(1);
    expect(r.changed).toBe(false);
    r = decideAppliedRegime(r.state, "BALANCED_RANGE", 3, opts);
    expect(r.state.streak).toBe(2);
    r = decideAppliedRegime(r.state, "BALANCED_RANGE", 4, opts);
    expect(r.changed).toBe(true);
    expect(r.applied).toBe("BALANCED_RANGE");
  });
});

describe("regimen de asignacion (lento, 12h de persistencia)", () => {
  const OPTS_SLOW = { minPersistenceMs: 12 * 60 * 60_000 };
  test("el primer regimen se aplica de inmediato", async () => {
    const { decideAllocationRegime, initialAllocationRegimeState } = await import("./regime-hysteresis.js");
    const r = decideAllocationRegime(initialAllocationRegimeState(), "AGGRESSIVE_ACCUMULATION", 1_000, OPTS_SLOW);
    expect(r.applied).toBe("AGGRESSIVE_ACCUMULATION");
    expect(r.changed).toBe(true);
  });

  test("un regimen que persiste horas no mueve capital antes de las 12h", async () => {
    const { decideAllocationRegime, initialAllocationRegimeState } = await import("./regime-hysteresis.js");
    const t0 = 0;
    let state = decideAllocationRegime(initialAllocationRegimeState(), "AGGRESSIVE_ACCUMULATION", t0, OPTS_SLOW).state;
    let r = decideAllocationRegime(state, "DEFENSIVE_STRESS", t0 + 6 * 3_600_000, OPTS_SLOW);
    expect(r.changed).toBe(false);
    expect(r.state.persistedMs).toBe(0); // el candidato recien arranca
    r = decideAllocationRegime(r.state, "DEFENSIVE_STRESS", t0 + 11 * 3_600_000, OPTS_SLOW);
    expect(r.changed).toBe(false);
    expect(r.state.persistedMs).toBe(5 * 3_600_000);
  });

  test("a las 12h de persistencia continua el cambio se aplica", async () => {
    const { decideAllocationRegime, initialAllocationRegimeState } = await import("./regime-hysteresis.js");
    const t0 = 0;
    let state = decideAllocationRegime(initialAllocationRegimeState(), "AGGRESSIVE_ACCUMULATION", t0, OPTS_SLOW).state;
    let r = decideAllocationRegime(state, "DEFENSIVE_STRESS", t0 + 6 * 3_600_000, OPTS_SLOW);
    r = decideAllocationRegime(r.state, "DEFENSIVE_STRESS", t0 + 18 * 3_600_000 + 1, OPTS_SLOW);
    expect(r.changed).toBe(true);
    expect(r.applied).toBe("DEFENSIVE_STRESS");
  });

  test("una alternancia breve reinicia el reloj del candidato", async () => {
    const { decideAllocationRegime, initialAllocationRegimeState } = await import("./regime-hysteresis.js");
    const t0 = 0;
    let state = decideAllocationRegime(initialAllocationRegimeState(), "AGGRESSIVE_ACCUMULATION", t0, OPTS_SLOW).state;
    // 10h de DEFENSIVE, 1h de AGGRESSIVE, 10h mas de DEFENSIVE: NO debe aplicar DEFENSIVE.
    let r = decideAllocationRegime(state, "DEFENSIVE_STRESS", t0 + 10 * 3_600_000, OPTS_SLOW);
    r = decideAllocationRegime(r.state, "AGGRESSIVE_ACCUMULATION", t0 + 11 * 3_600_000, OPTS_SLOW);
    expect(r.state.candidate).toBe("AGGRESSIVE_ACCUMULATION");
    r = decideAllocationRegime(r.state, "DEFENSIVE_STRESS", t0 + 21 * 3_600_000, OPTS_SLOW);
    expect(r.changed).toBe(false);
    expect(r.state.persistedMs).toBe(0); // el candidato reinicio al alternar
  });

  test("volver al aplicado limpia el candidato", async () => {
    const { decideAllocationRegime, initialAllocationRegimeState } = await import("./regime-hysteresis.js");
    const t0 = 0;
    let state = decideAllocationRegime(initialAllocationRegimeState(), "BALANCED_RANGE", t0, OPTS_SLOW).state;
    let r = decideAllocationRegime(state, "DEFENSIVE_STRESS", t0 + 5 * 3_600_000, OPTS_SLOW);
    expect(r.state.candidate).toBe("DEFENSIVE_STRESS");
    r = decideAllocationRegime(r.state, "BALANCED_RANGE", t0 + 6 * 3_600_000, OPTS_SLOW);
    expect(r.state.candidate).toBe("BALANCED_RANGE");
    expect(r.changed).toBe(false);
  });
});
