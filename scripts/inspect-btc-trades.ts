import { readFileSync } from "node:fs";

const btcCandlesAll = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/raw/btc_1h.json", "utf-8"));
const btcMonth = btcCandlesAll.slice(btcCandlesAll.length - 720);

// Comportamiento del motor anterior en BTC
let cash = 1000;
let inPos = false;
let holdings = 0;
let entry = 0;
let entryH = 0;
let stop = 0;
let tp = 0;
let wins = 0;
let losses = 0;
let fees = 0;

const spacing = 0.015;
const tpTarget = 0.012;
const stopTarget = 0.025;
let gridPrice = btcMonth[0].open * (1 - spacing);

for (let h = 0; h < 720; h++) {
  const c = btcMonth[h];
  const mid = (c.open + c.close) / 2;

  if (!inPos && c.low <= gridPrice) {
    inPos = true;
    holdings = 250 / gridPrice;
    entry = gridPrice;
    entryH = h;
    tp = entry * (1 + tpTarget);
    stop = entry * (1 - stopTarget);
    const fee = 250 * 0.001;
    cash -= (250 + fee);
    fees += fee;
    console.log(`[BTC H=${h}] COMPRA @ $${entry.toFixed(2)}`);
  } else if (inPos && h > entryH) {
    if (c.low <= stop) {
      console.log(`[BTC H=${h}] STOP @ $${stop.toFixed(2)}`);
      inPos = false;
      losses++;
      gridPrice = mid * (1 - spacing);
    } else if (c.high >= tp) {
      console.log(`[BTC H=${h}] TP @ $${tp.toFixed(2)}`);
      const gross = holdings * tp;
      const fee = gross * 0.001;
      cash += (gross - fee);
      fees += fee;
      wins++;
      inPos = false;
      gridPrice = mid * (1 - spacing);
    }
  }
}

if (inPos) {
  const p = btcMonth[719].close;
  cash += (holdings * p * 0.999);
}

console.log(`Resultado Base BTC: PnL +$${(cash - 1000).toFixed(2)} USD | Wins: ${wins} | Losses: ${losses} | Fees: -$${fees.toFixed(2)}`);
