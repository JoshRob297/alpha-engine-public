/**
 * BÚSQUEDA DEL EQUILIBRIO PERFECTO:
 * Comparar TP entre +0.45%, +0.50%, +0.55%, +0.60% con Breakeven dinámico
 */
import { readFileSync } from "node:fs";

const allCandles = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json", "utf-8"));
const monthCandles = allCandles.slice(96, 96 + 720);
const INITIAL_MXN = 17720.0;
const ORDER_USD = 250.0;
const MAKER_FEE = 0.0010;

function evaluate(tpPct: number, beTriggerPct: number, beLockPct: number) {
  let cash = INITIAL_MXN;
  let inPos = false;
  let usd = 0;
  let entry = 0;
  let entryH = 0;
  let stop = 0;
  let tp = 0;
  let wins = 0;
  let losses = 0;
  let beWins = 0;
  let fees = 0;
  let gridPrice = monthCandles[0].open * 0.9985;

  for (let h = 0; h < 720; h++) {
    const c = monthCandles[h];
    const mid = (c.open + c.close) / 2;

    if (!inPos && c.low <= gridPrice) {
      inPos = true;
      usd = ORDER_USD;
      entry = gridPrice;
      entryH = h;
      tp = entry * (1 + tpPct);
      stop = entry * 0.9920;
      const fee = usd * entry * MAKER_FEE;
      cash -= (usd * entry + fee);
      fees += fee;
    } else if (inPos && h > entryH) {
      if (c.high >= entry * (1 + beTriggerPct) && stop < entry * (1 + beLockPct)) {
        stop = entry * (1 + beLockPct);
      }

      if (c.low <= stop) {
        const fee = usd * stop * MAKER_FEE;
        const net = usd * stop - fee;
        const pnl = net - usd * entry;
        cash += net;
        fees += fee;
        if (pnl >= 0) beWins++;
        else losses++;
        inPos = false;
        gridPrice = mid * 0.9985;
      } else if (c.high >= tp) {
        const fee = usd * tp * MAKER_FEE;
        const net = usd * tp - fee;
        cash += net;
        fees += fee;
        wins++;
        inPos = false;
        gridPrice = mid * 0.9985;
      }
    }
  }

  if (inPos) {
    const p = monthCandles[719].close;
    const fee = usd * p * MAKER_FEE;
    cash += (usd * p - fee);
    fees += fee;
  }

  const pnl = cash - INITIAL_MXN;
  return { tpPct, pnl: parseFloat(pnl.toFixed(2)), wins, beWins, losses, fees: parseFloat(fees.toFixed(2)) };
}

console.log("Optimizando TP y Breakeven en el Peor Mes:");
const tps = [0.0040, 0.0045, 0.0050, 0.0055];
for (const tp of tps) {
  const r = evaluate(tp, 0.0030, 0.0012);
  console.log(`TP +${(tp*100).toFixed(2)}% | PnL: ${r.pnl >= 0 ? "+" : ""}$${r.pnl} MXN | Wins: ${r.wins} | BE: ${r.beWins} | Losses: ${r.losses} | Fees: -$${r.fees}`);
}
