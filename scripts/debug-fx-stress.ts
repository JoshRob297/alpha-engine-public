import { readFileSync } from "node:fs";
import { join } from "node:path";

const RAW_DIR = "/mnt/storage/alpha-backtest/raw";
const candles = JSON.parse(readFileSync(join(RAW_DIR, "usd_mxn_1h.json"), "utf-8"));

console.log("Velas FX:", candles.length);
let wins = 0;
let losses = 0;
for (let t = 0; t < candles.length; t++) {
  const c = candles[t];
  const isStress = c.close < (candles[Math.max(0, t - 24)].close * 0.96);
  if (isStress) losses++;
}
console.log("Velas marcadas con isStress en FX:", losses);
