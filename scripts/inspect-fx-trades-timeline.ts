import { readFileSync } from "node:fs";

const RAW_FILE = "/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json";
const allCandles = JSON.parse(readFileSync(RAW_FILE, "utf-8"));
const TOTAL_HOURS = 720;
const testCandles = allCandles.slice(allCandles.length - TOTAL_HOURS);

let inPos = false;
let entryPrice = 0;
let gridPrice = testCandles[0].open * 0.9985;

for (let h = 0; h < TOTAL_HOURS; h++) {
  const c = testCandles[h];
  const mid = (c.open + c.close) / 2;

  if (!inPos && c.low <= gridPrice) {
    inPos = true;
    entryPrice = gridPrice;
    console.log(`[H=${h}] COMPRA @ $${entryPrice.toFixed(3)} | Low: $${c.low.toFixed(3)}`);
  } else if (inPos) {
    const tp = entryPrice * 1.0045;
    const stop = entryPrice * 0.992;
    if (c.low <= stop) {
      console.log(`[H=${h}] STOP LOSS @ $${stop.toFixed(3)} | Low: $${c.low.toFixed(3)}`);
      inPos = false;
      gridPrice = mid * 0.9985;
    } else if (c.high >= tp) {
      console.log(`[H=${h}] TAKE PROFIT @ $${tp.toFixed(3)} | High: $${c.high.toFixed(3)}`);
      inPos = false;
      gridPrice = mid * 0.9985;
    }
  }
}
