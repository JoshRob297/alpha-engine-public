import { readFileSync } from "node:fs";
import { calculateATR14 } from "../src/guardrails/volatility-adaptive-sets.js";

const RAW_FILE = "/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json";
const allCandles = JSON.parse(readFileSync(RAW_FILE, "utf-8"));
const monthCandles = allCandles.slice(96, 96 + 720);

for (let h = 20; h < 35; h++) {
  const windowCandles = monthCandles.slice(h - 14, h + 1);
  const { atrPct } = calculateATR14(windowCandles);
  console.log(`[H=${h}] Close: $${monthCandles[h].close} | ATR14: ${(atrPct * 100).toFixed(3)}% | TP 1.4x: ${(atrPct * 1.4 * 100).toFixed(3)}%`);
}
