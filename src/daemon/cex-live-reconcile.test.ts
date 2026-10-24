import { test, expect } from "bun:test";
import { DynamicAlphaOrchestrator } from "./dynamic-orchestrator.js";
import { CexEngine } from "./cex-engine.js";
import { GridBot, DEFAULT_GENOME, type Genome } from "../genetic/bot.js";
import { adaptEvolvedAtrGenome, isConcreteGenome, isEvolvedAtrGenome } from "../genetic/genome-adapter.js";

function seedBot(orch: DynamicAlphaOrchestrator, ticker: string, symbol: string, cash: number): GridBot {
  const genome: Genome = { ...DEFAULT_GENOME, levels: 2, spacing: 0.01 };
  const bot = new GridBot(genome, cash);
  bot._open(100, 0, 0.6); // abre malla con L1 lleno a 100
  orch.getCexBots().set(ticker, {
    ticker,
    book: symbol,
    bot,
    allocatedCashUsd: cash,
    allocationReason: "TEST",
  });
  return bot;
}

test("adaptEvolvedAtrGenome normaliza genoma ATR a porcentajes con pisos de seguridad", () => {
  const g = adaptEvolvedAtrGenome({ k_spacing: 1.21, k_tp: 3.47, k_stop: 3.23 });
  expect(isConcreteGenome(g)).toBe(true);
  expect(g.spacing).toBeCloseTo(1.21 * 0.005, 5);
  expect(g.tp).toBeCloseTo(3.47 * 0.008, 5);
  expect(g.stop).toBeCloseTo(3.23 * 0.015, 5);
  // Todos los campos requeridos por GridBot deben existir (no NaN/undefined).
  for (const k of ["family", "lookback", "entryZ", "levels", "spacing", "mult", "tp", "stop"]) {
    expect((g as any)[k]).toBeDefined();
  }
});

test("adaptEvolvedAtrGenome respeta un Genome concreto y cae al default si es invalido", () => {
  const concrete: Genome = { ...DEFAULT_GENOME, spacing: 0.009 };
  expect(adaptEvolvedAtrGenome(concrete)).toBe(concrete);
  expect(adaptEvolvedAtrGenome(null)).toEqual(DEFAULT_GENOME);
  expect(adaptEvolvedAtrGenome({ foo: 1 })).toEqual(DEFAULT_GENOME);
  expect(isEvolvedAtrGenome({ k_spacing: 1 })).toBe(true);
});

test("applyLiveMutation GRID_FILL marca el nivel y suma inventario", () => {
  const orch = new DynamicAlphaOrchestrator(1000);
  const cex = new CexEngine(orch);
  const bot = seedBot(orch, "BTC", "BTCUSDT", 100);
  const lvl = bot.levels.find((l) => !l.filled);
  expect(lvl).toBeDefined();

  const qtyBefore = bot.qty;
  (cex as any).applyLiveMutation({ kind: "GRID_FILL", ticker: "BTC", levelName: lvl!.name, usd: 20 }, 0.0002, 100000);

  expect(lvl!.filled).toBe(true);
  expect(bot.qty).toBeGreaterThan(qtyBefore);
});

test("reconcileLiveOrders aplica la mutacion solo cuando Binance confirma FILLED", async () => {
  const orch = new DynamicAlphaOrchestrator(1000);
  const cex = new CexEngine(orch);
  const bot = seedBot(orch, "BTC", "BTCUSDT", 100);
  const lvl = bot.levels.find((l) => !l.filled)!;

  const driver: any = orch.getBinanceDriver();
  driver.isConfigured = () => true;
  driver.getOrderStatus = async () => ({ status: "FILLED", executedQty: "0.0003", price: "100000", orderId: 1 });

  (cex as any).pendingLiveOrders.set("coid_1", {
    ticker: "BTC",
    symbol: "BTCUSDT",
    side: "BUY",
    price: 100000,
    qty: 0.0003,
    mutation: { kind: "GRID_FILL", ticker: "BTC", levelName: lvl.name, usd: 30 },
    placedAt: Date.now(),
  });

  const tradesBefore = orch.getLedger().getHistory().length;
  await (cex as any).reconcileLiveOrders();

  expect((cex as any).pendingLiveOrders.size).toBe(0);
  expect(lvl.filled).toBe(true);
  expect(orch.getLedger().getHistory().length).toBeGreaterThan(tradesBefore);
});

test("reconcileLiveOrders descarta la orden si Binance la reporta CANCELED (sin mutar estado)", async () => {
  const orch = new DynamicAlphaOrchestrator(1000);
  const cex = new CexEngine(orch);
  const bot = seedBot(orch, "BTC", "BTCUSDT", 100);
  const lvl = bot.levels.find((l) => !l.filled)!;

  const driver: any = orch.getBinanceDriver();
  driver.isConfigured = () => true;
  driver.getOrderStatus = async () => ({ status: "CANCELED", executedQty: "0", price: "100000", orderId: 2 });

  (cex as any).pendingLiveOrders.set("coid_2", {
    ticker: "BTC",
    symbol: "BTCUSDT",
    side: "BUY",
    price: 100000,
    qty: 0.0003,
    mutation: { kind: "GRID_FILL", ticker: "BTC", levelName: lvl.name, usd: 30 },
    placedAt: Date.now(),
  });

  const tradesBefore = orch.getLedger().getHistory().length;
  await (cex as any).reconcileLiveOrders();

  expect((cex as any).pendingLiveOrders.size).toBe(0);
  expect(lvl.filled).toBe(false);
  expect(orch.getLedger().getHistory().length).toBe(tradesBefore);
});

test("hasPendingLiveOrder evita reenvios duplicados del mismo nivel", () => {
  const orch = new DynamicAlphaOrchestrator(1000);
  const cex = new CexEngine(orch);

  (cex as any).pendingLiveOrders.set("coid_3", {
    ticker: "SOL",
    symbol: "SOLUSDT",
    side: "BUY",
    price: 118,
    qty: 1,
    mutation: { kind: "GRID_FILL", ticker: "SOL", levelName: "L2", usd: 10 },
    placedAt: Date.now(),
  });

  expect((cex as any).hasPendingLiveOrder("SOL", { levelName: "L2", kinds: ["GRID_FILL"] })).toBe(true);
  expect((cex as any).hasPendingLiveOrder("SOL", { levelName: "L1", kinds: ["GRID_FILL"] })).toBe(false);
  expect((cex as any).hasPendingLiveOrder("SOL", { kinds: ["EXIT_FULL"] })).toBe(false);
  expect((cex as any).hasPendingLiveOrder("BTC", { kinds: ["GRID_FILL"] })).toBe(false);
});

test("reconcileLiveStateOnStartup es no-op en modo PAPER", async () => {
  const orch = new DynamicAlphaOrchestrator(1000);
  const bot = seedBot(orch, "BTC", "BTCUSDT", 100);
  const qtyBefore = bot.qty;

  // En PAPER no debe tocar el inventario ni requerir Binance.
  await orch.reconcileLiveStateOnStartup();
  expect(bot.qty).toBe(qtyBefore);
});

