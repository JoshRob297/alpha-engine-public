/**
 * Simulación y Validación DEX: Rango Estático vs Rango Adaptativo Térmico
 * Evalúa 60 días (1,440 horas) en Base L2 (Aerodrome Slipstream)
 * 
 * Evalúa dos pares:
 * 1. WETH-CBBTC (Par altamente correlacionado)
 * 2. AERO-USDC (Par volátil de alto rendimiento)
 */

import { BinanceHistoricalFeeder } from "../cex/binance-history.js";
import { ShadowLPEngine, type PoolState } from "../dex/shadow-lp-simulator.js";
import { MarketTemperatureMonitor } from "../guardrails/market-temperature.js";

async function runDexComparativeSimulation() {
  console.log("======================================================================");
  console.log("   SIMULACIÓN DEX: RANGO ESTÁTICO VS ADAPTATIVO TÉRMICO (60 DÍAS)     ");
  console.log("   Base L2 (Aerodrome Slipstream) // Velas Horarias Reales de Binance  ");
  console.log("======================================================================\n");

  // Descargar histórico para AEROUSDT (par volátil) y WETH/BTC
  console.log("[DESCARGANDO HISTÓRICO] Obteniendo 1,440 horas de AEROUSDT y BTCUSDT...");
  const aeroSeries = await BinanceHistoricalFeeder.fetchHistoricalSeries("AEROUSDT", 1440, 1000);
  const btcSeries = await BinanceHistoricalFeeder.fetchHistoricalSeries("BTCUSDT", 1440, 1000);
  const ethSeries = await BinanceHistoricalFeeder.fetchHistoricalSeries("ETHUSDT", 1440, 1000);

  if (!aeroSeries || !btcSeries || !ethSeries) {
    console.error("No se pudo obtener datos históricos suficientes.");
    return;
  }

  const length = Math.min(aeroSeries.close.length, btcSeries.close.length, ethSeries.close.length);

  // --- PRUEBA 1: AERO-USDC (Alta Volatilidad / Gran Divergencia) ---
  console.log(">>> [POOL 1] AERO-USDC (Aerodrome Slipstream - 106.4% APR) - Capital: $500 USD");
  const aeroCapital = 500;
  const aeroPool: PoolState = {
    symbol: "AERO-USDC",
    chain: "Base",
    protocol: "Aerodrome Slipstream",
    price: aeroSeries.close[0],
    feeAprPct: 106.42,
    volume24hUsd: 5_460_000,
    tvlUsd: 4_030_000,
  };

  const aeroStatic = new ShadowLPEngine({ ...aeroPool }, aeroCapital);
  const aeroAdapt = new ShadowLPEngine({ ...aeroPool }, aeroCapital);

  let aeroStaticOutHours = 0;
  let aeroAdaptOutHours = 0;

  for (let i = 1; i < length; i++) {
    const currentPrice = aeroSeries.close[i];
    const prevPrice = aeroSeries.close[i - 1];
    const pctChange = ((currentPrice - prevPrice) / prevPrice) * 100;

    const priceWindow = Array.from(aeroSeries.close.slice(Math.max(0, i - 15), i + 1));
    const temp = MarketTemperatureMonitor.getTemperature("AERO", priceWindow, 0.015);

    const layaNeutral = { toxicFlow: 0.15, regimeStress: 0.10, meanReversion: 0.85, ok: true, failure: null };

    // Step Estático (Paso horario: 3600 segundos)
    const sRes = await aeroStatic.step(currentPrice, pctChange, layaNeutral, "BALANCED_RANGE", 0.40, 1.0, 3600);
    if (sRes.position.status.includes("OUT_OF_RANGE")) aeroStaticOutHours++;

    // Step Adaptativo Térmico (Paso horario: 3600 segundos)
    const aRes = await aeroAdapt.step(currentPrice, pctChange, layaNeutral, "BALANCED_RANGE", 0.40, temp.spacingMultiplier, 3600);
    if (aRes.position.status.includes("OUT_OF_RANGE")) aeroAdaptOutHours++;
  }

  const aeroStaticSnap = aeroStatic.getSnapshot();
  const aeroAdaptSnap = aeroAdapt.getSnapshot();

  const aeroStaticNet = aeroStaticSnap.accumulatedFeesUsd - aeroStaticSnap.impermanentLossUsd - aeroStaticSnap.gasSpentUsd;
  const aeroAdaptNet = aeroAdaptSnap.accumulatedFeesUsd - aeroAdaptSnap.impermanentLossUsd - aeroAdaptSnap.gasSpentUsd;

  console.log(`    ESTÁTICO:   Horas Fuera de Rango: ${aeroStaticOutHours}h | Rebalanceos: ${aeroStaticSnap.totalRebalances} | Fees: +$${aeroStaticSnap.accumulatedFeesUsd.toFixed(2)} | IL: -$${aeroStaticSnap.impermanentLossUsd.toFixed(2)} | Net: ${aeroStaticNet >= 0 ? "+" : ""}$${aeroStaticNet.toFixed(2)} USD (${((aeroStaticNet / aeroCapital) * 100).toFixed(2)}%)`);
  console.log(`    ADAPTATIVO: Horas Fuera de Rango: ${aeroAdaptOutHours}h | Rebalanceos: ${aeroAdaptSnap.totalRebalances} | Fees: +$${aeroAdaptSnap.accumulatedFeesUsd.toFixed(2)} | IL: -$${aeroAdaptSnap.impermanentLossUsd.toFixed(2)} | Net: ${aeroAdaptNet >= 0 ? "+" : ""}$${aeroAdaptNet.toFixed(2)} USD (${((aeroAdaptNet / aeroCapital) * 100).toFixed(2)}%)`);
  console.log(`    -> IMPACTO EN AERO-USDC: +$${(aeroAdaptNet - aeroStaticNet).toFixed(2)} USD de ganancia extra | Reducción de tiempo fuera de rango: ${aeroStaticOutHours - aeroAdaptOutHours} horas recuperadas.`);

  // --- PRUEBA 2: WETH-CBBTC (Baja Volatilidad / Par Correlacionado) ---
  console.log("\n>>> [POOL 2] WETH-CBBTC (Aerodrome Slipstream - 68.9% APR) - Capital: $500 USD");
  const ratioSeries: number[] = [];
  for (let i = 0; i < length; i++) {
    ratioSeries.push(ethSeries.close[i] / btcSeries.close[i]);
  }

  const btcCapital = 500;
  const btcPool: PoolState = {
    symbol: "WETH-CBBTC",
    chain: "Base",
    protocol: "Aerodrome Slipstream",
    price: ratioSeries[0],
    feeAprPct: 68.92,
    volume24hUsd: 38_000_000,
    tvlUsd: 1_730_000,
  };

  const btcStatic = new ShadowLPEngine({ ...btcPool }, btcCapital);
  const btcAdapt = new ShadowLPEngine({ ...btcPool }, btcCapital);

  let btcStaticOutHours = 0;
  let btcAdaptOutHours = 0;

  for (let i = 1; i < length; i++) {
    const currentPrice = ratioSeries[i];
    const prevPrice = ratioSeries[i - 1];
    const pctChange = ((currentPrice - prevPrice) / prevPrice) * 100;

    const priceWindow = ratioSeries.slice(Math.max(0, i - 15), i + 1);
    const temp = MarketTemperatureMonitor.getTemperature("WETH-CBBTC", priceWindow, 0.006);

    const layaNeutral = { toxicFlow: 0.15, regimeStress: 0.10, meanReversion: 0.85, ok: true, failure: null };

    const sRes = await btcStatic.step(currentPrice, pctChange, layaNeutral, "BALANCED_RANGE", 0.70, 1.0, 3600);
    if (sRes.position.status.includes("OUT_OF_RANGE")) btcStaticOutHours++;

    const aRes = await btcAdapt.step(currentPrice, pctChange, layaNeutral, "BALANCED_RANGE", 0.70, temp.spacingMultiplier, 3600);
    if (aRes.position.status.includes("OUT_OF_RANGE")) btcAdaptOutHours++;
  }

  const btcStaticSnap = btcStatic.getSnapshot();
  const btcAdaptSnap = btcAdapt.getSnapshot();

  const btcStaticNet = btcStaticSnap.accumulatedFeesUsd - btcStaticSnap.impermanentLossUsd - btcStaticSnap.gasSpentUsd;
  const btcAdaptNet = btcAdaptSnap.accumulatedFeesUsd - btcAdaptSnap.impermanentLossUsd - btcAdaptSnap.gasSpentUsd;

  console.log(`    ESTÁTICO:   Horas Fuera de Rango: ${btcStaticOutHours}h | Rebalanceos: ${btcStaticSnap.totalRebalances} | Fees: +$${btcStaticSnap.accumulatedFeesUsd.toFixed(2)} | IL: -$${btcStaticSnap.impermanentLossUsd.toFixed(2)} | Net: ${btcStaticNet >= 0 ? "+" : ""}$${btcStaticNet.toFixed(2)} USD (${((btcStaticNet / btcCapital) * 100).toFixed(2)}%)`);
  console.log(`    ADAPTATIVO: Horas Fuera de Rango: ${btcAdaptOutHours}h | Rebalanceos: ${btcAdaptSnap.totalRebalances} | Fees: +$${btcAdaptSnap.accumulatedFeesUsd.toFixed(2)} | IL: -$${btcAdaptSnap.impermanentLossUsd.toFixed(2)} | Net: ${btcAdaptNet >= 0 ? "+" : ""}$${btcAdaptNet.toFixed(2)} USD (${((btcAdaptNet / btcCapital) * 100).toFixed(2)}%)`);
  console.log(`    -> IMPACTO EN WETH-CBBTC: ${btcAdaptNet >= btcStaticNet ? "+" : ""}$${(btcAdaptNet - btcStaticNet).toFixed(2)} USD de impacto neto.`);

  console.log("\n======================================================================");
  console.log("                      BALANCE CONSOLIDADO DEX                         ");
  console.log("======================================================================\n");
  const totalStaticDEX = aeroStaticNet + btcStaticNet;
  const totalAdaptDEX = aeroAdaptNet + btcAdaptNet;
  console.log(`- MODO ESTÁTICO TOTAL ($1,000 USD):   +$${totalStaticDEX.toFixed(2)} USD (${((totalStaticDEX / 1000) * 100).toFixed(2)}%)`);
  console.log(`- MODO ADAPTATIVO TOTAL ($1,000 USD): +$${totalAdaptDEX.toFixed(2)} USD (${((totalAdaptDEX / 1000) * 100).toFixed(2)}%)`);
  console.log(`----------------------------------------------------------------------`);
  console.log(`GANANCIA EXTRA EN DEX CON RANGOS TÉRMICOS: +$${(totalAdaptDEX - totalStaticDEX).toFixed(2)} USD (+${(((totalAdaptDEX - totalStaticDEX) / 1000) * 100).toFixed(2)}% adicional sobre $1,000)`);
  console.log("======================================================================\n");
}

runDexComparativeSimulation().catch(console.error);
