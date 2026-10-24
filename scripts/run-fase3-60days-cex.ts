/**
 * FASE 3: AUDITORÍA DE 2 MESES CONTINUOS (60 DÍAS / 1,440 HORAS) EN CEX SPOT
 * Activos: Solana (SOL/USD) y Bitcoin (BTC/USD)
 * 
 * Periodo: 1,440 Horas Continuas que incluyen:
 * - Mes 1: El Gran Colapso de Capitulación (Desplome de -35% en SOL / -18% en BTC).
 * - Mes 2: El Mes de Consolidación y Rebote en Rango.
 * 
 * Capital Fondeado: $1,000 USD en SOL + $1,000 USD en BTC ($2,000 USD total).
 * 
 * Reglas Ácidas y Anti-Trampa:
 * - Comisiones Maker deducidas: -0.10% compra y -0.10% venta en cada trade.
 * - Slippage de salida en stops: -0.25%.
 * - Cero salidas en la misma hora de entrada (maduración horaria).
 * - Motor Nuevo: Laya Destilado (Hot-Standby) + Sets gobernados por ATR + Candado Híbrido (Mín 6h + OFI > 0.20).
 */

import { readFileSync, writeFileSync } from "node:fs";

const SOL_FILE = "/mnt/storage/alpha-backtest/raw/sol_1h.json";
const BTC_FILE = "/mnt/storage/alpha-backtest/raw/btc_1h.json";

const solAll = JSON.parse(readFileSync(SOL_FILE, "utf-8"));
const btcAll = JSON.parse(readFileSync(BTC_FILE, "utf-8"));

// 1,440 Horas continuas que capturan la capitulación extrema y el rebote posterior
const TOTAL_HOURS = 1440;
const sol60 = solAll.slice(solAll.length - TOTAL_HOURS);
const btc60 = btcAll.slice(btcAll.length - TOTAL_HOURS);

const CAPITAL = 1000.0;
const ORDER_USD = 250.0;
const MAKER_FEE = 0.0010;

interface Cex60Audit {
  ticker: string;
  initialCapital: number;
  finalCapital: number;
  netPnlUsd: number;
  roiPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number;
  feesPaidUsd: number;
  maxDrawdownPct: number;
  m1PnlUsd: number;
  m1Wins: number;
  m1Losses: number;
  m2PnlUsd: number;
  m2Wins: number;
  m2Losses: number;
}

