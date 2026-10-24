import { test, expect } from "bun:test";
import { OrderFlowImbalanceAnalyzer } from "./ofi-analyzer.js";

test("OrderFlowImbalanceAnalyzer detecta presion compradora", () => {
  const analyzer = new OrderFlowImbalanceAnalyzer();

  const snapshot = {
    timestamp: Date.now(),
    bids: [
      { price: 100, amount: 2.0 }, // $200
      { price: 99, amount: 3.0 },  // $297 * 0.5 = ~$148.5
      { price: 98, amount: 5.0 },  // $490 * 0.33 = ~$161.7
    ],
    asks: [
      { price: 101, amount: 0.2 }, // $20.2
      { price: 102, amount: 0.5 }, // $51 * 0.5 = ~$25.5
      { price: 103, amount: 0.5 }, // $51.5 * 0.33 = ~$17
    ],
  };

  const metrics = analyzer.analyze(snapshot);
  expect(metrics.ofiScore).toBeGreaterThan(0.5);
  expect(metrics.depthRatio).toBeGreaterThan(0.7);
  expect(metrics.isLiquidityEvaporating).toBe(false);
});

test("OrderFlowImbalanceAnalyzer detecta evaporacion de liquidez", () => {
  const analyzer = new OrderFlowImbalanceAnalyzer();

  // Snapshot 1: Mucha liquidez compradora
  analyzer.analyze({
    timestamp: Date.now() - 5000,
    bids: [
      { price: 100, amount: 10.0 },
      { price: 99, amount: 10.0 },
      { price: 98, amount: 10.0 },
    ],
    asks: [{ price: 101, amount: 1.0 }],
  });

  // Snapshot 2: Desaparicion del 70% del libro comprador (spoofing o retirada)
  const metrics2 = analyzer.analyze({
    timestamp: Date.now(),
    bids: [
      { price: 100, amount: 1.0 },
      { price: 99, amount: 1.0 },
      { price: 98, amount: 1.0 },
    ],
    asks: [{ price: 101, amount: 1.0 }],
  });

  expect(metrics2.isLiquidityEvaporating).toBe(true);
});
