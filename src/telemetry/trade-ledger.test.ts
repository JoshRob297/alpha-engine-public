import { test, expect } from "bun:test";
import { TradeLedger } from "./trade-ledger.js";

test("TradeLedger registra trades y calcula winrate y profit factor", () => {
  const ledger = new TradeLedger(10);

  ledger.recordTrade({
    timestamp: new Date().toISOString(),
    venue: "BINANCE_SPOT",
    assetOrPool: "BTCUSDT",
    action: "TAKE_PROFIT",
    price: 83500,
    amount: 0.002,
    pnlNet: 120.5,
    pnlPct: 3.8,
    feeSavedOrPaid: 4.2,
  });

  ledger.recordTrade({
    timestamp: new Date().toISOString(),
    venue: "BINANCE_SPOT",
    assetOrPool: "SOLUSDT",
    action: "TAKE_PROFIT",
    price: 118.5,
    amount: 1.5,
    pnlNet: 85.0,
    pnlPct: 2.9,
    feeSavedOrPaid: 2.1,
  });

  ledger.recordTrade({
    timestamp: new Date().toISOString(),
    venue: "BINANCE_SPOT",
    assetOrPool: "BTCUSDT",
    action: "STOP_LOSS",
    price: 82000,
    amount: 0.002,
    pnlNet: -45.0,
    pnlPct: -1.5,
    feeSavedOrPaid: 3.8,
  });

  const metrics = ledger.calculateMetrics(60000, 3000);
  expect(metrics.totalTrades).toBe(3);
  expect(metrics.winningTrades).toBe(2);
  expect(metrics.losingTrades).toBe(1);
  expect(metrics.winRatePct).toBeCloseTo(66.7, 1);
  expect(metrics.profitFactor).toBeGreaterThan(4.0);
  expect(metrics.totalPnlRealizedUsd).toBe(160.5);
});
