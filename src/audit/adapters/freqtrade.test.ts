import { describe, expect, test } from "bun:test";
import { adaptFreqtradeBacktest } from "./freqtrade.js";

const trade = (over: Record<string, unknown> = {}) => ({
  pair: "BTC/USDT",
  amount: 0.01,
  open_rate: 100_000,
  close_rate: 101_000,
  fee_open: 0.001,
  fee_close: 0.001,
  profit_abs: 7.99, // gross 10 - fees 2.01 (como reporta Freqtrade)
  open_timestamp: 1_700_000_000_000,
  close_timestamp: 1_700_003_600_000,
  is_open: false,
  exit_reason: "roi",
  ...over,
});

const backtest = (strategies: Record<string, any>) => ({ strategy: strategies });

describe("adaptador Freqtrade", () => {
  test("deriva fees desde fee_open/fee_close y respeta el neto reportado", () => {
    const r = adaptFreqtradeBacktest(backtest({ S: { trades: [trade()], starting_balance: 1000, stake_currency: "USDT" } }));
    expect(r.strategy).toBe("S");
    expect(r.dataset.trades.length).toBe(1);
    const t = r.dataset.trades[0];
    // gross = (101000-100000)*0.01 = 10; fees = 0.01*100000*0.001 + 0.01*101000*0.001 = 2.01
    expect(t.grossPnlUsd).toBeCloseTo(10, 4);
    expect(t.feesUsd).toBeCloseTo(2.01, 4);
    expect(t.netPnlUsd).toBeCloseTo(7.99, 4);
    expect(r.meta.feesUsd).toBeCloseTo(2.01, 4);
    expect(r.meta.grossUsd).toBeCloseTo(10, 2);
    expect(r.meta.netUsd).toBeCloseTo(7.99, 2);
  });

  test("elige la estrategia con mas trades y reporta todas", () => {
    const r = adaptFreqtradeBacktest(
      backtest({
        A: { trades: [trade()] },
        B: { trades: [trade(), trade({ close_timestamp: 1_700_007_200_000 }), trade({ close_timestamp: 1_700_010_800_000 })] },
      })
    );
    expect(r.strategy).toBe("B");
    expect(r.strategies).toEqual(["A", "B"]);
    expect(r.dataset.trades.length).toBe(3);
  });

  test("ignora trades abiertos y sin timestamp de cierre", () => {
    const r = adaptFreqtradeBacktest(
      backtest({ S: { trades: [trade(), trade({ is_open: true }), trade({ close_timestamp: undefined })] } })
    );
    expect(r.dataset.trades.length).toBe(1);
  });

  test("error claro si no hay trades exportados", () => {
    expect(() => adaptFreqtradeBacktest(backtest({ S: { trades: [] } }))).toThrow(/no tiene trades cerrados/);
    expect(() => adaptFreqtradeBacktest({} as any)).toThrow(/falta la clave 'strategy'/);
  });

  test("si el neto reportado no cuadra con precios y fees, se registra la discrepancia", () => {
    // profit_abs declarado 9.5 pero la derivacion da 10 - 2.01 = 7.99
    const r = adaptFreqtradeBacktest(backtest({ S: { trades: [trade({ profit_abs: 9.5 })] } }));
    expect(r.dataset.trades[0].netPnlUsd).toBeCloseTo(7.99, 4);
    expect(r.dataset.issues.join(" ")).toContain("Discrepancia");
  });

  test("la calidad del dataset es SUFFICIENT (costes explicitos)", () => {
    const r = adaptFreqtradeBacktest(backtest({ S: { trades: [trade(), trade({ close_timestamp: 1_700_007_200_000 })] } }));
    expect(r.dataset.quality.sufficiency).toBe("SUFFICIENT");
    expect(r.dataset.quality.rowsWithFees).toBe(2);
  });

  test("acepta estrategia explicita aunque no sea la de mas trades", () => {
    const r = adaptFreqtradeBacktest(backtest({ A: { trades: [trade()] }, B: { trades: [trade(), trade()] } }), "A");
    expect(r.strategy).toBe("A");
    expect(r.dataset.trades.length).toBe(1);
  });
});
