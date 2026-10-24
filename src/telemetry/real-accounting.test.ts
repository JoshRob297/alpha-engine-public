import { test, expect } from "bun:test";
import { RealAccountingLedger } from "./real-accounting.js";

test("RealAccountingLedger carga estado por defecto auditado en Binance Spot y Base L2", () => {
  const ledger = new RealAccountingLedger("/tmp/opencode/test_real_ledger.json");
  const state = ledger.getState();

  expect(state.initialCapitalDepositUsd).toBe(0.0);
  expect(state.totalDepositedUsd).toBe(0.0);
  expect(state.binanceLive.bnb).toBeGreaterThan(0);
  expect(state.binanceLive.status).toBe("AWAITING_FUNDS");
  expect(state.baseL2Live.address).toBe("<wallet-address>");
  expect(state.pnlRealSummary.netProfitUsd).toBe(0.0);
});
