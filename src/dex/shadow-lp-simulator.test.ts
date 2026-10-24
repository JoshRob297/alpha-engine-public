import { describe, expect, test } from "bun:test";
import { calculateConcentratedIlFraction, calculateFullRangeIlFraction } from "./shadow-lp-simulator.js";

describe("IL concentrado vs rango completo", () => {
  test("converge a la formula de rango completo cuando el rango es infinito", () => {
    const entry = 100;
    const current = 110;
    const full = calculateFullRangeIlFraction(entry, current);
    const concentrated = calculateConcentratedIlFraction(entry, current, entry * 1e-8, entry * 1e8);
    expect(concentrated).toBeCloseTo(full, 5);
  });

  test("con rango estrecho el IL es mayor que el de rango completo (amplificacion)", () => {
    const entry = 100;
    const current = 105;
    const full = calculateFullRangeIlFraction(entry, current);
    const conc = calculateConcentratedIlFraction(entry, current, 95, 106);
    expect(conc).toBeGreaterThan(full);
    // En rangos de pocos puntos la amplificacion es de un orden de magnitud o mas.
    expect(conc / full).toBeGreaterThan(5);
  });

  test("sin movimiento de precio el IL concentrado es cero", () => {
    expect(calculateConcentratedIlFraction(100, 100, 95, 106)).toBeCloseTo(0, 10);
  });

  test("precio por debajo del rango: posicion single-sided y no sigue cayendo como el hold", () => {
    // Al salir del rango por abajo la LP queda 100% en token base: su valor cae con el precio.
    const conc = calculateConcentratedIlFraction(100, 90, 95, 106);
    expect(conc).toBeGreaterThan(0);
    expect(conc).toBeLessThan(1);
  });

  test("precio por encima del rango: la LP capa el upside (IL crece frente al hold)", () => {
    const inRange = calculateConcentratedIlFraction(100, 105, 95, 106);
    const above = calculateConcentratedIlFraction(100, 130, 95, 106);
    expect(above).toBeGreaterThan(inRange);
  });

  test("rangos mas estrechos amplifican mas para el mismo movimiento", () => {
    const narrow = calculateConcentratedIlFraction(100, 101, 99, 102);
    const wide = calculateConcentratedIlFraction(100, 101, 50, 200);
    expect(narrow).toBeGreaterThan(wide);
  });
});
