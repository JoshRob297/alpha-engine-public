import { test, expect } from "bun:test";
import {
  reconstructCexTradePnl,
  reconcileTradesWithLedger,
  reconcileDexSlot,
  estimateImpactUsd,
  scalingCurve,
  type LedgerTradeLike,
} from "./pnl-reconstruction.js";

// ---------------------------------------------------------------- reconstructCexTradePnl

test("trade largo ganador sin costos: bruto, neto y porcentaje", () => {
  const r = reconstructCexTradePnl({ entryPrice: 100, exitPrice: 110, qty: 2 });
  expect(r.grossUsd).toBeCloseTo(20, 6);
  expect(r.netUsd).toBeCloseTo(20, 6);
  expect(r.netPct).toBeCloseTo(10, 6); // 20 / 200
});

test("trade largo perdedor: bruto y neto negativos", () => {
  const r = reconstructCexTradePnl({ entryPrice: 100, exitPrice: 92, qty: 1.5 });
  expect(r.grossUsd).toBeCloseTo(-12, 6);
  expect(r.netUsd).toBeCloseTo(-12, 6);
  expect(r.netPct).toBeCloseTo(-8, 6); // -12 / 150
});

test("con fees: el neto resta exactamente las comisiones", () => {
  const r = reconstructCexTradePnl({ entryPrice: 100, exitPrice: 110, qty: 2, feesUsd: 3 });
  expect(r.grossUsd).toBeCloseTo(20, 6);
  expect(r.netUsd).toBeCloseTo(17, 6);
  expect(r.netPct).toBeCloseTo(8.5, 6); // 17 / 200
});

test("con slippage: el neto resta fees + slippage", () => {
  const r = reconstructCexTradePnl({
    entryPrice: 100,
    exitPrice: 110,
    qty: 2,
    feesUsd: 3,
    slippageUsd: 1.5,
  });
  expect(r.netUsd).toBeCloseTo(15.5, 6);
  expect(r.netPct).toBeCloseTo(7.75, 6); // 15.5 / 200
});

test("trade corto: bruto = (entry - exit) * qty", () => {
  const r = reconstructCexTradePnl({ entryPrice: 100, exitPrice: 90, qty: 1, side: "SHORT" });
  expect(r.grossUsd).toBeCloseTo(10, 6);
  expect(r.netPct).toBeCloseTo(10, 6);
});

test("breakeven de salida en LONG incluye los costos", () => {
  const r = reconstructCexTradePnl({
    entryPrice: 100,
    exitPrice: 101,
    qty: 2,
    feesUsd: 4,
    slippageUsd: 2,
  });
  // (fees+slippage)/qty = 6/2 = 3 -> 100 + 3
  expect(r.breakevenExitPrice).toBeCloseTo(103, 6);
  const atBreakeven = reconstructCexTradePnl({ entryPrice: 100, exitPrice: 103, qty: 2, feesUsd: 4, slippageUsd: 2 });
  expect(atBreakeven.netUsd).toBeCloseTo(0, 6);
});

test("breakeven de salida en SHORT baja con los costos", () => {
  const r = reconstructCexTradePnl({
    entryPrice: 100,
    exitPrice: 99,
    qty: 4,
    feesUsd: 2,
    slippageUsd: 2,
    side: "SHORT",
  });
  // (fees+slippage)/qty = 4/4 = 1 -> 100 - 1
  expect(r.breakevenExitPrice).toBeCloseTo(99, 6);
  const atBreakeven = reconstructCexTradePnl({ entryPrice: 100, exitPrice: 99, qty: 4, feesUsd: 2, slippageUsd: 2, side: "SHORT" });
  expect(atBreakeven.netUsd).toBeCloseTo(0, 6);
});

// ------------------------------------------------------- reconcileTradesWithLedger

