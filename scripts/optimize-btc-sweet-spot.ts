import { readFileSync } from "node:fs";

const RAW_FILE = "/mnt/storage/alpha-backtest/raw/btc_1h.json";
const candles = JSON.parse(readFileSync(RAW_FILE, "utf-8"));
const FX_RATE = 17.72;
const CAPITAL_USD = 258.75;

function testSweetSpot(tp1Pct: number, tp2Pct: number, stopPct: number, spacingPct: number) {
  let inPos = false;
  let qty = 0;
  let entryAvg = 0;
  let tp1Price = 0;
  let tp2Price = 0;
  let stopPrice = 0;
  let partialTaken = false;
  let cash = CAPITAL_USD;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;

  let gridPrice = candles[0].open * (1 - spacingPct);
  let gridUsd = CAPITAL_USD * 0.40;

  for (let t = 0; t < candles.length; t++) {
    const c = candles[t];
    const midPrice = (c.open + c.close) / 2;

    if (!inPos && c.low <= gridPrice) {
      inPos = true;
      qty = gridUsd / gridPrice;
      entryAvg = gridPrice;
      tp1Price = entryAvg * (1 + tp1Pct);
      tp2Price = entryAvg * (1 + tp2Pct);
      stopPrice = entryAvg * (1 - stopPct);
      partialTaken = false;
      cash -= gridUsd;
    }

    if (inPos) {
      if (c.low <= stopPrice) {
        const proceeds = qty * stopPrice;
        const loss = proceeds - qty * entryAvg;
        cash += proceeds;
        grossLoss += Math.abs(loss);
        losses++;
        inPos = false;
        qty = 0;
        entryAvg = 0;
        gridPrice = midPrice * (1 - spacingPct);
      } else if (!partialTaken && c.high >= tp1Price) {
        const closeQty = qty * 0.50;
        const proceeds = closeQty * tp1Price;
        const profit = proceeds - closeQty * entryAvg;
        cash += proceeds;
        grossProfit += profit;
        qty -= closeQty;
        partialTaken = true;
        stopPrice = entryAvg * 1.002; // Subir a Break-Even
        wins++;
      } else if (partialTaken && c.high >= tp2Price) {
        const proceeds = qty * tp2Price;
        const profit = proceeds - qty * entryAvg;
        cash += proceeds;
        grossProfit += profit;
        wins++;
        inPos = false;
        qty = 0;
        entryAvg = 0;
        gridPrice = midPrice * (1 - spacingPct);
      }
    }
  }

  const netPnlMxn = (cash - CAPITAL_USD) * FX_RATE;
  const winRate = (wins / (wins + losses)) * 100;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : 99;

  console.log(`TP1: +${(tp1Pct*100).toFixed(1)}% | Stop: -${(stopPct*100).toFixed(1)}% | Spacing: -${(spacingPct*100).toFixed(1)}%`);
  console.log(`-> PnL Neto: ${netPnlMxn >= 0 ? "+" : ""}$${netPnlMxn.toFixed(2)} MXN | Win Rate: ${winRate.toFixed(1)}% | Trades: ${wins + losses} | PF: ${pf.toFixed(2)}\n`);
}

console.log("=== BÚSQUEDA DEL PUNTO DULCE MATEMÁTICO PARA BITCOIN ===");
testSweetSpot(0.021, 0.034, 0.042, 0.012);
testSweetSpot(0.018, 0.028, 0.038, 0.010);
testSweetSpot(0.024, 0.038, 0.045, 0.015);
