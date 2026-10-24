import { describe, expect, test } from "bun:test";
import {
  computeClosedTradeStats,
  computeDexAnalytics,
  computeEquityReconciliation,
  computeExitCounterfactuals,
  computeLayaAttribution,
  computeBuyHoldComparison,
  isClosedTrade,
  type TradeLike,
} from "./paper-validation.js";

function trade(over: Partial<TradeLike>): TradeLike {
  return {
    timestamp: "2026-10-05T00:00:00.000Z",
    venue: "BINANCE_SPOT",
    assetOrPool: "BTCUSDT",
    action: "TP_GRID_PINGPONG_L2",
    price: 100,
    amount: 1,
    pnlNet: 0,
    pnlPct: 0,
    feePaidUsd: 0,
    ...over,
  };
}

describe("paper-validation / cierres", () => {
  test("isClosedTrade exige PnL distinto de cero", () => {
    expect(isClosedTrade(trade({ pnlNet: 0 }))).toBe(false);
    expect(isClosedTrade(trade({ pnlNet: 0.1 }))).toBe(true);
    expect(isClosedTrade(trade({ pnlNet: 0.1, venue: "BASE_DEX" }))).toBe(false);
    expect(isClosedTrade(trade({ pnlNet: 0.1, action: "BUY_GRID_FILL_L2" }))).toBe(false);
  });

  test("reproduce la asimetria medida en la corrida viva (58W/10L)", () => {
    const trades: TradeLike[] = [];
    for (let i = 0; i < 58; i++) trades.push(trade({ pnlNet: 0.02466, pnlPct: 0.579 }));
    for (let i = 0; i < 10; i++) trades.push(trade({ pnlNet: -0.262, pnlPct: -3.202, action: "EMERGENCY_DELEVERAGE" }));

    const s = computeClosedTradeStats(trades, 191);
    expect(s.closed).toBe(68);
    expect(s.wins).toBe(58);
    expect(s.losses).toBe(10);
    expect(s.winRatePct).toBeCloseTo(85.29, 1);
    expect(s.profitFactor).toBeCloseTo(0.546, 2);
    expect(s.breakevenWinRatePct).toBeCloseTo(91.4, 0);
    // El deficit es positivo: hace falta mas win rate del que se logra.
    expect(s.deficitPp).toBeGreaterThan(5);
    expect(s.expectancyUsd).toBeLessThan(0);
    expect(s.payoffRatio).toBeGreaterThan(10);
    expect(s.statisticallySignificant).toBe(false);
    expect(s.remainingClosedTrades).toBe(123);
  });

  test("esperanza positiva se marca significativa con N grande", () => {
    const trades: TradeLike[] = [];
    for (let i = 0; i < 400; i++) trades.push(trade({ pnlNet: 0.05, pnlPct: 1 }));
    for (let i = 0; i < 100; i++) trades.push(trade({ pnlNet: -0.04, pnlPct: -1 }));
    const s = computeClosedTradeStats(trades, 191);
    expect(s.expectancyUsd).toBeGreaterThan(0);
    expect(s.tStat).toBeGreaterThan(2);
    expect(s.statisticallySignificant).toBe(true);
    expect(s.deficitPp).toBeLessThan(0);
  });
});

describe("paper-validation / contrafactual de salidas", () => {
  test("valueAdded positivo cuando el precio cae despues de salir", () => {
    const trades = [trade({ timestamp: "2026-10-05T00:00:00.000Z", price: 100, amount: 2, pnlNet: 0.5 })];
    const klines = {
      BTCUSDT: [
        { openTimeMs: Date.parse("2026-10-05T01:00:00.000Z"), close: 99 },
        { openTimeMs: Date.parse("2026-10-06T00:00:00.000Z"), close: 101 },
      ],
    };
    const [row] = computeExitCounterfactuals(trades, klines, [1, 24]);
    expect(row.action).toBe("TP_GRID_PINGPONG_L2");
    expect(row.valueAddedUsdByHorizon.h1).toBeCloseTo(2, 4); // (100-99)*2
    expect(row.valueAddedUsdByHorizon.h24).toBeCloseTo(-2, 4); // (100-101)*2
    expect(row.hitRateByHorizon.h1).toBe(100);
  });
});

describe("paper-validation / DEX y equity", () => {
  test("gas sobre fees y desviacion del APR modelado", () => {
    const { slots, totals } = computeDexAnalytics(
      {
        "WETH-CBBTC": {
          accumulatedFeesUsd: 0.615,
          impermanentLossUsd: 0.02,
          gasSpentUsd: 0.9,
          currentCapitalUsd: 27.76,
          initialCapitalUsd: 27.18,
          feeAprPct: 120.85,
        },
      },
      21
    );
    expect(slots[0].netPnlUsd).toBeCloseTo(-0.305, 3);
    expect(slots[0].gasOverFees).toBeGreaterThan(1);
    expect(slots[0].realizedOverModeledPct).toBeLessThan(50);
    expect(totals.gasOverFees).toBeGreaterThan(1);
  });

  test("equity reconcilia contra la formula legacy y reporta la deriva", () => {
    const state = {
      totalCapitalUsd: 200,
      cexPositions: { BTC: { realNavUsd: 53.93 }, SOL: { realNavUsd: 11.28 } },
      dexPositions: { P1: { currentCapitalUsd: 55.48 } },
      equity: { legacyFormulaUsd: 201.54 },
    };
    const r = computeEquityReconciliation(state);
    expect(r.reconciledUsd).toBeCloseTo(120.69, 2);
    expect(r.driftUsd).toBeCloseTo(-80.85, 1);
    expect(r.driftPct).toBeLessThan(-40);
  });

  test("atribucion Laya vs OFI infiere de umbrales si no hay triggerSource", () => {
    const records = [
      { metrics: { ofiScore: -0.9 }, layaJudgment: { toxicFlow: 0.2 } },
      { metrics: { ofiScore: -0.1 }, layaJudgment: { toxicFlow: 0.8 } },
      { metrics: { ofiScore: -0.9 }, layaJudgment: { toxicFlow: 0.8 } },
      { metrics: { ofiScore: 0.5 }, layaJudgment: { toxicFlow: 0.1 } },
      { triggerSource: "LAYA", metrics: { ofiScore: 0.9 }, layaJudgment: { toxicFlow: 0.9 } },
    ];
    const a = computeLayaAttribution(records);
    expect(a.total).toBe(5);
    expect(a.ofi).toBe(1);
    expect(a.laya).toBe(2); // uno inferido + uno explicito (el explicito manda)
    expect(a.both).toBe(1);
    expect(a.other).toBe(1);
  });
});

describe("paper-validation / benchmark", () => {
  test("compara el motor contra buy and hold del mismo capital", () => {
    const trades = [
      trade({ assetOrPool: "AEROUSDT", pnlNet: 0.04, feePaidUsd: 0.0362, action: "TP_GRID_PINGPONG_L4" }),
    ];
    const rows = computeBuyHoldComparison(
      trades,
      { AERO: { start: 0.7911, end: 0.9233 } },
      { AERO: 9.01 }
    );
    expect(rows[0].buyHoldPct).toBeCloseTo(16.71, 1);
    expect(rows[0].strategyPct).toBeCloseTo(0.04, 1);
    expect(rows[0].deltaPp).toBeLessThan(-16);
  });
});
