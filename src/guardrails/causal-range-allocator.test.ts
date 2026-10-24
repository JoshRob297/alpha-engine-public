import { test, expect } from "bun:test";
import { calculateCausalConcentratedRange } from "./causal-range-allocator.js";

test("calculateCausalConcentratedRange genera rango amplio simetrico (+-12%) en DEFENSIVE_STRESS", () => {
  const currentPrice = 1.0;
  const range = calculateCausalConcentratedRange(currentPrice, "DEFENSIVE_STRESS", 1.0);

  expect(range.lowerPrice).toBe(0.88);
  expect(range.upperPrice).toBe(1.12);
  expect(range.widthPct).toBe(24.0);
  expect(range.description).toContain("DEFENSIVE_WIDE_RANGE");
});

test("calculateCausalConcentratedRange genera rango asimetrico alcista en AGGRESSIVE_ACCUMULATION", () => {
  const currentPrice = 100.0;
  const range = calculateCausalConcentratedRange(currentPrice, "AGGRESSIVE_ACCUMULATION", 1.0);

  // -4% a la baja (96.0), +8.5% al alza (108.5)
  expect(range.lowerPrice).toBe(96.0);
  expect(range.upperPrice).toBe(108.5);
  expect(range.asymmetryRatio).toBeGreaterThan(1.5);
  expect(range.description).toContain("AGGRESSIVE_ASYMMETRIC_RANGE");
});

test("calculateCausalConcentratedRange genera rango optimo para fees (+-6.5%) en BALANCED_RANGE", () => {
  const currentPrice = 0.032;
  const range = calculateCausalConcentratedRange(currentPrice, "BALANCED_RANGE", 1.0);

  expect(range.lowerPrice).toBeLessThan(currentPrice);
  expect(range.upperPrice).toBeGreaterThan(currentPrice);
  expect(range.widthPct).toBe(13.0); // 6.5% * 2
  expect(range.description).toContain("BALANCED_FEE_MAXIMIZER");
});
