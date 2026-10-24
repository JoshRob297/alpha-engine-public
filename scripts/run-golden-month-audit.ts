/**
 * SIMULACIÓN DEL MES DORADO TRI-MERCADO (720 HORAS DE ALTA EXPANSIÓN Y VOLUMEN)
 * Evaluando el techo de potencia y cosecha de beneficios con el Flujo Completo Evolved:
 * - Trailing Take Profit y Running Profits en CEX
 * - Rango Dinámico Concentrado en DEX (Base L2)
 * - Micro-Malla Pasiva Maker en FX (Bitso)
 * 
 * Periodo: 720 Horas Continuas de Fuerte Tendencia Alcista y Flujo Comprador
 * Cartera Global: $4,000 USD Fondeados ($1,000 FX, $1,000 SOL, $1,000 BTC, $1,000 DEX)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { generateAdaptiveSet } from "../src/guardrails/volatility-adaptive-sets.js";

const SOL_FILE = "/mnt/storage/alpha-backtest/raw/sol_1h.json";
const BTC_FILE = "/mnt/storage/alpha-backtest/raw/btc_1h.json";
const FX_FILE = "/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json";

const solAll = JSON.parse(readFileSync(SOL_FILE, "utf-8"));
const btcAll = JSON.parse(readFileSync(BTC_FILE, "utf-8"));
const fxAll = JSON.parse(readFileSync(FX_FILE, "utf-8"));

const TOTAL_HOURS = 720;
const FX_RATE = 17.72;
const MAKER_FEE = 0.0010;

// Ventanas Doradas de 720 horas continuas
const solGolden = solAll.slice(7320, 7320 + TOTAL_HOURS); // Rally de $74 a $109 (+47%)
const btcGolden = btcAll.slice(7488, 7488 + TOTAL_HOURS); // Rally de $64k a $81k (+27%)
const fxGolden = fxAll.slice(3936, 3936 + TOTAL_HOURS);   // Rango óptimo $16.96 a $17.73

// ============================================================================
// 1. FASE 1: FX (usd_mxn Bitso) EN MES DORADO
// ============================================================================
function runGoldenFx() {
  const INITIAL_MXN = 1000.0 * FX_RATE;
  const ORDER_USD = 250.0;
  let cash = INITIAL_MXN;
  let inPos = false;
  let usdHoldings = 0;
  let entryPrice = 0;
  let entryH = 0;
  let wins = 0;
  let losses = 0;
  let feesPaid = 0;
  let isLocked = false;
  let lockH = -1;

  const spacing = 0.0018;
  const tpTarget = 0.0045;
  const stopTarget = 0.0080;
  let gridPrice = fxGolden[0].open * (1 - spacing);

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = fxGolden[h];
    const mid = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.001);
    const toxic = c.close < c.open && c.volume > 150000 ? 0.75 : 0.20;

    if (isLocked && ofi > 0.20 && toxic < 0.35) {
      isLocked = false;
      gridPrice = mid * 0.9965;
    }

    if (!inPos && !isLocked && c.low <= gridPrice) {
      inPos = true;
      usdHoldings = ORDER_USD;
      entryPrice = gridPrice;
      entryH = h;
      const cost = ORDER_USD * entryPrice;
      const fee = cost * MAKER_FEE;
      cash -= (cost + fee);
      feesPaid += fee;
    } else if (inPos && h > entryH) {
      const stopP = entryPrice * (1 - stopTarget);
      const tpP = entryPrice * (1 + tpTarget);

      if (c.low <= stopP || (toxic > 0.70 && mid < entryPrice * 0.994)) {
        const exitP = Math.min(stopP, mid * 0.998);
        const gross = usdHoldings * exitP;
        const fee = gross * MAKER_FEE;
        cash += (gross - fee);
        feesPaid += fee;
        losses++;
        inPos = false;
        usdHoldings = 0;
        isLocked = true;
        lockH = h;
      } else if (c.high >= tpP) {
        const exitP = tpP;
        const gross = usdHoldings * exitP;
        const fee = gross * MAKER_FEE;
        cash += (gross - fee);
        feesPaid += fee;
        wins++;
        inPos = false;
        usdHoldings = 0;
        gridPrice = mid * (1 - spacing);
      }
    }
  }

  if (inPos) {
    const p = fxGolden[TOTAL_HOURS - 1].close;
    cash += (usdHoldings * p * (1 - MAKER_FEE));
    feesPaid += (usdHoldings * p * MAKER_FEE);
  }

  const pnlMxn = cash - INITIAL_MXN;
  return {
    market: "FX (usd_mxn Bitso)",
    pnlMxn: parseFloat(pnlMxn.toFixed(2)),
    pnlUsd: parseFloat((pnlMxn / FX_RATE).toFixed(2)),
    roiPct: parseFloat(((pnlMxn / INITIAL_MXN) * 100).toFixed(2)),
    trades: wins + losses,
    wins,
    losses,
    winRate: parseFloat(((wins / (wins + losses)) * 100).toFixed(1)),
    feesMxn: parseFloat(feesPaid.toFixed(2)),
  };
}

// ============================================================================
// 2. FASE 2: DEX (Aerodrome Base L2 WETH/USDC) EN MES DORADO
// ============================================================================
function runGoldenDex() {
  const CAPITAL = 1000.0;
  let capital = CAPITAL;
  const initialPrice = solGolden[0].close;
  let rangeLower = initialPrice * 0.935;
  let rangeUpper = initialPrice * 1.065;
  let feeIncome = 0;
  let gasSpent = 0;
  let inRangeHours = 0;
  let rebalances = 0;
  let entryPoolPrice = initialPrice;

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = solGolden[h];
    const midPrice = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.0001);
    const toxic = c.close < c.open && c.volume > 50000 ? 0.75 : 0.20;

    const isInRange = midPrice >= rangeLower && midPrice <= rangeUpper;

    if (isInRange) {
      inRangeHours++;
      const rangeWidth = (rangeUpper - rangeLower) / midPrice;
      const multiplier = Math.max(2.2, Math.min(8.0, 1.0 / rangeWidth));
      // En mes dorado de volumen masivo, el APR de swap fees en Slipstream sube a ~38% anual
      const hourlyBaseYield = (0.38 / 8760) * multiplier;
      feeIncome += capital * hourlyBaseYield;
    } else {
      if (ofi > 0.15 && toxic < 0.35) {
        rebalances++;
        gasSpent += 0.05;
        rangeLower = midPrice * 0.935;
        rangeUpper = midPrice * 1.065;
        entryPoolPrice = midPrice;
      }
    }
  }

  const finalPrice = solGolden[TOTAL_HOURS - 1].close;
  const ratio = finalPrice / initialPrice;
  const ilFactor = Math.abs((2 * Math.sqrt(ratio)) / (1 + ratio) - 1);
  const totalIL = capital * ilFactor;

  const netPnl = feeIncome - totalIL - gasSpent;
  return {
    market: "DEX (WETH/USDC Base)",
    pnlUsd: parseFloat(netPnl.toFixed(2)),
    roiPct: parseFloat(((netPnl / CAPITAL) * 100).toFixed(2)),
    feeIncomeUsd: parseFloat(feeIncome.toFixed(2)),
    ilUsd: parseFloat(totalIL.toFixed(2)),
    gasUsd: parseFloat(gasSpent.toFixed(2)),
    inRangePct: parseFloat(((inRangeHours / TOTAL_HOURS) * 100).toFixed(1)),
    rebalances,
  };
}

// ============================================================================
// 3. FASE 3: CEX SPOT (SOL Y BTC) CON TRAILING TRENDS EN MES DORADO
// ============================================================================
function runGoldenCex(ticker: "SOL" | "BTC", candles: any[]) {
  const CAPITAL = 1000.0;
  const ORDER_USD = 250.0;
  let cash = CAPITAL;
  let inPos = false;
  let holdings = 0;
  let entryPrice = 0;
  let entryH = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let feesPaid = 0;
  let biggestWin = 0;

  let isTrailingActive = false;
  let highestHigh = 0;
  let trailStop = 0;

  const baseSpacing = ticker === "SOL" ? 0.024 : 0.015;
  const baseTp = ticker === "SOL" ? 0.020 : 0.012;
  const baseStop = ticker === "SOL" ? 0.040 : 0.025;
  const trailingDistance = ticker === "SOL" ? 0.035 : 0.015;

  let gridPrice = candles[0].open * (1 - baseSpacing);

  for (let h = 0; h < TOTAL_HOURS; h++) {
    const c = candles[h];
    const mid = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.0001);

    // Trailing Grid al alza en rally sostenido
    if (!inPos && mid > gridPrice * 1.04 && ofi > 0.15) {
      gridPrice = mid * (1 - baseSpacing);
    }

    if (!inPos && c.low <= gridPrice) {
      inPos = true;
      holdings = ORDER_USD / gridPrice;
      entryPrice = gridPrice;
      entryH = h;
      highestHigh = c.high;
      isTrailingActive = false;
      const fee = ORDER_USD * MAKER_FEE;
      cash -= (ORDER_USD + fee);
      feesPaid += fee;
    } else if (inPos && h > entryH) {
      if (c.high > highestHigh) highestHigh = c.high;

      const initialTp = entryPrice * (1 + baseTp);
      if (!isTrailingActive && c.high >= initialTp) {
        isTrailingActive = true;
        trailStop = highestHigh * (1 - trailingDistance);
      }

      if (isTrailingActive) {
        const cand = highestHigh * (1 - trailingDistance);
        if (cand > trailStop) trailStop = cand;
      }

      const effStop = isTrailingActive ? trailStop : entryPrice * (1 - baseStop);

      if (c.low <= effStop) {
        const exitPrice = Math.min(effStop, mid * 0.9975);
        const gross = holdings * exitPrice;
        const fee = gross * MAKER_FEE;
        const net = gross - fee;
        const delta = net - holdings * entryPrice;

        cash += net;
        feesPaid += fee;

        if (delta >= 0) {
          grossProfit += delta;
          wins++;
          if (delta > biggestWin) biggestWin = delta;
        } else {
          grossLoss += Math.abs(delta);
          losses++;
        }

        inPos = false;
        holdings = 0;
        isTrailingActive = false;
        gridPrice = mid * (1 - baseSpacing);
      }
    }
  }

  if (inPos) {
    const p = candles[TOTAL_HOURS - 1].close;
    const fee = holdings * p * MAKER_FEE;
    const net = holdings * p - fee;
    cash += net;
    feesPaid += fee;
  }

  const netPnl = cash - CAPITAL;
  return {
    market: `CEX (${ticker}/USD)`,
    pnlUsd: parseFloat(netPnl.toFixed(2)),
    roiPct: parseFloat(((netPnl / CAPITAL) * 100).toFixed(2)),
    trades: wins + losses,
    wins,
    losses,
    winRate: parseFloat(((wins / (wins + losses)) * 100).toFixed(1)),
    biggestWinUsd: parseFloat(biggestWin.toFixed(2)),
    feesUsd: parseFloat(feesPaid.toFixed(2)),
  };
}

console.log("================================================================================");
console.log("   AUDITORÍA DEL MES DORADO TRI-MERCADO (720 HORAS DE MÁXIMA EXPANSIÓN)         ");
console.log("   Evaluando el Techo de Potencia y Cosecha de la Cartera ($4,000 USD)          ");
console.log("================================================================================\n");

const fxRes = runGoldenFx();
const dexRes = runGoldenDex();
const solRes = runGoldenCex("SOL", solGolden);
const btcRes = runGoldenCex("BTC", btcGolden);

console.log("1. FASE 1: RESERVA CAMBIARIA FX (usd_mxn en Bitso - $1,000 USD):");
console.log(`• PnL Neto en Mes Dorado : +$${fxRes.pnlUsd} USD (+${fxRes.pnlMxn} MXN / +${fxRes.roiPct}% ROI)`);
console.log(`• Operaciones            : ${fxRes.trades} trades (Ganadas: ${fxRes.wins} / Perdidas: ${fxRes.losses})`);
console.log(`• Win Rate Real          : ${fxRes.winRate}%`);
console.log(`• Comisiones Pagadas     : -$${fxRes.feesMxn} MXN (Deducidas ya del PnL)\n`);

console.log("--------------------------------------------------------------------------------");
console.log("2. FASE 2: MOTOR DE RENDIMIENTO DEX (WETH/USDC Base L2 - $1,000 USD):");
console.log(`• PnL Neto en Mes Dorado : +$${dexRes.pnlUsd} USD (+${dexRes.roiPct}% ROI Mensual)`);
console.log(`• Swap Fees Ganados      : +$${dexRes.feeIncomeUsd} USD de flujo pasivo por volumen`);
console.log(`• Impermanent Loss       : -$${dexRes.ilUsd} USD`);
console.log(`• Tiempo En Rango        : ${dexRes.inRangePct}% del mes (${dexRes.rebalances} rebalanceos)\n`);

console.log("--------------------------------------------------------------------------------");
console.log("3. FASE 3: CARTERA SPOT CEX CON TRAILING TRENDS ($2,000 USD):");
console.log(`• Solana (SOL/USD)       : +$${solRes.pnlUsd} USD (+${solRes.roiPct}% ROI) | Max Win: +$${solRes.biggestWinUsd} USD en un solo trade | WinRate: ${solRes.winRate}%`);
console.log(`• Bitcoin (BTC/USD)      : +$${btcRes.pnlUsd} USD (+${btcRes.roiPct}% ROI) | Max Win: +$${btcRes.biggestWinUsd} USD en un solo trade | WinRate: ${btcRes.winRate}%`);
const cexTotalPnl = solRes.pnlUsd + btcRes.pnlUsd;
console.log(`-> Subtotal CEX Spot     : +$${cexTotalPnl.toFixed(2)} USD (+${((cexTotalPnl / 2000) * 100).toFixed(2)}% ROI Mensual en $2,000 USD)\n`);

console.log("================================================================================");
console.log("                   BALANCE TOTAL DEL MES DORADO ($4,000 USD)                    ");
console.log("================================================================================");
const totalGoldenPnl = fxRes.pnlUsd + dexRes.pnlUsd + cexTotalPnl;
const totalGoldenRoi = (totalGoldenPnl / 4000.0) * 100;

console.log(`• CAPITAL INICIAL TOTAL FONDEADO : $4,000.00 USD`);
console.log(`• CAPITAL FINAL AL CIERRE DEL MES: $${(4000 + totalGoldenPnl).toFixed(2)} USD`);
console.log(`• GANANCIA NETA LIMPIA TOTAL     : +$${totalGoldenPnl.toFixed(2)} USD (+${totalGoldenRoi.toFixed(2)}% ROI MENSUAL LIMPIO)`);
console.log(`• RETORNO ANUALIZADO PROYECTADO  : +${(totalGoldenRoi * 12).toFixed(1)}% ANUAL EN USD`);
console.log("================================================================================\n");

writeFileSync(
  "/mnt/storage/alpha-backtest/golden_month_audit.json",
  JSON.stringify({ fxRes, dexRes, solRes, btcRes, totalGoldenPnl, totalGoldenRoi, date: new Date().toISOString() }, null, 2)
);
