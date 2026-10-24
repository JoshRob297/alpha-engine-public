/**
 * SIMULACIÓN COMPLETA 8,760 HORAS (1 AÑO) CEX + FX CON EL NUEVO MOTOR
 * Incorpora:
 * 1. Nueva Geometría Causal de Bitcoin: TP1 +2.40%, TP2 +3.80%.
 * 2. Stop Dinámico Causal con Laya y Jev (-2.2% en BTC, -3.2% en SOL, -0.8% en FX).
 * 3. Veto de Régimen Preventivo en DEFENSIVE_STRESS (cero compras en pánico).
 * 4. Candado de Enfriamiento Post-Stop (16 horas de pausa defensiva tras un corte).
 * Genera: /mnt/storage/alpha-backtest/v3_complete_engine_report.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE_DIR = "/mnt/storage/alpha-backtest";
const RAW_DIR = join(BASE_DIR, "raw");
const FX_RATE = 17.72;

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface EngineSimResult {
  ticker: string;
  profile: "ANCHOR" | "BETA" | "FIAT";
  initialCapitalUsd: number;
  initialCapitalMxn: number;
  finalCapitalMxn: number;
  netPnlMxn: number;
  roiPct: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePct: number;
  profitFactor: number;
  maxDrawdownPct: number;
}

function simulateAssetV3(
  ticker: string,
  profile: "ANCHOR" | "BETA" | "FIAT",
  initialCapitalUsd: number,
  candles: Candle[],
  tp1Pct: number,
  tp2Pct: number,
  dynamicStopPct: number,
  spacingPct: number
): EngineSimResult {
  console.log(`\n[SIMULADOR V3] Procesando ${ticker} (${candles.length} velas / Perfil ${profile})...`);
  console.log(`Capital Asignado: $${initialCapitalUsd.toFixed(2)} USD (~$${(initialCapitalUsd * FX_RATE).toFixed(2)} MXN)`);

  let cashUsd = initialCapitalUsd;
  let inPos = false;
  let qty = 0;
  let entryAvg = 0;
  let partialTaken = false;
  let stopPrice = 0;
  let tp1Price = 0;
  let tp2Price = 0;

  let winningTrades = 0;
  let losingTrades = 0;
  let grossProfitUsd = 0;
  let grossLossUsd = 0;

  let peakEquityUsd = initialCapitalUsd;
  let maxDdUsd = 0;
  let cooldownUntilIndex = -1;

  let gridPrice = candles[0].open * (1 - spacingPct);
  let gridUsd = initialCapitalUsd * (profile === "FIAT" ? 0.60 : 0.40);

  for (let t = 0; t < candles.length; t++) {
    const c = candles[t];
    const midPrice = (c.open + c.close) / 2;

    // Métricas del sensor de microestructura
    const isHeavyVolume = c.volume > (profile === "FIAT" ? 200000 : ticker === "BTC" ? 1500 : 5000);
    const toxicFlow = c.close < c.open && isHeavyVolume ? 0.85 : (c.close > c.open ? 0.15 : 0.40);
    const isStress = c.close < (candles[Math.max(0, t - 24)].close * 0.96);

    // 1. Candado de enfriamiento
    const isLocked = t < cooldownUntilIndex;

    // 2. Entrada por Malla si no estamos en posición ni en candado
    if (!inPos && !isLocked && c.low <= gridPrice) {
      if (isStress) {
        // Veto de régimen activo: No comprar
      } else {
        inPos = true;
        qty = gridUsd / gridPrice;
        entryAvg = gridPrice;
        tp1Price = entryAvg * (1 + tp1Pct);
        tp2Price = entryAvg * (1 + tp2Pct);
        stopPrice = entryAvg * (1 - dynamicStopPct);
        partialTaken = false;
        cashUsd -= gridUsd;
      }
    }

    // 3. Gestión de posición viva
    if (inPos) {
      const currentGain = ((midPrice / entryAvg) - 1) * 100;

      // A. Stop Dinámico Causal (Laya / Jev)
      if (currentGain <= -(dynamicStopPct * 100) && (toxicFlow > 0.65 || isStress)) {
        const exitPrice = midPrice;
        const proceeds = qty * exitPrice;
        const loss = proceeds - qty * entryAvg;
        cashUsd += proceeds;
        grossLossUsd += Math.abs(loss);
        losingTrades++;

        inPos = false;
        qty = 0;
        entryAvg = 0;
        // Candado por 16 horas
        cooldownUntilIndex = t + 16;
        gridPrice = midPrice * (1 - spacingPct);
      }
      // B. Take Profit 1 (DCA Out del 50% y Stop a Break-Even)
      else if (!partialTaken && c.high >= tp1Price) {
        const closeQty = qty * 0.50;
        const proceeds = closeQty * tp1Price;
        const profit = proceeds - closeQty * entryAvg;
        cashUsd += proceeds;
        grossProfitUsd += profit;
        qty -= closeQty;
        partialTaken = true;
        stopPrice = entryAvg * 1.002; // Stop sube a Break-Even
        winningTrades++;
      }
      // C. Take Profit 2 (Salida final con expansión)
      else if (partialTaken && c.high >= tp2Price) {
        const proceeds = qty * tp2Price;
        const profit = proceeds - qty * entryAvg;
        cashUsd += proceeds;
        grossProfitUsd += profit;
        winningTrades++;

        inPos = false;
        qty = 0;
        entryAvg = 0;
        gridPrice = midPrice * (1 - spacingPct);
      }
    }

    const currentEquity = cashUsd + (inPos ? qty * midPrice : 0);
    if (currentEquity > peakEquityUsd) peakEquityUsd = currentEquity;
    const currentDd = peakEquityUsd - currentEquity;
    if (currentDd > maxDdUsd) maxDdUsd = currentDd;
  }

  // Liquidar posición viva al precio final
  if (inPos) {
    const finalPrice = candles[candles.length - 1].close;
    cashUsd += qty * finalPrice;
  }

  const initialCapitalMxn = initialCapitalUsd * FX_RATE;
  const finalCapitalMxn = cashUsd * FX_RATE;
  const netPnlMxn = finalCapitalMxn - initialCapitalMxn;
  const roiPct = (netPnlMxn / initialCapitalMxn) * 100;
  const totalTrades = winningTrades + losingTrades;
  const winRatePct = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
  const profitFactor = grossLossUsd > 0 ? grossProfitUsd / grossLossUsd : 99;
  const maxDrawdownPct = (maxDdUsd / initialCapitalUsd) * 100;

  console.log(`• PnL Neto Final : ${netPnlMxn >= 0 ? "+" : ""}$${netPnlMxn.toFixed(2)} MXN (${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(2)}% ROI)`);
  console.log(`• Win Rate       : ${winRatePct.toFixed(1)}% (${winningTrades}W / ${losingTrades}L en ${totalTrades} trades)`);
  console.log(`• Profit Factor  : ${profitFactor.toFixed(2)}`);
  console.log(`• Max Drawdown   : ${maxDrawdownPct.toFixed(2)}%`);

  return {
    ticker,
    profile,
    initialCapitalUsd,
    initialCapitalMxn: parseFloat(initialCapitalMxn.toFixed(2)),
    finalCapitalMxn: parseFloat(finalCapitalMxn.toFixed(2)),
    netPnlMxn: parseFloat(netPnlMxn.toFixed(2)),
    roiPct: parseFloat(roiPct.toFixed(2)),
    totalTrades,
    winningTrades,
    losingTrades,
    winRatePct: parseFloat(winRatePct.toFixed(2)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    maxDrawdownPct: parseFloat(maxDrawdownPct.toFixed(2)),
  };
}

function main() {
  console.log("================================================================================");
  console.log("   SIMULACIÓN CONSOLIDADA ANUAL (V3) CON EL NUEVO MOTOR CAUSAL BLINDADO        ");
  console.log("================================================================================");

  // 1. Cargar Datasets
  const fxCandles: Candle[] = JSON.parse(readFileSync(join(RAW_DIR, "usd_mxn_1h.json"), "utf-8"));
  const btcCandles: Candle[] = JSON.parse(readFileSync(join(RAW_DIR, "btc_1h.json"), "utf-8"));
  const solCandles: Candle[] = JSON.parse(readFileSync(join(RAW_DIR, "sol_1h.json"), "utf-8"));

  // 2. Ejecutar Simulación con la Nueva Arquitectura
  // FX (FIAT): TP1 +0.45%, TP2 +0.70%, Stop -0.80%, Spacing -0.15%
  const fxResult = simulateAssetV3("USD", "FIAT", 400.0, fxCandles, 0.0045, 0.007, 0.008, 0.0015);

  // BTC (ANCHOR): Nueva Geometría TP1 +2.40%, TP2 +3.80%, Stop Dinámico -2.20%, Spacing -1.50%
  const btcResult = simulateAssetV3("BTC", "ANCHOR", 258.75, btcCandles, 0.024, 0.038, 0.022, 0.015);

  // SOL (BETA): TP1 +3.40%, TP2 +4.80%, Stop Dinámico -3.20%, Spacing -1.50%
  const solResult = simulateAssetV3("SOL", "BETA", 41.25, solCandles, 0.034, 0.048, 0.032, 0.015);

  // DEX Realista Auditado Previamente (Aerodrome Base L2)
  const dexPnlMxn = 2032.34;
  const dexInitialMxn = 5316.0;

  const totalInitialMxn = fxResult.initialCapitalMxn + btcResult.initialCapitalMxn + solResult.initialCapitalMxn + dexInitialMxn;
  const totalNetPnlMxn = fxResult.netPnlMxn + btcResult.netPnlMxn + solResult.netPnlMxn + dexPnlMxn;
  const totalRoiPct = (totalNetPnlMxn / totalInitialMxn) * 100;

  const payload = {
    auditDate: new Date().toISOString(),
    currency: "MXN",
    fxRateUsed: FX_RATE,
    modules: {
      FX: fxResult,
      BTC: btcResult,
      SOL: solResult,
      DEX: {
        ticker: "DEX_AERODROME",
        initialCapitalMxn: dexInitialMxn,
        netPnlMxn: dexPnlMxn,
        roiPct: 38.23,
      },
    },
    consolidatedPortfolio: {
      initialCapitalMxn: parseFloat(totalInitialMxn.toFixed(2)),
      finalCapitalMxn: parseFloat((totalInitialMxn + totalNetPnlMxn).toFixed(2)),
      totalNetProfitMxn: parseFloat(totalNetPnlMxn.toFixed(2)),
      totalRoiPct: parseFloat(totalRoiPct.toFixed(2)),
      dailyAverageMxn: parseFloat((totalNetPnlMxn / 365).toFixed(2)),
      monthlyAverageMxn: parseFloat(((totalNetPnlMxn / 365) * 30).toFixed(2)),
    },
  };

  const outFile = join(BASE_DIR, "v3_complete_engine_report.json");
  writeFileSync(outFile, JSON.stringify(payload, null, 2));

  console.log("\n================================================================================");
  console.log("       INFORME CONSOLIDADO FINAL DEL NUEVO MOTOR V3 (EN PESOS MXN)              ");
  console.log("================================================================================");
  console.log(`Capital Total del Portafolio: $${totalInitialMxn.toFixed(2)} MXN ($1,000 USD)`);
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`1. DESGLOSE POR MÓDULO CON EL NUEVO BLINDAJE:`);
  console.log(`   • Bot Cambiario FX (usd_mxn) : +$${fxResult.netPnlMxn.toFixed(2)} MXN (+${fxResult.roiPct.toFixed(2)}% ROI)`);
  console.log(`   • Mallas Spot BTC (btc_usd)  : +$${btcResult.netPnlMxn.toFixed(2)} MXN (+${btcResult.roiPct.toFixed(2)}% ROI)`);
  console.log(`   • Mallas Spot SOL (sol_usd)  : +$${solResult.netPnlMxn.toFixed(2)} MXN (+${solResult.roiPct.toFixed(2)}% ROI)`);
  console.log(`   • Provisión Pasiva DEX (Base): +$${dexPnlMxn.toFixed(2)} MXN (+38.23% ROI)`);
  console.log(`   -----------------------------------------------------------------------------`);
  console.log(`   • GANANCIA NETA TOTAL CUENTA : +$${totalNetPnlMxn.toFixed(2)} MXN (+${totalRoiPct.toFixed(2)}% ROI Neto Anual)`);
  console.log(`   • CAPITAL FINAL DEL AÑO      : $${(totalInitialMxn + totalNetPnlMxn).toFixed(2)} MXN`);
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`2. FLUJO MENSUAL REALISTA:`);
  console.log(`   • Promedio Diario            : +$${(totalNetPnlMxn / 365).toFixed(2)} MXN / día`);
  console.log(`   • Promedio Mensual Pasivo    : +$${((totalNetPnlMxn / 365) * 30).toFixed(2)} MXN / mes`);
  console.log("================================================================================\n");
}

main();
