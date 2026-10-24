import { evaluateMarketWithJev } from "../src/guardrails/typesafe-jev-client.js";

async function testJev() {
  try {
    console.log("Probando Jev...");
    const res = await evaluateMarketWithJev({
      ticker: "BTC",
      book: "BTCUSDT",
      midPrice: 0,
      spreadBps: 5.0,
      bidsDepthUsd: 0,
      asksDepthUsd: 0,
      ofiScore: 0.1,
      depthRatio: 1.0,
      isLiquidityEvaporating: false,
    });
    console.log("Jev respondió:", res);
  } catch (e: any) {
    console.error("Error en Jev:", e.message);
  }
}
testJev();
