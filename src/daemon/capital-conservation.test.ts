import { describe, expect, test } from "bun:test";
import { auditCapitalConservation } from "./capital-conservation.js";

describe("auditoria de conservacion de capital", () => {
  test("libros consistentes: sin reparacion", () => {
    const r = auditCapitalConservation({
      capitalUsd: 200,
      realizedNetUsd: -2,
      deployedValueUsd: 100,
      capturedReserveUsd: 98,
    });
    expect(r.totalCashUsd).toBeCloseTo(98, 4);
    expect(r.derivedUntradedReserveUsd).toBeCloseTo(0, 4);
    expect(r.overshootUsd).toBe(0);
    expect(r.needsRepair).toBe(false);
    expect(r.severity).toBe("OK");
  });

  test("reserva inflada (mint): se detecta y se propone la reparacion al total real", () => {
    // Caso real del 2026-10-19: etiqueta 236.43 contra caja existente 96.77.
    const r = auditCapitalConservation({
      capitalUsd: 200,
      realizedNetUsd: -1.77,
      deployedValueUsd: 101.46,
      capturedReserveUsd: 236.43,
    });
    expect(r.totalCashUsd).toBeCloseTo(96.77, 2);
    expect(r.overshootUsd).toBeCloseTo(139.66, 2);
    expect(r.needsRepair).toBe(true);
    expect(r.repairToUsd).toBeCloseTo(96.77, 2);
    expect(r.severity).toBe("CRITICAL");
    expect(r.overshootPct).toBeGreaterThan(50);
  });

  test("reserva conservadora: se reporta shortfall y no se repara", () => {
    const r = auditCapitalConservation({
      capitalUsd: 200,
      realizedNetUsd: 0,
      deployedValueUsd: 150,
      capturedReserveUsd: 10,
    });
    expect(r.totalCashUsd).toBeCloseTo(50, 4);
    expect(r.shortfallUsd).toBeCloseTo(40, 4);
    expect(r.overshootUsd).toBe(0);
    expect(r.needsRepair).toBe(false);
    expect(r.repairToUsd).toBeCloseTo(10, 4);
  });

  test("desviacion pequena por redondeo no dispara reparacion", () => {
    const r = auditCapitalConservation({
      capitalUsd: 200,
      realizedNetUsd: -1,
      deployedValueUsd: 100.3,
      capturedReserveUsd: 98.9,
    });
    expect(r.overshootUsd).toBeCloseTo(0.2, 4);
    expect(r.needsRepair).toBe(false);
  });

  test("overshoot moderado es WARN; severo es CRITICAL", () => {
    const warn = auditCapitalConservation({
      capitalUsd: 200,
      realizedNetUsd: 0,
      deployedValueUsd: 100,
      capturedReserveUsd: 102,
    });
    expect(warn.severity).toBe("WARN");
    const crit = auditCapitalConservation({
      capitalUsd: 200,
      realizedNetUsd: 0,
      deployedValueUsd: 100,
      capturedReserveUsd: 110,
    });
    expect(crit.severity).toBe("CRITICAL");
  });
});

describe("holgura no etiquetada (punto ciego del agregado)", () => {
  test("holgura chica no es sospechosa", async () => {
    const { auditReserveSlack } = await import("./capital-conservation.js");
    const r = auditReserveSlack(1, 200, 80);
    expect(r.suspicious).toBe(false);
    expect(r.excessUsd).toBe(0);
  });

  test("holgura grande y persistente es sospechosa", async () => {
    const { auditReserveSlack } = await import("./capital-conservation.js");
    // 25 USD de holgura contra una reserva objetivo de 80: acuñar < 25 seria invisible.
    const r = auditReserveSlack(25, 200, 80);
    expect(r.suspicious).toBe(true);
    expect(r.thresholdUsd).toBe(12);
    expect(r.excessUsd).toBe(13);
  });

  test("sin reserva objetivo se usa el minimo absoluto", async () => {
    const { auditReserveSlack } = await import("./capital-conservation.js");
    const r = auditReserveSlack(2.5, 200, 0);
    expect(r.thresholdUsd).toBe(2);
    expect(r.suspicious).toBe(true);
  });
});
