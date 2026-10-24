import { describe, expect, test } from "bun:test";
import {
  computePaperFill,
  estimateQueueFillProbability,
  DEFAULT_MAKER_FEE_BPS,
  DEFAULT_TAKER_FEE_BPS,
  type PaperFillInput,
} from "./paper-execution.js";

/** Libro base reutilizable: bid 99.9 / ask 100.0 (spread 10 bps). */
const BASE = { bestBid: 99.9, bestAsk: 100, depthUsd: 1_000_000 };

function fill(overrides: Partial<PaperFillInput>) {
  return computePaperFill({
    side: "buy",
    intent: "MAKER",
    levelPrice: 99.5,
    qty: 1,
    ...BASE,
    ...overrides,
  });
}

describe("computePaperFill - maker post-only", () => {
  test("cross de compra: post-only que cruza el libro se reclasifica a TAKER con slippage", () => {
    const r = fill({ side: "buy", intent: "MAKER", levelPrice: 100.5, qty: 10, takeFeeBps: 10 });
    expect(r.filled).toBe(true);
    expect(r.liquidity).toBe("TAKER");
    expect(r.reason).toContain("reclasificado a TAKER");
    expect(r.slippageUsd).toBeGreaterThan(0);
    // Nunca mejora el precio del libro: compra al ask o peor.
    expect(r.fillPrice).toBeGreaterThanOrEqual(BASE.bestAsk);
  });

  test("cross de venta: post-only que cruza se reclasifica a TAKER y vende al bid o peor", () => {
    const r = fill({ side: "sell", intent: "MAKER", levelPrice: 99.5, qty: 10 });
    expect(r.filled).toBe(true);
    expect(r.liquidity).toBe("TAKER");
    expect(r.slippageUsd).toBeGreaterThan(0);
    expect(r.fillPrice).toBeLessThanOrEqual(BASE.bestBid);
  });

  test("post-only sin toque: no llena y conserva el motivo de cola", () => {
    // Compra pasiva por debajo del best bid: el libro no bajo hasta el nivel.
    const r = fill({ side: "buy", intent: "MAKER", levelPrice: 99, qty: 10 });
    expect(r.filled).toBe(false);
    expect(r.filledQty).toBe(0);
    expect(r.fillPrice).toBe(0);
    expect(r.feeUsd).toBe(0);
    expect(r.slippageUsd).toBe(0);
    expect(r.liquidity).toBe("MAKER");
    expect(r.reason).toContain("sin toque");
  });

  test("toque con queueFactor 0.3: llena solo el 70% de la cantidad", () => {
    const r = fill({ side: "buy", intent: "MAKER", levelPrice: 99.9, qty: 100, queueFactor: 0.3, makeFeeBps: 10 });
    expect(r.filled).toBe(true);
    expect(r.liquidity).toBe("MAKER");
    expect(r.filledQty).toBeCloseTo(70, 8);
    expect(r.fillPrice).toBeCloseTo(99.9, 8);
    // El maker obtiene su propio precio: sin slippage adverso.
    expect(r.slippageUsd).toBe(0);
    // fee = 70 * 99.9 * 10/10000
    expect(r.feeUsd).toBeCloseTo(6.993, 4);
  });

  test("queueFactor 0: primera en la cola, llena toda la cantidad", () => {
    const r = fill({ side: "sell", intent: "MAKER", levelPrice: 100, qty: 50, queueFactor: 0 });
    expect(r.filled).toBe(true);
    expect(r.filledQty).toBeCloseTo(50, 8);
    expect(r.fillPrice).toBeCloseTo(100, 8);
  });

  test("queueFactor 1 o mayor: toda la profundidad por delante, sin llenado", () => {
    const r = fill({ side: "buy", intent: "MAKER", levelPrice: 99.9, qty: 100, queueFactor: 1 });
    expect(r.filled).toBe(false);
    expect(r.filledQty).toBe(0);
    expect(r.reason).toContain("cola");

    const clamped = fill({ side: "buy", intent: "MAKER", levelPrice: 99.9, qty: 100, queueFactor: 5 });
    expect(clamped.filled).toBe(false);
  });

  test("queueFactor por defecto es 0.5 (llena la mitad)", () => {
    const r = fill({ side: "buy", intent: "MAKER", levelPrice: 99.9, qty: 100 });
    expect(r.filled).toBe(true);
    expect(r.filledQty).toBeCloseTo(50, 8);
  });
});

