import { test, expect } from "bun:test";
import { computeLiveWinRateMetrics } from "./live-metrics.js";

test("computeLiveWinRateMetrics retorna estructura valida y porcentajes coherentes", () => {
  const metrics = computeLiveWinRateMetrics(500);

  expect(metrics).toBeDefined();
  expect(metrics.totalDecisions).toBeGreaterThanOrEqual(0);
  expect(metrics.solWinRatePct).toBeGreaterThan(0);
  expect(metrics.solWinRatePct).toBeLessThanOrEqual(100);
  expect(metrics.btcWinRatePct).toBeGreaterThan(0);
  expect(metrics.btcWinRatePct).toBeLessThanOrEqual(100);
  expect(metrics.overallWinRatePct).toBeGreaterThan(0);
  expect(metrics.predominantRegime).toBeDefined();
});
