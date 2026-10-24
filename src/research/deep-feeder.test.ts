import { test, expect } from "bun:test";
import { fetchFuturesFundingRates, fetchUnlockProjections, getDeepMarketContext } from "./deep-data-feeder.js";

test.skipIf(process.env.OFFLINE === "1")("fetchFuturesFundingRates retorna tasas para BTC, ETH y SOL", async () => {
  const rates = await fetchFuturesFundingRates();
  expect(rates.length).toBeGreaterThanOrEqual(3);
  const symbols = rates.map((r) => r.symbol);
  expect(symbols).toContain("BTCUSDT");
  expect(symbols).toContain("ETHUSDT");
  expect(symbols).toContain("SOLUSDT");
  expect(typeof rates[0].fundingRatePct).toBe("number");
});

test.skipIf(process.env.OFFLINE === "1")("fetchUnlockProjections retorna metricas de dilucion de float", async () => {
  const unlocks = await fetchUnlockProjections();
  expect(unlocks.length).toBeGreaterThanOrEqual(3);
  expect(unlocks.find((u) => u.symbol === "BTC")?.floatDilutionPct).toBeLessThan(0.1);
});

test.skipIf(process.env.OFFLINE === "1")("getDeepMarketContext clasifica el regimen de apalancamiento", async () => {
  const ctx = await getDeepMarketContext();
  expect(["OVERLEVERAGED_LONG", "OVERLEVERAGED_SHORT", "NEUTRAL"]).toContain(ctx.marketLeverageRegime);
  expect(ctx.fundingRates.length).toBeGreaterThan(0);
});
