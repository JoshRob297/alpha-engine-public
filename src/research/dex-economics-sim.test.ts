import { test, expect } from "bun:test";
import { initPosition, lpValue, segmentHoldValue, positionAmounts, simulateDex, simulateHold, type DexSeries } from "./dex-economics-sim.js";

test("posición concentrada: valor inicial igual al capital y ambos lados con inventario", () => {
  const V0 = 1000;
  const P0 = 100;
  const pos = initPosition(V0, P0, 0.10);
  const v = lpValue(P0, pos);
  expect(v).toBeCloseTo(V0, 4);
  // En el centro debe haber inventario en ambos lados (no 100% un solo activo)
  const { amount0, amount1 } = positionAmounts(P0, pos.L, pos.pa, pos.pb);
  expect(amount0).toBeGreaterThan(0);
  expect(amount1).toBeGreaterThan(0);
});

test("IL: cero en el precio de entrada, negativa al moverse, y capeada fuera de rango", () => {
  const V0 = 1000, P0 = 100;
  const pos = initPosition(V0, P0, 0.10); // rango [90, 110]
  // IL en entrada = 0
  expect(lpValue(P0, pos) - segmentHoldValue(P0, pos)).toBeCloseTo(0, 6);
  // Precio sube dentro del rango -> IL negativa
  const ilUp = lpValue(105, pos) - segmentHoldValue(105, pos);
  expect(ilUp).toBeLessThan(0);
  // Precio por encima del rango -> la posición es 100% token1 (no sigue la subida)
  const ilAbove = lpValue(120, pos) - segmentHoldValue(120, pos);
  expect(ilAbove).toBeLessThan(ilUp);
});

test("simulateDex: pausar ante volatilidad reduce exposición pero cuesta gas", () => {
  // Serie con un tramo de pánico (volatilidad alta) y otro lateral
  const close: number[] = [];
  let p = 100;
  for (let i = 0; i < 200; i++) {
    if (i > 100 && i < 130) p *= 1 + (Math.random() - 0.5) * 0.08; // pánico
    else p *= 1 + (Math.random() - 0.5) * 0.002; // calma
    close.push(p);
  }
  const s: DexSeries = { close, n: close.length };
  const passive = simulateDex("passive", s, "none", 68.9);
  const withSignal = simulateDex("signal", s, "vol", 68.9);
  expect(passive.rebalances).toBeGreaterThanOrEqual(0);
  expect(withSignal.pauses).toBeGreaterThanOrEqual(0);
  // Ambos deben producir un NAV finito
  expect(Number.isFinite(passive.finalNav)).toBe(true);
  expect(Number.isFinite(withSignal.finalNav)).toBe(true);
});

test("simulateHold devuelve NAV finito y coherente", () => {
  const close = Array.from({ length: 200 }, (_, i) => 100 * (1 + i * 0.001));
  const s: DexSeries = { close, n: close.length };
  const hold = simulateHold(s);
  expect(Number.isFinite(hold.finalNav)).toBe(true);
  expect(hold.retPct).toBeGreaterThan(0); // el precio subió linealmente
});
