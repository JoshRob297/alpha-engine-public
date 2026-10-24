import { test, expect } from "bun:test";
import { TradeLedger, classifyTradeComponent } from "../telemetry/trade-ledger.js";
import { RiskGuard } from "./risk-guard.js";

test("classifyTradeComponent mapea acciones a componentes de atribución", () => {
  expect(classifyTradeComponent("TP_GRID_PINGPONG_L2")).toBe("PINGPONG");
  expect(classifyTradeComponent("TP_FRONTRUN_LAYA")).toBe("FRONT_RUN");
  expect(classifyTradeComponent("EMERGENCY_DELEVERAGE")).toBe("EMERGENCY");
  expect(classifyTradeComponent("HARD_STOP_LOSS")).toBe("HARD_STOP");
  expect(classifyTradeComponent("TP_PARTIAL_DCA")).toBe("DCA_OUT");
  expect(classifyTradeComponent("TAKE_PROFIT_FULL")).toBe("TAKE_PROFIT");
  expect(classifyTradeComponent("BUY_GRID_FILL_L1")).toBe("GRID_FILL");
  expect(classifyTradeComponent("DEX_FEE_COLLECT")).toBe("DEX_FEE");
});

test("TradeLedger.getAttribution agrupa PnL, fees y slippage por componente", () => {
  const ledger = new TradeLedger(50);
  ledger.recordTrade({ timestamp: new Date().toISOString(), venue: "BINANCE_SPOT", assetOrPool: "BTCUSDT", action: "TP_GRID_PINGPONG_L2", price: 100, amount: 1, pnlNet: 2.0, pnlPct: 1, feeSavedOrPaid: 0, feePaidUsd: 0.1, liquidity: "MAKER" });
  ledger.recordTrade({ timestamp: new Date().toISOString(), venue: "BINANCE_SPOT", assetOrPool: "BTCUSDT", action: "TP_GRID_PINGPONG_L3", price: 100, amount: 1, pnlNet: -0.5, pnlPct: -0.5, feeSavedOrPaid: 0, feePaidUsd: 0.1, liquidity: "MAKER" });
  ledger.recordTrade({ timestamp: new Date().toISOString(), venue: "BINANCE_SPOT", assetOrPool: "SOLUSDT", action: "EMERGENCY_DELEVERAGE", price: 100, amount: 1, pnlNet: -1.0, pnlPct: -1, feeSavedOrPaid: 0, feePaidUsd: 0.1, liquidity: "TAKER", slippageUsd: 0.05 });

  const attribution = ledger.getAttribution();
  const pingpong = attribution.find((a) => a.component === "PINGPONG")!;
  const emergency = attribution.find((a) => a.component === "EMERGENCY")!;

  expect(pingpong.trades).toBe(2);
  expect(pingpong.grossPnlUsd).toBeCloseTo(1.5, 4);
  expect(pingpong.feesUsd).toBeCloseTo(0.2, 4);
  expect(pingpong.netPnlUsd).toBeCloseTo(1.3, 4);
  expect(pingpong.winRatePct).toBeCloseTo(50, 1);

  expect(emergency.trades).toBe(1);
  expect(emergency.slippageUsd).toBeCloseTo(0.05, 4);
  // El componente más rentable va primero.
  expect(attribution[0].component).toBe("PINGPONG");
});

test("calculateMetrics reporta costos reales y PnL neto tras costos", () => {
  const ledger = new TradeLedger(50);
  ledger.recordTrade({ timestamp: new Date().toISOString(), venue: "BINANCE_SPOT", assetOrPool: "BTCUSDT", action: "TAKE_PROFIT_FULL", price: 100, amount: 1, pnlNet: 3.0, pnlPct: 3, feeSavedOrPaid: 0, feePaidUsd: 0.2, liquidity: "MAKER" });
  ledger.recordTrade({ timestamp: new Date().toISOString(), venue: "BINANCE_SPOT", assetOrPool: "BTCUSDT", action: "EMERGENCY_DELEVERAGE", price: 100, amount: 1, pnlNet: -0.5, pnlPct: -0.5, feeSavedOrPaid: 0, feePaidUsd: 0.1, slippageUsd: 0.05 });

  const m = ledger.calculateMetrics(200, 200);
  expect(m.totalFeePaidUsd).toBeCloseTo(0.3, 4);
  expect(m.totalSlippageUsd).toBeCloseTo(0.05, 4);
  expect(m.netPnlAfterCostsUsd).toBeCloseTo(2.5 - 0.35, 4);
});

test("RiskGuard: kill-switch automático por pérdida diaria", () => {
  const guard = new RiskGuard({ maxDailyLossUsd: 2.0, maxAggregateExposurePct: 0.7, maxSingleAssetExposurePct: 0.5 });
  const now = new Date().toISOString();
  const status = guard.evaluate({
    capitalUsd: 200,
    exposures: [],
    closedTrades: [{ timestamp: now, venue: "BINANCE_SPOT", pnlNet: -2.5 }],
  });
  expect(status.killed).toBe(true);
  expect(status.killSource).toBe("AUTO");
  expect(status.breaches.some((b) => b.startsWith("DAILY_LOSS_LIMIT"))).toBe(true);
});

test("RiskGuard: marca breaches de exposición agregada y por activo", () => {
  const guard = new RiskGuard({ maxDailyLossUsd: 100, maxAggregateExposurePct: 0.5, maxSingleAssetExposurePct: 0.4 });
  const status = guard.evaluate({
    capitalUsd: 100,
    exposures: [{ ticker: "BTC", inventoryUsd: 60 }],
    closedTrades: [],
  });
  expect(status.killed).toBe(false);
  expect(status.breaches.some((b) => b.startsWith("BTC_EXPOSURE"))).toBe(true);
  expect(status.breaches.some((b) => b.startsWith("AGGREGATE_EXPOSURE"))).toBe(true);
});

test("RiskGuard: kill-switch manual y limpieza", () => {
  const guard = new RiskGuard();
  expect(guard.isKilled()).toBe(false);
  guard.manualKillSwitch("test");
  expect(guard.isKilled()).toBe(true);
  guard.clearKill();
  expect(guard.isKilled()).toBe(false);
});