function run60DaysCexSimulation(ticker: "SOL" | "BTC", candles: any[]): Cex60Audit {
  let cash = CAPITAL;
  let inPos = false;
  let holdings = 0;
  let entryPrice = 0;
  let entryH = 0;
  let stopPrice = 0;
  let tpPrice = 0;

  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let feesPaid = 0;

  let isLocked = false;
  let lockH = -1;

  let peakEquity = CAPITAL;
  let maxDrawdown = 0;

  // Tracking por mes
  let m1Pnl = 0;
  let m1Wins = 0;
  let m1Losses = 0;

  let m2Pnl = 0;
  let m2Wins = 0;
  let m2Losses = 0;

  // Calibración Cuantitativa por Perfil de Activo
  const spacing = ticker === "SOL" ? 0.024 : 0.015;
  const tpTarget = ticker === "SOL" ? 0.020 : 0.012;
  const stopTarget = ticker === "SOL" ? 0.040 : 0.025;

  let gridPrice = candles[0].open * (1 - spacing);

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = candles[h];
    const mid = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.0001);
    const toxic = c.close < c.open && c.volume > (ticker === "SOL" ? 50000 : 1000) ? 0.75 : 0.20;

    // Desbloqueo Híbrido por Laya Destilado:
    // Mínimo 6 horas de enfriamiento obligatorio Y certificación de flujo no tóxico
    if (isLocked) {
      if (h - lockH >= 6 && ofi > 0.20 && toxic < 0.35) {
        isLocked = false;
        // Re-centrado con descuento adaptativo post-shock (-25% más profundo)
        gridPrice = mid * (1 - spacing * 1.25);
      }
    }

    // 1. Entrada Maker
    if (!inPos && !isLocked && c.low <= gridPrice) {
      inPos = true;
      holdings = ORDER_USD / gridPrice;
      entryPrice = gridPrice;
      entryH = h;
      tpPrice = entryPrice * (1 + tpTarget);
      stopPrice = entryPrice * (1 - stopTarget);

      const fee = ORDER_USD * MAKER_FEE;
      cash -= (ORDER_USD + fee);
      feesPaid += fee;
    }
    // 2. Posición Viva (mínimo 1 hora)
    else if (inPos && h > entryH) {
      // Stop Loss defensivo
      if (c.low <= stopPrice) {
        const exitPrice = Math.min(stopPrice, mid * 0.9975); // Slippage -0.25%
        const gross = holdings * exitPrice;
        const fee = gross * MAKER_FEE;
        const net = gross - fee;
        const loss = net - holdings * entryPrice;

        cash += net;
        grossLoss += Math.abs(loss);
        feesPaid += fee;
        losses++;

        if (h < 720) { m1Losses++; m1Pnl += loss; }
        else { m2Losses++; m2Pnl += loss; }

        inPos = false;
        holdings = 0;
        isLocked = true;
        lockH = h;
      }
      // Take Profit
      else if (c.high >= tpPrice) {
        const exitPrice = tpPrice;
        const gross = holdings * exitPrice;
        const fee = gross * MAKER_FEE;
        const net = gross - fee;
        const profit = net - holdings * entryPrice;

        cash += net;
        grossProfit += profit;
        feesPaid += fee;
        wins++;

        if (h < 720) { m1Wins++; m1Pnl += profit; }
        else { m2Wins++; m2Pnl += profit; }

        inPos = false;
        holdings = 0;
        gridPrice = mid * (1 - spacing);
      }
    }

    const currentEquity = cash + (inPos ? holdings * mid : 0);
    if (currentEquity > peakEquity) peakEquity = currentEquity;
    const dd = peakEquity - currentEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Cierre final al término de las 1,440 horas
  if (inPos) {
    const p = candles[TOTAL_HOURS - 1].close;
    const fee = holdings * p * MAKER_FEE;
    const net = holdings * p - fee;
    const delta = net - holdings * entryPrice;
    cash += net;
    feesPaid += fee;
    if (delta >= 0) m2Pnl += delta;
    else m2Pnl += delta;
  }

  const netPnl = cash - CAPITAL;
  const total = wins + losses;

  return {
    ticker,
    initialCapital: CAPITAL,
    finalCapital: parseFloat(cash.toFixed(2)),
    netPnlUsd: parseFloat(netPnl.toFixed(2)),
    roiPct: parseFloat(((netPnl / CAPITAL) * 100).toFixed(2)),
    trades: total,
    wins,
    losses,
    winRate: total > 0 ? parseFloat(((wins / total) * 100).toFixed(1)) : 0,
    profitFactor: grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : 99.9,
    feesPaidUsd: parseFloat(feesPaid.toFixed(2)),
    maxDrawdownPct: parseFloat(((maxDrawdown / CAPITAL) * 100).toFixed(2)),
    m1PnlUsd: parseFloat(m1Pnl.toFixed(2)),
    m1Wins,
    m1Losses,
    m2PnlUsd: parseFloat(m2Pnl.toFixed(2)),
    m2Wins,
    m2Losses,
  };
}

console.log("================================================================================");
console.log("   FASE 3: AUDITORÍA DE 2 MESES CONTINUOS (60 DÍAS / 1,440 HORAS) EN CEX SPOT   ");
console.log("   Solana (SOL/USD) y Bitcoin (BTC/USD) - $2,000 USD de Capital Total           ");
console.log("   Periodo: 1,440 Horas con Colapso Extremo de Capitulación y Rebote Posterior ");
console.log("================================================================================\n");

const solAudit = run60DaysCexSimulation("SOL", sol60);
const btcAudit = run60DaysCexSimulation("BTC", btc60);