test("reconciliacion coherente: sin mismatches y cobertura 100%", () => {
  const trades: LedgerTradeLike[] = [
    // pnlPct = 10 implica entry = 100, bruto = (110-100)*1 = 10 = pnlNet
    { venue: "BINANCE_SPOT", assetOrPool: "BTCUSDT", action: "TAKE_PROFIT_FULL", price: 110, amount: 1, pnlNet: 10, pnlPct: 10 },
    { venue: "BINANCE_SPOT", assetOrPool: "SOLUSDT", action: "STOP_LOSS", price: 90, amount: 2, pnlNet: -20, pnlPct: -10 },
    { venue: "BINANCE_SPOT", assetOrPool: "BTCUSDT", action: "BUY_GRID_FILL_L1", price: 100, amount: 0.5, pnlNet: 0, pnlPct: 0 },
  ];
  const r = reconcileTradesWithLedger(trades);
  expect(r.checked).toBe(3);
  expect(r.mismatches.length).toBe(0);
  expect(r.coveragePct).toBeCloseTo(100, 6);
  expect(r.ledgerTotalUsd).toBeCloseTo(-10, 6);
  expect(r.reconstructedTotalUsd).toBeCloseTo(-10, 6);
});

test("mismatch detectado cuando pnlNet no cuadra con los componentes", () => {
  const trades: LedgerTradeLike[] = [
    { venue: "BINANCE_SPOT", timestamp: "2026-10-01T00:00:00Z", assetOrPool: "BTCUSDT", action: "TAKE_PROFIT_FULL", price: 110, amount: 1, pnlNet: 25, pnlPct: 10 },
  ];
  const r = reconcileTradesWithLedger(trades);
  expect(r.checked).toBe(1);
  expect(r.mismatches.length).toBe(1);
  const m = r.mismatches[0];
  expect(m.index).toBe(0);
  expect(m.assetOrPool).toBe("BTCUSDT");
  expect(m.ledgerUsd).toBeCloseTo(25, 6);
  expect(m.reconstructedUsd).toBeCloseTo(10, 6);
  expect(m.diffUsd).toBeCloseTo(15, 6);
});

test("cobertura parcial: trades DEX y amount<=0 quedan fuera del check", () => {
  const trades: LedgerTradeLike[] = [
    { venue: "BINANCE_SPOT", assetOrPool: "BTCUSDT", action: "TAKE_PROFIT_FULL", price: 110, amount: 1, pnlNet: 10, pnlPct: 10 },
    { venue: "BASE_DEX", assetOrPool: "WETH-CBBTC", action: "DEX_FEE_COLLECT", price: 1, amount: 0, pnlNet: 0.5, pnlPct: 1 },
    { venue: "BINANCE_SPOT", assetOrPool: "ETHUSDT", action: "TP_PARTIAL", price: 0, amount: 1, pnlNet: 3, pnlPct: 3 },
  ];
  const r = reconcileTradesWithLedger(trades);
  expect(r.checked).toBe(1);
  expect(r.coveragePct).toBeCloseTo(100 / 3, 4);
  expect(r.mismatches.length).toBe(0);
});

// ------------------------------------------------------------- reconcileDexSlot

test("reconcileDexSlot coherente dentro de la tolerancia", () => {
  const r = reconcileDexSlot({
    pool: "USDC-CBBTC",
    initialCapitalUsd: 100,
    accumulatedFeesUsd: 5,
    impermanentLossUsd: 2,
    gasSpentUsd: 0.5,
    currentCapitalUsd: 102.5,
  });
  expect(r.evaluable).toBe(true);
  expect(r.coherent).toBe(true);
  expect(r.expectedCapitalUsd).toBeCloseTo(102.5, 6);
  expect(r.deltaUsd).toBeCloseTo(0, 6);
});

test("reconcileDexSlot detecta desvio mayor a la tolerancia", () => {
  const r = reconcileDexSlot({
    pool: "WETH-CBBTC",
    initialCapitalUsd: 100,
    accumulatedFeesUsd: 5,
    impermanentLossUsd: 2,
    gasSpentUsd: 0.5,
    currentCapitalUsd: 150,
  });
  expect(r.evaluable).toBe(true);
  expect(r.coherent).toBe(false);
  expect(r.deltaUsd).toBeCloseTo(47.5, 6);
});

