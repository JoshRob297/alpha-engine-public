import { test, expect } from "bun:test";
import { fetchTopBaseConcentratedPools } from "./dex-pool-feeder.js";

test.skipIf(process.env.OFFLINE === "1")("fetchTopBaseConcentratedPools descarga pools de Base con TVL > $1M", async () => {
  const pools = await fetchTopBaseConcentratedPools(500_000, 500_000);
  expect(pools.length).toBeGreaterThan(0);
  const first = pools[0];
  expect(first.chain).toBe("Base");
  expect(first.tvlUsd).toBeGreaterThan(500_000);
  expect(first.feeAprPct).toBeGreaterThan(5.0);
  console.log(`Top Pool detectado en Base: ${first.symbol} (${first.project}) con ${first.feeAprPct}% APR y TVL $${(first.tvlUsd/1e6).toFixed(2)}M`);
});
