/**
 * CALIBRADOR MATEMÁTICO DE MULTIPLICADORES ATR PARA FX
 * Encuentra la combinación exacta de multiplicadores para que el ATR trabaje con la microestructura.
 */

import { readFileSync } from "node:fs";
import { calculateATR14 } from "../src/guardrails/volatility-adaptive-sets.js";

const RAW_FILE = "/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json";
const allCandles = JSON.parse(readFileSync(RAW_FILE, "utf-8"));
const monthCandles = allCandles.slice(96, 96 + 720);

const INITIAL_CAPITAL_MXN = 17720.0;
const ORDER_SIZE_USD = 250.0;
const MAKER_FEE = 0.0010;

function testMultipliers(spacingMult: number, tpMult: number, stopMult: number, discountMult: number) {
  let cashMxn = INITIAL_CAPITAL_MXN;
  let inPos = false;
  let usdHoldings = 0;
  let entryPrice = 0;
  let entryHour = 0;
  let stopPrice = 0;
  let tpPrice = 0;

  let wins = 0;
  let losses = 0;
  let feesPaidMxn = 0;
  let isAwaitingLaya = false;
  let gridPrice = monthCandles[0].open * 0.9985;

  for (let h = 15; h < 720; h++) {
    const c = monthCandles[h];
    const midPrice = (c.open + c.close) / 2;
    const ofiScore = (c.close - c.open) / (c.high - c.low + 0.001);
    const toxicFlow = c.close < c.open && c.volume > 150000 ? 0.75 : 0.20;

    const windowCandles = monthCandles.slice(h - 14, h + 1);
    const { atrPct } = calculateATR14(windowCandles);

    // Mínimo físico: El TP nunca puede ser menor a 0.35% (para superar el doble peaje Maker de Bitso)
    const tpPct = Math.max(0.0035, atrPct * tpMult);
    const spacingPct = Math.max(0.0012, atrPct * spacingMult);
    const stopPct = Math.max(0.0065, atrPct * stopMult);
    const discountPct = Math.max(0.0025, atrPct * discountMult);

    if (isAwaitingLaya) {
      if (ofiScore > 0.20 && toxicFlow < 0.35) {
        isAwaitingLaya = false;
        gridPrice = parseFloat((midPrice * (1 - discountPct)).toFixed(3));
      }
    }

    if (!inPos && !isAwaitingLaya && c.low <= gridPrice) {
      inPos = true;
      usdHoldings = ORDER_SIZE_USD;
      entryPrice = gridPrice;
      entryHour = h;
      tpPrice = parseFloat((entryPrice * (1 + tpPct)).toFixed(3));
      stopPrice = parseFloat((entryPrice * (1 - stopPct)).toFixed(3));

      const fee = usdHoldings * entryPrice * MAKER_FEE;
      cashMxn -= (usdHoldings * entryPrice + fee);
      feesPaidMxn += fee;
    } else if (inPos && h > entryHour) {
      if (c.low <= stopPrice || (toxicFlow > 0.70 && midPrice < entryPrice * 0.994)) {
        const exitPrice = Math.min(stopPrice, midPrice * 0.998);
        const fee = usdHoldings * exitPrice * MAKER_FEE;
        const net = usdHoldings * exitPrice - fee;
        cashMxn += net;
        feesPaidMxn += fee;
        losses++;
        inPos = false;
        isAwaitingLaya = true;
      } else if (c.high >= tpPrice) {
        const exitPrice = tpPrice;
        const fee = usdHoldings * exitPrice * MAKER_FEE;
        const net = usdHoldings * exitPrice - fee;
        cashMxn += net;
        feesPaidMxn += fee;
        wins++;
        inPos = false;
        gridPrice = parseFloat((midPrice * (1 - spacingPct)).toFixed(3));
      }
    }
  }

  if (inPos) {
    const p = monthCandles[719].close;
    const fee = usdHoldings * p * MAKER_FEE;
    cashMxn += (usdHoldings * p - fee);
    feesPaidMxn += fee;
  }

  const pnl = cashMxn - INITIAL_CAPITAL_MXN;
  const total = wins + losses;
  return { pnl: parseFloat(pnl.toFixed(2)), wins, losses, winRate: parseFloat(((wins / total) * 100).toFixed(1)), fees: parseFloat(feesPaidMxn.toFixed(2)) };
}

console.log("Optimizando Múltiplos Físicos de ATR:");
const configs = [
  { s: 0.8, tp: 1.8, st: 2.8, d: 1.5 },
  { s: 0.7, tp: 2.0, st: 3.0, d: 1.8 },
  { s: 0.6, tp: 2.2, st: 3.2, d: 2.0 },
  { s: 0.8, tp: 2.2, st: 3.5, d: 2.2 },
];

for (const c of configs) {
  const r = testMultipliers(c.s, c.tp, c.st, c.d);
  console.log(`ATR [Spacing: ${c.s}x | TP: ${c.tp}x | Stop: ${c.st}x | Desc: ${c.d}x] -> PnL: ${r.pnl >= 0 ? "+" : ""}$${r.pnl} MXN | Wins: ${r.wins} | Losses: ${r.losses} | WinRate: ${r.winRate}% | Fees: -$${r.fees}`);
}