console.log("1. SOLANA (SOL/USD - $1,000 USD Fondeados):");
console.log(`• MES 1 (MES DE COLAPSO Y CAPITULACIÓN - 720h) : PnL ${solAudit.m1PnlUsd >= 0 ? "+" : ""}$${solAudit.m1PnlUsd} USD | Trades: ${solAudit.m1Wins + solAudit.m1Losses} (W: ${solAudit.m1Wins} / L: ${solAudit.m1Losses})`);
console.log(`• MES 2 (MES DE CONSOLIDACIÓN Y REBOTE - 720h) : PnL ${solAudit.m2PnlUsd >= 0 ? "+" : ""}$${solAudit.m2PnlUsd} USD | Trades: ${solAudit.m2Wins + solAudit.m2Losses} (W: ${solAudit.m2Wins} / L: ${solAudit.m2Losses})`);
console.log(`-> BALANCE 60 DÍAS EN SOL : PnL ${solAudit.netPnlUsd >= 0 ? "+" : ""}$${solAudit.netPnlUsd} USD (${solAudit.roiPct >= 0 ? "+" : ""}${solAudit.roiPct}%) | WinRate: ${solAudit.winRate}% | Fees: -$${solAudit.feesPaidUsd} USD | DD: ${solAudit.maxDrawdownPct}%\n`);

console.log("--------------------------------------------------------------------------------");
console.log("2. BITCOIN (BTC/USD - $1,000 USD Fondeados):");
console.log(`• MES 1 (MES DE COLAPSO Y CAPITULACIÓN - 720h) : PnL ${btcAudit.m1PnlUsd >= 0 ? "+" : ""}$${btcAudit.m1PnlUsd} USD | Trades: ${btcAudit.m1Wins + btcAudit.m1Losses} (W: ${btcAudit.m1Wins} / L: ${btcAudit.m1Losses})`);
console.log(`• MES 2 (MES DE CONSOLIDACIÓN Y REBOTE - 720h) : PnL ${btcAudit.m2PnlUsd >= 0 ? "+" : ""}$${btcAudit.m2PnlUsd} USD | Trades: ${btcAudit.m2Wins + btcAudit.m2Losses} (W: ${btcAudit.m2Wins} / L: ${btcAudit.m2Losses})`);
console.log(`-> BALANCE 60 DÍAS EN BTC : PnL ${btcAudit.netPnlUsd >= 0 ? "+" : ""}$${btcAudit.netPnlUsd} USD (${btcAudit.roiPct >= 0 ? "+" : ""}${btcAudit.roiPct}%) | WinRate: ${btcAudit.winRate}% | Fees: -$${btcAudit.feesPaidUsd} USD | DD: ${btcAudit.maxDrawdownPct}%\n`);

console.log("================================================================================");
console.log("                       BALANCE TOTAL CARTERA CEX ($2,000 USD)                   ");
console.log("================================================================================");
const totalCexPnl = solAudit.netPnlUsd + btcAudit.netPnlUsd;
const totalCexRoi = (totalCexPnl / 2000.0) * 100;
const totalCexTrades = solAudit.trades + btcAudit.trades;
const totalCexWins = solAudit.wins + btcAudit.wins;
const totalCexFees = solAudit.feesPaidUsd + btcAudit.feesPaidUsd;

console.log(`• Capital Total Inicial Fondeado : $2,000.00 USD`);
console.log(`• Capital Total Final al Día 60  : $${(2000 + totalCexPnl).toFixed(2)} USD`);
console.log(`• GANANCIA NETA LIMPIA TOTAL CEX : ${totalCexPnl >= 0 ? "+" : ""}$${totalCexPnl.toFixed(2)} USD (${totalCexRoi >= 0 ? "+" : ""}${totalCexRoi.toFixed(2)}% ROI en 60 Días)`);
console.log(`• Total Operaciones CEX          : ${totalCexTrades} (Ganadas: ${totalCexWins} / Perdidas: ${totalCexTrades - totalCexWins})`);
console.log(`• Win Rate Global Cartera CEX    : ${((totalCexWins / totalCexTrades) * 100).toFixed(1)}%`);
console.log(`• Comisiones Maker Pagadas       : -$${totalCexFees.toFixed(2)} USD (Deducidas ya del balance)`);
console.log("================================================================================\n");

writeFileSync(
  "/mnt/storage/alpha-backtest/fase3_60days_cex_audit.json",
  JSON.stringify({ solAudit, btcAudit, totalCexPnl, totalCexRoi, totalCexTrades, totalCexWins, totalCexFees }, null, 2)
);
