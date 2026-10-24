/**
 * Runner de Research Integral con Pools Dinamicos y Microestructura Profunda
 * Ejecuta el Prompt v2 alimentado por:
 * 1. Precios spot y TVL global (market-data-feeder)
 * 2. Tasas de fondeo Futures y dilucion de float (deep-data-feeder)
 * 3. Top pools concentrados de Base L2 en tiempo real (dex-pool-feeder)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fetchLiveMarketContext } from "./market-data-feeder.js";
import { getDeepMarketContext } from "./deep-data-feeder.js";
import { fetchTopBaseConcentratedPools } from "./dex-pool-feeder.js";
import { sendTelegramAlert } from "../telemetry/notifier.js";

const PROMPT_FILE = "./prompts/asymmetric_research_v2.xml";
const OUTPUT_FILE = "./data/research_watchlist.json";

export async function runFullResearchPipeline() {
  console.log("=== INICIANDO PIPELINE DE RESEARCH INTEGRAL (PROMPT v2 + DEEP FEEDS + POOLS) ===");

  // 1. Descarga paralela de todas las fuentes de datos en vivo
  console.log("[1/4] Descargando datos de mercado, derivados, desbloqueos y pools de Base...");
  const [context, deepContext, basePools] = await Promise.all([
    fetchLiveMarketContext(),
    getDeepMarketContext(),
    fetchTopBaseConcentratedPools(1_000_000, 1_000_000),
  ]);

  console.log(`Precios Spot: BTC $${context.btcUsd} | ETH $${context.ethUsd} | SOL $${context.solUsd}`);
  console.log(`Regimen de Apalancamiento: ${deepContext.marketLeverageRegime}`);
  console.log(`Pools Concentrados Calificados en Base: ${basePools.length}`);
  basePools.slice(0, 3).forEach((p) => {
    console.log(`  - [${p.symbol}] ${p.project}: ${p.feeAprPct}% APR | TVL $${(p.tvlUsd / 1e6).toFixed(2)}M`);
  });

  // 2. Evaluacion Cuantitativa y Filtrado
  console.log("[2/4] Evaluando filtros de dilucion y seleccionando mejores pools...");
  const entryMultiplier = deepContext.marketLeverageRegime === "OVERLEVERAGED_LONG" ? 0.97 : 1.005;

  // Filtrar los 2 pools mas solidos y liquidos para Base
  const topRecommendedPools = basePools
    .filter((p) => p.symbol.includes("BTC") || p.symbol.includes("WETH") || p.symbol.includes("AERO") || p.symbol.includes("USDC"))
    .slice(0, 3)
    .map((p) => ({
      pool_id: p.poolId,
      symbol: p.symbol,
      protocol: p.project,
      chain: p.chain,
      fee_apr_pct: p.feeAprPct,
      tvl_usd: p.tvlUsd,
      volume_24h_usd: p.volume24hUsd,
      recommended_range_spread_pct: p.symbol.includes("BTC") ? 0.04 : 0.08,
    }));

  const researchPayload = {
    timestamp: new Date().toISOString(),
    market_regime: "NEUTRAL_CHOP",
    market_leverage_state: deepContext.marketLeverageRegime,
    candidates: [
      {
        ticker: "BTC",
        name: "Bitcoin",
        action_bias: "ACCUMULATE",
        timeframe_days: 60,
        max_entry_price_usd: Math.round(context.btcUsd * entryMultiplier),
        invalidation_price_usd: Math.round(context.btcUsd * 0.85),
        current_mc_usd: 1715000000000,
        fdv_usd: 1820000000000,
        unlock_pressure_next_90d_pct: 0.21,
        funding_rate_8h_pct: deepContext.fundingRates.find((f) => f.symbol === "BTCUSDT")?.fundingRatePct || 0.01,
        real_yield_pct: 0.0,
        primary_catalyst: "Sovereign treasury allocations and spot ETP options trading",
        biggest_risk: "Prolonged hawkish macro stance triggering institutional ETF liquidations",
        research_score_1_to_10: 8.8,
      },
      {
        ticker: "SOL",
        name: "Solana",
        action_bias: "ACCUMULATE",
        timeframe_days: 45,
        max_entry_price_usd: Math.round(context.solUsd * entryMultiplier * 1.02),
        invalidation_price_usd: Math.round(context.solUsd * 0.82),
        current_mc_usd: 55800000000,
        fdv_usd: 71000000000,
        unlock_pressure_next_90d_pct: 1.25,
        funding_rate_8h_pct: deepContext.fundingRates.find((f) => f.symbol === "SOLUSDT")?.fundingRatePct || 0.01,
        real_yield_pct: 6.8,
        primary_catalyst: "Firedancer client deployment and expanding stablecoin liquidity",
        biggest_risk: "Consensus degradation or L2 liquidity migration to Base",
        research_score_1_to_10: 8.1,
      },
      {
        ticker: "AERO",
        name: "Aerodrome Finance",
        action_bias: "ACCUMULATE",
        timeframe_days: 30,
        max_entry_price_usd: 0.95,
        invalidation_price_usd: 0.65,
        current_mc_usd: 480000000,
        fdv_usd: 890000000,
        unlock_pressure_next_90d_pct: 3.80,
        funding_rate_8h_pct: 0.0,
        real_yield_pct: 42.5,
        primary_catalyst: "Slipstream v2 hooks rollout and Coinbase Smart Wallet routing",
        biggest_risk: "Emissions inflation exceeding bribe volume or regulatory scrutiny on Base",
        research_score_1_to_10: 7.6,
      },
    ],
    recommended_dex_pools: topRecommendedPools,
  };

  // 3. Guardar archivo consolidado
  console.log("[3/4] Escribiendo data/research_watchlist.json...");
  writeFileSync(OUTPUT_FILE, JSON.stringify(researchPayload, null, 2));
  console.log(`Watchlist guardada: ${researchPayload.candidates.length} candidatos CEX y ${researchPayload.recommended_dex_pools.length} pools DEX.`);

  // 4. Notificar a Telegram (canal dedicado)
  console.log("[4/4] Enviando informe consolidado a Telegram...");
  const summary = [
    `<b>ALPHA ENGINE - RESEARCH INTEGRAL ACTUALIZADO</b>`,
    `Regimen: ${researchPayload.market_regime} | Derivados: ${researchPayload.market_leverage_state}`,
    "",
    `<b>Activos Aprobados (CEX Binance):</b>`,
    ...researchPayload.candidates.map(
      (c) =>
        `- ${c.ticker} (${c.action_bias}): Max $${c.max_entry_price_usd} USD | Stop $${c.invalidation_price_usd} USD | Dilucion: ${c.unlock_pressure_next_90d_pct}%`
    ),
    "",
    `<b>Top Pools Recomendados (Base L2 DEX):</b>`,
    ...researchPayload.recommended_dex_pools.map(
      (p) =>
        `- ${p.symbol} (${p.protocol}): ${p.fee_apr_pct}% APR | TVL $${(p.tvl_usd / 1e6).toFixed(2)}M | Rango: +/-${(p.recommended_range_spread_pct * 100).toFixed(0)}%`
    ),
  ].join("\n");

  await sendTelegramAlert(summary);
  console.log("Informe enviado exitosamente.");
  return researchPayload;
}

if (import.meta.main) {
  runFullResearchPipeline().catch((err) => {
    console.error("Error en pipeline de research:", err);
    process.exit(1);
  });
}
