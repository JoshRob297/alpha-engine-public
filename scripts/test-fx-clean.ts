import { readFileSync } from "node:fs";
import { join } from "node:path";

const RAW_DIR = "/mnt/storage/alpha-backtest/raw";
const candles = JSON.parse(readFileSync(join(RAW_DIR, "usd_mxn_1h.json"), "utf-8"));
const FX_RATE = 17.72;

let inPos = false;
let qty = 0;
let entryAvg = 0;
let cash = 400.0;
let wins = 0;
let losses = 0;
let pnlUsd = 0;

for (let t = 0; t < candles.length; t++) {
  const c = candles[t];
  const gridPrice = c.open * 0.9985;
  const gridUsd = 240.0; // 60%

  if (!inPos && c.low <= gridPrice) {
    inPos = true;
    qty = gridUsd / gridPrice;
    entryAvg = gridPrice;
    cash -= gridUsd;
  }

  if (inPos) {
    const tpPrice = entryAvg * 1.0045;
    const stopPrice = entryAvg * 0.992; // -0.8%

    if (c.low <= stopPrice) {
      const proceeds = qty * stopPrice;
      const loss = proceeds - qty * entryAvg;
      cash += proceeds;
      pnlUsd += loss;
      losses++;
      inPos = false;
    } else if (c.high >= tpPrice) {
      const proceeds = qty * tpPrice;
      const profit = proceeds - qty * entryAvg;
      cash += proceeds;
      pnlUsd += profit;
      wins++;
      inPos = false;
    }
  }
}

console.log("FX Modo Limpio:");
console.log(`Wins: ${wins} | Losses: ${losses} | PnL: +$${(pnlUsd * FX_RATE).toFixed(2)} MXN`);
