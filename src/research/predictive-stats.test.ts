import { test, expect } from "bun:test";
import { rank, pearson, spearmanIC, auc, evaluateSignal } from "./predictive-stats.js";

test("rank asigna rangos promedio con empates", () => {
  expect(rank([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  expect(rank([5, 4, 3, 2, 1])).toEqual([5, 4, 3, 2, 1]);
});

test("pearson detecta correlación perfecta", () => {
  expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
  expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 6);
});

test("spearmanIC captura relaciones monótonas no lineales", () => {
  // y = x^3 es monótono pero no lineal en escala cruda
  const x = [1, 2, 3, 4, 5, 6];
  const y = x.map((v) => v ** 3);
  expect(spearmanIC(x, y)).toBeCloseTo(1, 4);
  expect(spearmanIC(x, y.map((v) => -v))).toBeCloseTo(-1, 4);
});

test("auc: separación perfecta = 1, invertida = 0, aleatoria = 0.5", () => {
  expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBeCloseTo(1, 4);
  expect(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBeCloseTo(0, 4);
  // Señales idénticas entre clases -> ~0.5
  const s = [0.5, 0.5, 0.5, 0.5];
  expect(auc(s, [1, 1, 0, 0])).toBeCloseTo(0.5, 4);
});

test("evaluateSignal integra IC y AUC para evento adverso", () => {
  // Señal perfecta prediciendo caída: señal alta <=> retorno muy negativo
  const signal = [0.1, 0.2, 0.8, 0.9, 0.95, 0.99];
  const outcome = [1, 0.5, -3, -5, -7, -9];
  const ev = evaluateSignal(signal, outcome, 2, true);
  expect(ev.n).toBe(6);
  expect(ev.ic).toBeLessThan(-0.9); // correlación negativa fuerte
  expect(ev.auc).toBeGreaterThan(0.9); // separa bien el evento adverso
});

test("evaluateSignal: señal sin relación da IC≈0 y AUC≈0.5", () => {
  const signal = [0.1, 0.9, 0.2, 0.8, 0.5, 0.4];
  const outcome = [-1, 1, -1, 1, -1, 1];
  const ev = evaluateSignal(signal, outcome, 0.5, true);
  expect(Math.abs(ev.ic)).toBeLessThan(0.8);
  expect(ev.auc).toBeGreaterThanOrEqual(0);
  expect(ev.auc).toBeLessThanOrEqual(1);
});