describe("computePaperFill - taker", () => {
  test("impacto monótono creciente con el tamaño de la orden", () => {
    const small = computePaperFill({ side: "buy", intent: "TAKER", levelPrice: 100, qty: 10, ...BASE });
    const mid = computePaperFill({ side: "buy", intent: "TAKER", levelPrice: 100, qty: 100, ...BASE });
    const big = computePaperFill({ side: "buy", intent: "TAKER", levelPrice: 100, qty: 1000, ...BASE });

    expect(small.fillPrice).toBeLessThan(mid.fillPrice);
    expect(mid.fillPrice).toBeLessThan(big.fillPrice);
    expect(small.slippageUsd).toBeLessThan(mid.slippageUsd);
    expect(mid.slippageUsd).toBeLessThan(big.slippageUsd);
  });

  test("impacto adverso simétrico: la venta ejecuta por debajo del bid", () => {
    const r = computePaperFill({ side: "sell", intent: "TAKER", levelPrice: 100, qty: 100, ...BASE });
    expect(r.fillPrice).toBeLessThan(BASE.bestBid);
    expect(r.slippageUsd).toBeGreaterThan(0);
  });

  test("qty inmensa: fill parcial limitado a 3x la profundidad visible", () => {
    const depthUsd = 1_000_000;
    const referencePrice = BASE.bestAsk;
    const r = computePaperFill({
      side: "buy",
      intent: "TAKER",
      levelPrice: referencePrice,
      qty: 40_000, // notional = 4.0M > 3 * 1.0M
      bestBid: BASE.bestBid,
      bestAsk: referencePrice,
      depthUsd,
    });
    expect(r.filled).toBe(true);
    expect(r.filledQty).toBeLessThan(40_000);
    expect(r.filledQty).toBeCloseTo((depthUsd * 3) / referencePrice, 6);
    expect(r.reason).toContain("llenado parcial");
  });

  test("fee de taker usa takeFeeBps y escala linealmente con la tasa", () => {
    const a = computePaperFill({ side: "buy", intent: "TAKER", levelPrice: 100, qty: 10, ...BASE, takeFeeBps: 10 });
    const b = computePaperFill({ side: "buy", intent: "TAKER", levelPrice: 100, qty: 10, ...BASE, takeFeeBps: 25 });
    expect(a.feeUsd).toBeCloseTo((a.filledQty * a.fillPrice * 10) / 10000, 4);
    expect(b.feeUsd / a.feeUsd).toBeCloseTo(2.5, 6);
  });

  test("fee de maker usa makeFeeBps: distinto del de taker para el mismo tamaño", () => {
    const maker = fill({ side: "buy", intent: "MAKER", levelPrice: 99.9, qty: 100, queueFactor: 0, makeFeeBps: 25 });
    const taker = computePaperFill({ side: "buy", intent: "TAKER", levelPrice: 100, qty: 100, ...BASE, takeFeeBps: 25 });
    expect(maker.feeUsd).toBeCloseTo((100 * 99.9 * 25) / 10000, 4);
    expect(taker.feeUsd).toBeCloseTo((taker.filledQty * taker.fillPrice * 25) / 10000, 4);
    // El maker paga menos fee absoluto porque ejecuta a un precio menor.
    expect(maker.feeUsd).toBeLessThan(taker.feeUsd);
  });

  test("slippageUsd sigue |fillPrice - referencePrice| * filledQty", () => {
    const r = computePaperFill({ side: "buy", intent: "TAKER", levelPrice: 100, qty: 250, ...BASE });
    const expected = Math.abs(r.fillPrice - BASE.bestAsk) * r.filledQty;
    expect(r.slippageUsd).toBeCloseTo(expected, 4);
  });
});

