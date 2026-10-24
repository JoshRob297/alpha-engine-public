import { readFileSync } from "node:fs";

const solCandlesAll = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/raw/sol_1h.json", "utf-8"));
const solMonth = solCandlesAll.slice(solCandlesAll.length - 720);

// Inspeccionar cuándo ocurrieron las pérdidas en SOL
let cash = 1000;
let inPos = false;
let entry = 0;
let entryH = 0;
let stop = 0;
let tp = 0;
let gridPrice = solMonth[0].open * 0.975;

for (let h = 0; h < 720; h++) {
  const c = solMonth[h];
  const mid = (c.open + c.close) / 2;

  if (!inPos && c.low <= gridPrice) {
    inPos = true;
    entry = gridPrice;
    entryH = h;
    tp = entry * 1.02;
    stop = entry * 0.96;
    console.log(`[H=${h}] COMPRA @ $${entry.toFixed(2)}`);
  } else if (inPos && h > entryH) {
    if (c.low <= stop) {
      console.log(`[H=${h}] STOP LOSS @ $${stop.toFixed(2)} (Hold: ${h - entryH}h)`);
      inPos = false;
      gridPrice = mid * 0.975;
    } else if (c.high >= tp) {
      console.log(`[H=${h}] TAKE PROFIT @ $${tp.toFixed(2)} (Hold: ${h - entryH}h)`);
      inPos = false;
      gridPrice = mid * 0.975;
    }
  }
}
