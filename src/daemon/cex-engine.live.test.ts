import { test, expect } from "bun:test";
import { DynamicAlphaOrchestrator } from "./dynamic-orchestrator.js";
import { CexEngine } from "./cex-engine.js";
import { mapJevRegimeToRiskRegime, BINANCE_PAIRS } from "./capital-allocator.js";

test("mapJevRegimeToRiskRegime traduce el vocabulario de Jev al optimizador de riesgo", () => {
  expect(mapJevRegimeToRiskRegime("AGGRESSIVE_ACCUMULATION")).toBe("ACCUMULATE");
  expect(mapJevRegimeToRiskRegime("DEFENSIVE_STRESS")).toBe("VOLATILE_CRASH");
  expect(mapJevRegimeToRiskRegime("BALANCED_RANGE")).toBe("BALANCED_RANGE");
  expect(mapJevRegimeToRiskRegime("DESCONOCIDO")).toBe("BALANCED_RANGE");
});

test("placeCexOrder aborta sin mutar estado cuando el driver no esta configurado", async () => {
  // Forzar entorno sin credenciales para aislar el comportamiento de la guardia.
  const saved = {
    key: process.env.BINANCE_API_KEY,
    secret: process.env.BINANCE_SECRET,
    secret2: process.env.BINANCE_API_SECRET,
  };
  delete process.env.BINANCE_API_KEY;
  delete process.env.BINANCE_SECRET;
  delete process.env.BINANCE_API_SECRET;

  try {
    const orch = new DynamicAlphaOrchestrator(1000);
    const cex = new CexEngine(orch);

    const result = await cex.placeCexOrder("BTC", "buy", 50000, 0.0001);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("DRIVER_NOT_CONFIGURED");
    expect((cex as any).pendingLiveOrders.size).toBe(0);
  } finally {
    if (saved.key) process.env.BINANCE_API_KEY = saved.key;
    if (saved.secret) process.env.BINANCE_SECRET = saved.secret;
    if (saved.secret2) process.env.BINANCE_API_SECRET = saved.secret2;
  }
});

test("placeCexOrder aborta si el ticker no tiene par Binance resuelto", async () => {
  const orch = new DynamicAlphaOrchestrator(1000);
  const cex = new CexEngine(orch);

  const result = await cex.placeCexOrder("DESCONOCIDO", "buy", 1, 1);
  expect(result.ok).toBe(false);
  expect(result.reason).toBe("SYMBOL_NOT_RESOLVED");
});

test("BINANCE_PAIRS resuelve los pares institucionales base", () => {
  expect(BINANCE_PAIRS.BTC).toBe("BTCUSDT");
  expect(BINANCE_PAIRS.SOL).toBe("SOLUSDT");
});

test("ShadowLPEngine pause/resume alternan el estado defensivo", () => {
  const orch = new DynamicAlphaOrchestrator(1000);
  orch.getCapitalAllocator();
  // Obtener un engine via posición DEX tras sincronizar watchlist mínima
  const entry = Array.from(orch.getDexPositions().values())[0];
  if (entry) {
    entry.engine.resume();
    expect(entry.engine.getSnapshot().status).toBe("ACTIVE");
    entry.engine.pause();
    expect(entry.engine.getSnapshot().status).toBe("PAUSED_DEFENSIVE");
    entry.engine.resume();
    expect(entry.engine.getSnapshot().status).toBe("ACTIVE");
  }
});