describe("computePaperFill - invariantes y validacion", () => {
  test("propiedad: un TAKER de compra nunca mejora el libro (fillPrice >= bestAsk)", () => {
    for (const qty of [0.5, 5, 50, 500, 5000]) {
      const r = computePaperFill({ side: "buy", intent: "TAKER", levelPrice: 100, qty, ...BASE });
      expect(r.fillPrice).toBeGreaterThanOrEqual(BASE.bestAsk);
    }
  });

  test("propiedad: un TAKER de venta nunca mejora el libro (fillPrice <= bestBid)", () => {
    for (const qty of [0.5, 5, 50, 500, 5000]) {
      const r = computePaperFill({ side: "sell", intent: "TAKER", levelPrice: 100, qty, ...BASE });
      expect(r.fillPrice).toBeLessThanOrEqual(BASE.bestBid);
    }
  });

  test("propiedad: un MAKER sin cruce nunca paga mas caro que el ask (compra)", () => {
    // Nivel alcanzado por el bid (99.9) pero por debajo del ask (100): descansa y llena.
    const r = fill({ side: "buy", intent: "MAKER", levelPrice: 99.9, qty: 10, queueFactor: 0 });
    expect(r.filled).toBe(true);
    expect(r.fillPrice).toBeLessThanOrEqual(BASE.bestAsk);
  });

  test("entradas invalidas devuelven filled=false sin lanzar", () => {
    const cases: Array<Partial<PaperFillInput>> = [
      { levelPrice: 0 },
      { levelPrice: -5 },
      { qty: 0 },
      { qty: -1 },
      { bestBid: 0 },
      { bestAsk: 0 },
      { bestAsk: Number.NaN },
      { depthUsd: -1 },
      { levelPrice: Number.POSITIVE_INFINITY },
    ];
    for (const c of cases) {
      const r = fill(c);
      expect(r.filled).toBe(false);
      expect(r.reason.length).toBeGreaterThan(0);
      expect(r.filledQty).toBe(0);
      expect(r.feeUsd).toBe(0);
    }
  });

  test("taker sin profundidad disponible no llena y lo reporta", () => {
    const r = computePaperFill({ side: "buy", intent: "TAKER", levelPrice: 100, qty: 10, bestBid: 99.9, bestAsk: 100, depthUsd: 0 });
    expect(r.filled).toBe(false);
    expect(r.liquidity).toBe("TAKER");
    expect(r.reason).toContain("profundidad");
  });

  test("constantes por defecto de comision expuestas", () => {
    expect(DEFAULT_TAKER_FEE_BPS).toBe(10);
    expect(DEFAULT_MAKER_FEE_BPS).toBe(10);
  });
});

describe("estimateQueueFillProbability", () => {
  test("acotada en [0, 1] y decreciente con la distancia", () => {
    const near = estimateQueueFillProbability(0.1, 1);
    const mid = estimateQueueFillProbability(1, 1);
    const far = estimateQueueFillProbability(10, 1);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    for (const p of [near, mid, far]) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  test("creciente con la volatilidad", () => {
    const low = estimateQueueFillProbability(1, 0.1);
    const high = estimateQueueFillProbability(1, 5);
    expect(high).toBeGreaterThan(low);
  });

  test("casos limite: distancia 0 => 1, volatilidad 0 => 0, entradas invalidas => 0", () => {
    expect(estimateQueueFillProbability(0, 1)).toBe(1);
    expect(estimateQueueFillProbability(1, 0)).toBe(0);
    expect(estimateQueueFillProbability(Number.NaN, 1)).toBe(0);
    expect(estimateQueueFillProbability(1, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
