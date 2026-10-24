import { test, expect } from "bun:test";
import { evaluateExitGovernance } from "./exit-governance.js";

test("evaluateExitGovernance retorna HOLD si ganancia no supera comisiones (< 0.60%)", async () => {
  const res = await evaluateExitGovernance("BTC", "btc_usd", 2000, 2005, 2076, 0.10, 5, "BALANCED_RANGE", 0);
  expect(res.action).toBe("HOLD");
  expect(res.fractionToClose).toBe(0);
});

test("evaluateExitGovernance activa TP_PARTIAL_DCA en BTC al superar umbral institucional (+2.40%) asegurando 50% de la posicion", async () => {
  // Precio de entrada: 100000, Precio actual: 102500 (+2.50% de ganancia > tp1Threshold 2.40%)
  const res = await evaluateExitGovernance("BTC", "btc_usd", 100000, 102500, 103800, 0.10, 4, "BALANCED_RANGE", 0);
  expect(res.action).toBe("TAKE_PROFIT_PARTIAL");
  expect(res.fractionToClose).toBe(0.50);
  expect(res.reason).toContain("TP1 Partial secured");
});

test("evaluateExitGovernance activa FRONT_RUN_EXIT si hay ganancia suficiente pero el libro se torna toxico (OFI < -0.50)", async () => {
  // BTC con ganancia +1.00% (> frontRunMin 0.80%), pero venta agresiva barriendo bids (OFI = -0.85)
  const res = await evaluateExitGovernance("BTC", "btc_usd", 100000, 101000, 103800, -0.85, 8, "BALANCED_RANGE", 0);
  expect(res.action).toBe("FRONT_RUN_EXIT");
  expect(res.fractionToClose).toBe(1.0);
  expect(res.reason).toContain("toxic dump");
});

test("evaluateExitGovernance activa TRAILING_EXPANSION si hay euforia compradora neta (OFI > 0.60) en regimen agresivo", async () => {
  // Entrada 100000, actual 102900 (+2.90% > tp1Threshold 2.80%), OFI comprador agresivo: +0.75
  const res = await evaluateExitGovernance("BTC", "btc_usd", 100000, 102900, 103800, 0.75, 3, "AGGRESSIVE_ACCUMULATION", 0);
  expect(res.action).toBe("TRAILING_EXPANSION");
  expect(res.fractionToClose).toBe(0);
});

test("evaluateExitGovernance activa EMERGENCY_DELEVERAGE ante pérdida severa con flujo tóxico extremo", async () => {
  // Entrada 100000, actual 96500 (-3.50%), OFI colapsando -0.90
  const res = await evaluateExitGovernance("BTC", "btc_usd", 100000, 96500, 103800, -0.90, 12, "DEFENSIVE_STRESS", 0);
  expect(res.action).toBe("EMERGENCY_DELEVERAGE");
  expect(res.fractionToClose).toBe(1.0);
  expect(res.reason).toContain("Emergency deleverage");
});

test("evaluateExitGovernance modula dinámicamente según Perfil de Activo (ANCHOR vs BETA)", async () => {
  // En BALANCED_RANGE:
  // +2.50% es TAKE_PROFIT_PARTIAL para BTC (umbral 2.40%)
  const resBtc = await evaluateExitGovernance("BTC", "btc_usd", 100000, 102500, 103800, 0.10, 4, "BALANCED_RANGE", 0);
  expect(resBtc.action).toBe("TAKE_PROFIT_PARTIAL");

  // Pero para SOL (Perfil BETA), +2.50% es HOLD porque su umbral es +3.40% para capturar tendencia explosiva
  const resSol = await evaluateExitGovernance("SOL", "sol_usd", 200, 205, 210, 0.10, 4, "BALANCED_RANGE", 0);
  expect(resSol.action).toBe("HOLD");

  // Al alcanzar +3.60%, SOL sí ejecuta TAKE_PROFIT_PARTIAL
  const resSolProfit = await evaluateExitGovernance("SOL", "sol_usd", 200, 207.2, 210, 0.10, 4, "BALANCED_RANGE", 0);
  expect(resSolProfit.action).toBe("TAKE_PROFIT_PARTIAL");
});
