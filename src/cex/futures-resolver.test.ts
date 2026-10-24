import { test, expect } from "bun:test";
import { DynamicFuturesResolver } from "./futures-resolver.js";

test("DynamicFuturesResolver resuelve correctamente contratos de futuros para pools arbitrarios", async () => {
  // Pool de par volátil con moneda estable
  const r1 = await DynamicFuturesResolver.resolveHedgeForPool("AERO-USDC");
  expect(r1).not.toBeNull();
  expect(r1?.hedgeSymbol).toBe("AEROUSDT");
  expect(r1?.volatileToken).toBe("AERO");

  // Pool con token envuelto (WETH-CBBTC)
  const r2 = await DynamicFuturesResolver.resolveHedgeForPool("WETH-CBBTC");
  expect(r2).not.toBeNull();
  expect(r2?.hedgeSymbol).toBe("ETHUSDT");

  // Pool con cbBTC y stablecoin
  const r3 = await DynamicFuturesResolver.resolveHedgeForPool("USDC-CBBTC");
  expect(r3).not.toBeNull();
  expect(r3?.hedgeSymbol).toBe("BTCUSDT");

  // Pool con Solana si se descubriera
  const r4 = await DynamicFuturesResolver.resolveHedgeForPool("WSOL-USDC");
  expect(r4).not.toBeNull();
  expect(r4?.hedgeSymbol).toBe("SOLUSDT");
});
