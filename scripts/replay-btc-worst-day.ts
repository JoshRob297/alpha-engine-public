import { readFileSync } from "node:fs";

const btcCandles = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/raw/btc_1h.json", "utf-8"));

// Simular las 24 horas del colapso del 14 de Noviembre de 2025 (Vela #1162)
// Bitcoin cayó de $104,000 a $94,000 en 24h
const startIndex = 1150;
const slice = btcCandles.slice(startIndex, startIndex + 24);

console.log("================================================================================");
console.log("   SIMULACIÓN FORENSE 24H DEL PEOR COLAPSO DE BITCOIN (14 DE NOVIEMBRE)");
console.log(`   Apertura: $${slice[0].open} | Min: $${Math.min(...slice.map((c: any) => c.low))} | Max: $${Math.max(...slice.map((c: any) => c.high))} USD`);
console.log("================================================================================\n");

let inPos = false;
let qty = 0;
let entryAvg = 0;
let tpPrice = 0;
let stopPrice = 0;
let cashUsd = 258.75;
let realizedPnlUsd = 0;

let gridPrice = slice[0].open * 0.992;
let gridUsd = 258.75 * 0.40;

for (let h = 0; h < 24; h++) {
  const c = slice[h];
  const time = new Date(c.timestamp).toISOString();
  let action = "Monitoreando libro...";

  if (!inPos && c.low <= gridPrice) {
    inPos = true;
    qty = gridUsd / gridPrice;
    entryAvg = gridPrice;
    tpPrice = entryAvg * 1.0145; // +1.45%
    stopPrice = entryAvg * 0.925; // -7.5%
    cashUsd -= gridUsd;
    action = `COMPRA: $${qty.toFixed(6)} BTC @ $${entryAvg.toFixed(2)} USD. TP: $${tpPrice.toFixed(2)}. Stop: $${stopPrice.toFixed(2)}`;
  } else if (inPos) {
    if (c.low <= stopPrice) {
      const proceeds = qty * stopPrice;
      const loss = proceeds - qty * entryAvg;
      cashUsd += proceeds;
      realizedPnlUsd += loss;
      action = `STOP LOSS IMPACTADO: Salida a $${stopPrice.toFixed(2)} USD (-7.5%). Pérdida: -$${Math.abs(loss).toFixed(2)} USD (-$${(Math.abs(loss) * 17.72).toFixed(2)} MXN)`;
      inPos = false;
    } else if (c.high >= tpPrice) {
      const proceeds = qty * tpPrice;
      const profit = proceeds - qty * entryAvg;
      cashUsd += proceeds;
      realizedPnlUsd += profit;
      action = `TAKE PROFIT: Salida a $${tpPrice.toFixed(2)} USD (+1.45%). Ganancia: +$${profit.toFixed(2)} USD`;
      inPos = false;
    }
  }

  console.log(`Hora ${String(h + 1).padStart(2, "0")} [${time.slice(11, 16)}] | BTC: $${c.close.toFixed(2)} (Low: $${c.low.toFixed(2)} / High: $${c.high.toFixed(2)})`);
  console.log(`        Acción : ${action}\n`);
}

console.log("================================================================================");
console.log(`Pérdida en el Día del Colapso: $${realizedPnlUsd.toFixed(2)} USD (~$${(realizedPnlUsd * 17.72).toFixed(2)} MXN)`);
console.log("================================================================================");
