import { describe, expect, test } from "bun:test";
import { planCapitalNormalization, planDexCapitalNormalization } from "./capital-normalizer.js";

describe("capital-normalizer", () => {
  test("retira el excedente sobre el objetivo hacia la reserva", () => {
    const plan = planCapitalNormalization(
      [{ ticker: "BTC", cashUsd: 80, inventoryValueUsd: 10, targetUsd: 50 }],
      0
    );
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0].deltaUsd).toBe(-40);
    expect(plan.moves[0].direction).toBe("TO_RESERVE");
    expect(plan.reserveDeltaUsd).toBe(40);
    expect(plan.overAllocatedUsd).toBe(40);
  });

  test("no toca al bot dentro de la tolerancia", () => {
    const plan = planCapitalNormalization(
      [{ ticker: "BTC", cashUsd: 50, inventoryValueUsd: 2, targetUsd: 50 }],
      0
    );
    expect(plan.moves).toHaveLength(0);
    expect(plan.reserveDeltaUsd).toBe(0);
  });

  test("financia el deficit con la reserva disponible", () => {
    const plan = planCapitalNormalization(
      [{ ticker: "SOL", cashUsd: 10, inventoryValueUsd: 0, targetUsd: 30 }],
      25
    );
    expect(plan.moves[0]).toMatchObject({ ticker: "SOL", deltaUsd: 20, direction: "FROM_RESERVE" });
    expect(plan.reserveDeltaUsd).toBe(-20);
    expect(plan.underAllocatedUsd).toBe(20);
  });

  test("el excedente de un bot financia el deficit de otro", () => {
    const plan = planCapitalNormalization(
      [
        { ticker: "BTC", cashUsd: 100, inventoryValueUsd: 0, targetUsd: 50 },
        { ticker: "SOL", cashUsd: 0, inventoryValueUsd: 5, targetUsd: 40 },
      ],
      0
    );
    const btc = plan.moves.find((m) => m.ticker === "BTC")!;
    const sol = plan.moves.find((m) => m.ticker === "SOL")!;
    expect(btc.deltaUsd).toBe(-50);
    expect(sol.deltaUsd).toBe(35);
    expect(plan.reserveDeltaUsd).toBe(15);
  });

  test("no retira inventario: limita la retirada a la caja disponible", () => {
    const plan = planCapitalNormalization(
      [{ ticker: "AERO", cashUsd: 3, inventoryValueUsd: 40, targetUsd: 10 }],
      0
    );
    expect(plan.moves[0].deltaUsd).toBe(-3);
    expect(plan.overAllocatedUsd).toBe(3);
  });

  test("ignora bots sin objetivo asignado", () => {
    const plan = planCapitalNormalization(
      [{ ticker: "X", cashUsd: 100, inventoryValueUsd: 0, targetUsd: 0 }],
      0
    );
    expect(plan.moves).toHaveLength(0);
  });
});

describe("capital-normalizer / slots DEX", () => {
  const slot = (key: string, cur: number) => ({ key, currentCapitalUsd: cur, initialCapitalUsd: cur });

  test("retira el excedente proporcional del presupuesto DEX", () => {
    const plan = planDexCapitalNormalization([slot("A", 30), slot("B", 30)], 40, 0);
    expect(plan.overAllocatedUsd).toBeCloseTo(20, 2);
    expect(plan.reserveDeltaUsd).toBeCloseTo(20, 2);
    expect(plan.moves.map((m) => m.deltaUsd)).toEqual([-10, -10]);
    expect(plan.moves[0].newCurrentCapitalUsd).toBe(20);
  });

  test("rellena deficit solo con caja existente y reporta lo no financiado", () => {
    const plan = planDexCapitalNormalization([slot("A", 20)], 60, 15);
    expect(plan.underAllocatedUsd).toBe(15);
    expect(plan.unfundedDeficitUsd).toBe(25);
    expect(plan.reserveDeltaUsd).toBe(-15);
    expect(plan.moves[0].newCurrentCapitalUsd).toBe(35);
  });

  test("no acuna capital cuando no hay caja disponible", () => {
    const plan = planDexCapitalNormalization([slot("A", 20)], 60, 0);
    expect(plan.moves).toHaveLength(0);
    expect(plan.reserveDeltaUsd).toBe(0);
    expect(plan.unfundedDeficitUsd).toBe(40);
  });

  test("dentro de tolerancia no hace nada", () => {
    const plan = planDexCapitalNormalization([slot("A", 60)], 60, 0);
    expect(plan.moves).toHaveLength(0);
    expect(plan.reserveDeltaUsd).toBe(0);
  });
});