test("reconcileDexSlot no evaluable si faltan campos (estado pre-correccion)", () => {
  const r = reconcileDexSlot({ pool: "XDP-USDC", currentCapitalUsd: 5.6, accumulatedFeesUsd: 0 });
  expect(r.evaluable).toBe(false);
  expect(r.coherent).toBe(false);
  expect(r.reason).toContain("initialCapitalUsd");
  expect(r.reason).toContain("impermanentLossUsd");
});

// ----------------------------------------------------------------- estimateImpactUsd

test("estimateImpactUsd sigue la ley cuadratica en el nocional", () => {
  const base = estimateImpactUsd({ notionalUsd: 1000, depthUsd: 1_000_000, impactK: 1 });
  const quad = estimateImpactUsd({ notionalUsd: 4000, depthUsd: 1_000_000, impactK: 1 });
  expect(base).toBeCloseTo(1, 6); // 1000^2 / 1e6
  expect(quad).toBeCloseTo(16, 6); // 4x notional -> 16x impacto
  expect(quad / base).toBeCloseTo(16, 6);
});

test("estimateImpactUsd escala inversamente con la profundidad", () => {
  const shallow = estimateImpactUsd({ notionalUsd: 1000, depthUsd: 100_000 });
  const deep = estimateImpactUsd({ notionalUsd: 1000, depthUsd: 1_000_000 });
  expect(shallow).toBeCloseTo(10, 6);
  expect(deep).toBeCloseTo(1, 6);
  expect(estimateImpactUsd({ notionalUsd: 0, depthUsd: 0 })).toBe(0);
  expect(estimateImpactUsd({ notionalUsd: 100, depthUsd: 0 })).toBe(Number.POSITIVE_INFINITY);
});

// -------------------------------------------------------------------- scalingCurve

test("scalingCurve: expectancy porcentual estrictamente decreciente en el capital", () => {
  // Edge bruto observado del 1% sobre nocional, sin costos registrados.
  const trades: LedgerTradeLike[] = [
    { venue: "BINANCE_SPOT", price: 100, amount: 10, pnlNet: 10, pnlPct: 1, liquidity: "TAKER" },
    { venue: "BINANCE_SPOT", price: 100, amount: 10, pnlNet: 10, pnlPct: 1, liquidity: "TAKER" },
  ];
  const depth = { BTCUSDT: 1_000_000 };
  const caps = [100, 1_000, 10_000, 100_000];
  const points = caps.map((c) => scalingCurve(trades, c, depth, { impactK: 1 }));
  for (let i = 1; i < points.length; i++) {
    expect(points[i].expectancyPct).toBeLessThan(points[i - 1].expectancyPct);
  }
  // El bruto por nocional es 1% = 0.01.
  expect(points[0].grossEdgePerNotional).toBeCloseTo(0.01, 6);
});

test("scalingCurve: breakeven finito y positivo con profundidad real", () => {
  const trades: LedgerTradeLike[] = [
    { venue: "BINANCE_SPOT", price: 100, amount: 10, pnlNet: 10, pnlPct: 1, liquidity: "TAKER" },
  ];
  const point = scalingCurve(trades, 1000, { BTCUSDT: 1_000_000 });
  expect(Number.isFinite(point.breakevenCapitalUsd)).toBe(true);
  expect(point.breakevenCapitalUsd).toBeGreaterThan(0);
  // En el breakeven la expectancy debe ser ~0.
  const atBe = scalingCurve(trades, point.breakevenCapitalUsd, { BTCUSDT: 1_000_000 });
  expect(atBe.expectancyUsd).toBeCloseTo(0, 2);
});

test("scalingCurve: sin ventaja (edge negativo) el breakeven es 0", () => {
  const trades: LedgerTradeLike[] = [
    { venue: "BINANCE_SPOT", price: 100, amount: 10, pnlNet: -5, pnlPct: -0.5, liquidity: "TAKER" },
  ];
  const point = scalingCurve(trades, 1000, { BTCUSDT: 1_000_000 });
  expect(point.breakevenCapitalUsd).toBe(0);
  expect(point.expectancyUsd).toBeLessThan(0);
});
