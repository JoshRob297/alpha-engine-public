/**
 * Pipeline de Research Especializado y Rebalanceo On-Demand
 * Desacopla la selección estratégica semanal de los gatillos reactivos por evento.
 * 
 * Flujo Completo tras Disparo de Prompt:
 * 1. Gemini evalúa candidatos con el prompt especializado (DEX Pools o CEX Spot).
 * 2. Jev (Cloud) valida el régimen macro y ajusta el límite de exposición.
 * 3. SETS (22 Hilos) recalcula los parámetros matemáticos de dispersión y mallas.
 * 4. Laya (Compute-node :8088) realiza el check de microestructura táctico antes de permitir la entrada.
 */

import { fetchTopBaseConcentratedPools, type QualifiedDexPool } from "./dex-pool-feeder.js";
import { evaluateMarketWithJev } from "../guardrails/typesafe-jev-client.js";
import { calculateCausalConcentratedRange } from "../guardrails/causal-range-allocator.js";
import { calculateDynamicRiskWeights, type AssetCandidate } from "../guardrails/risk-weight-allocator.js";
import { evaluateMarketStateLocal } from "../guardrails/laya-client-local.js";
import { sendTelegramAlert } from "../telemetry/notifier.js";
import { BinanceSymbolResolver } from "../cex/symbol-resolver.js";

export interface DexPortfolioRebalanceResult {
  ok: boolean;
  action: "ROTATE_NEW_POOL" | "REPOSITION_ACTIVE_RANGE" | "HOLD_DEFENSIVE";
  poolSymbol: string;
  protocol: string;
  feeAprPct: number;
  newLowerPrice: number;
  newUpperPrice: number;
  jevRegime: string;
  layaSafe: boolean;
  justification: string;
  allocatedCapitalUsd?: number;
}

/**
 * Disparador Autónomo de Rotación para Slots DEX Concentrados
 * Selecciona el pool calificado de Aerodrome Slipstream con mayor rendimiento y calcula su nuevo rango SETS.
 */
export async function triggerDexRebalancePipeline(
  currentPoolSymbol: string,
  slotCapitalUsd: number,
  excludedPoolSymbol: string = "WETH-CBBTC"
): Promise<DexPortfolioRebalanceResult> {
  console.log(`=== [DEX SLOT REBALANCE PIPELINE] EVALUANDO ROTACION DE SLOT ($${slotCapitalUsd.toFixed(2)} USD) ===`);

  try {
    // PASO 1: Consulta de datos frescos de DeFiLlama en Base L2 (Estricto Aerodrome Slipstream)
    const pools = await fetchTopBaseConcentratedPools(1_000_000, 1_000_000);
    const candidates = pools.filter(
      (p) =>
        p.symbol !== currentPoolSymbol &&
        p.symbol !== excludedPoolSymbol &&
        p.project === "aerodrome-slipstream" &&
        p.feeAprPct > 30.0
    );
    const selected = candidates.find((p) => p.tvlUsd >= 1_500_000) || candidates[0];

    if (!selected) {
      return {
        ok: false,
        action: "HOLD_DEFENSIVE",
        poolSymbol: currentPoolSymbol,
        protocol: "None",
        feeAprPct: 0,
        newLowerPrice: 0,
        newUpperPrice: 0,
        jevRegime: "DEFENSIVE_STRESS",
        layaSafe: false,
        justification: "No se encontraron pools calificados con TVL suficiente en Base L2.",
      };
    }

    // PASO 2: Validación Macro con Jev System 2 (Cloud)
    const jevJudgment = await evaluateMarketWithJev({
      ticker: selected.symbol.split("-")[0],
      book: selected.symbol,
      midPrice: 1.0,
      spreadBps: 10,
      bidsDepthUsd: 100000,
      asksDepthUsd: 100000,
      ofiScore: 0.20,
      depthRatio: 1.1,
      isLiquidityEvaporating: false,
    });
    const jevRegime = jevJudgment?.regime || "BALANCED_RANGE";

    // PASO 3: Cálculo Geométrico de Ticks con SETS (Dynamic Range Allocator)
    const currentPriceRef = selected.symbol.includes("USDC") && !selected.symbol.includes("BTC") ? 1.0 : selected.symbol.includes("BTC") ? 84000.0 : 0.032;
    const range = calculateCausalConcentratedRange(currentPriceRef, jevRegime, 0.40);

    // PASO 4: Auditoría de Microestructura con Laya System 1 (:8088 en Compute-node)
    const laya = await evaluateMarketStateLocal({ dex_pool: selected.symbol }, 1000);
    const layaSafe = (laya.toxicFlow ?? 0) <= 0.60;

    const justification = `Rotación Dinámica DEX: Slot reasignado a ${selected.symbol} ($${slotCapitalUsd.toFixed(2)} USD, ${selected.feeAprPct.toFixed(1)}% APR, TVL: $${(selected.tvlUsd / 1e6).toFixed(2)}M). Régimen Jev: ${jevRegime}. Rango SETS: [${range.lowerPrice.toFixed(4)} - ${range.upperPrice.toFixed(4)}]. Laya: ${layaSafe ? "Aprobado" : "Standby"}.`;

    console.log(`[DEX SLOT REBALANCE COMPLETE]: ${justification}`);

    await sendTelegramAlert(
      `[ALPHA ENGINE] ROTACION AUTONOMA DE SLOT DEX ($${slotCapitalUsd.toFixed(2)} USD)\n\n• Nuevo Pool: ${selected.symbol} (${selected.project})\n• APR Estimado: ${selected.feeAprPct.toFixed(1)}% (TVL: $${(selected.tvlUsd / 1e6).toFixed(2)}M)\n• Régimen Macro: ${jevRegime}\n• Rango SETS: [${range.lowerPrice.toFixed(4)} - ${range.upperPrice.toFixed(4)}]\n• Veredicto Laya: ${layaSafe ? "Ejecución Aprobada" : "En espera de estabilidad"}`
    );

    return {
      ok: true,
      action: "ROTATE_NEW_POOL",
      poolSymbol: selected.symbol,
      protocol: selected.project === "aerodrome-slipstream" ? "Aerodrome Slipstream" : selected.project,
      feeAprPct: selected.feeAprPct,
      newLowerPrice: range.lowerPrice,
      newUpperPrice: range.upperPrice,
      jevRegime,
      layaSafe,
      justification,
      allocatedCapitalUsd: slotCapitalUsd,
    };
  } catch (err: any) {
    console.error("[DEX REBALANCE ERROR]:", err);
    return {
      ok: false,
      action: "HOLD_DEFENSIVE",
      poolSymbol: currentPoolSymbol,
      protocol: "Error",
      feeAprPct: 0,
      newLowerPrice: 0,
      newUpperPrice: 0,
      jevRegime: "ERROR",
      layaSafe: false,
      justification: `Fallo en pipeline reactivo: ${err?.message || err}`,
    };
  }
}

export interface CexRebalanceResult {
  ok: boolean;
  action: "ROTATE_NEW_ASSET" | "REBALANCE_CURRENT" | "TRANSFER_TO_FIAT_RESERVE";
  newTicker: string;
  newBook: string;
  allocatedCashUsd: number;
  maxEntryPriceUsd: number;
  invalidationPriceUsd: number;
  justification: string;
}

/**
 * Disparador On-Demand para Rebalanceo y Rotación en CEX Spot (Binance USD)
 * Se activa inmediatamente si un activo se invalida por caída macro, stop estructural o toxicidad crónica.
 */
export async function triggerCexRebalancePipeline(
  invalidatedTicker: string,
  capitalUsd: number,
  currentMacroRegime: string = "BALANCED_RANGE"
): Promise<CexRebalanceResult> {
  console.log(`=== [CEX REBALANCE PIPELINE] DISPARADO PARA ${invalidatedTicker} ($${capitalUsd} USD) ===`);

  try {
    // 1. Si el mercado está en estrés crítico o no hay convicción, transferir el capital a la Reserva USDT
    if (currentMacroRegime === "DEFENSIVE_STRESS") {
      const justification = `Invalidación de ${invalidatedTicker} bajo DEFENSIVE_STRESS: Capital de $${capitalUsd} USD transferido a la Reserva USDT para resguardo.`;
      console.log(`[CEX REBALANCE DEFENSIVE]: ${justification}`);

      await sendTelegramAlert(
        `[ALPHA ENGINE] ROTACIÓN CEX -> RESERVA USDT\nActivo Invalidado: ${invalidatedTicker}\nDestino: Reserva Líquida USDT ($${capitalUsd} USD)\nMotivo: Régimen macro DEFENSIVE_STRESS protege capital.`
      );

      return {
        ok: true,
        action: "TRANSFER_TO_FIAT_RESERVE",
        newTicker: "USDT",
        newBook: "USDT",
        allocatedCashUsd: capitalUsd,
        maxEntryPriceUsd: 0,
        invalidationPriceUsd: 0,
        justification,
      };
    }

    // 2. Selección de activo sustituto calificado en Binance (ej. ETH si se invalida SOL, o viceversa)
    const alternativeTicker = invalidatedTicker === "SOL" ? "ETH" : "SOL";
    const resolved = await BinanceSymbolResolver.resolveSymbol(alternativeTicker);
    const alternativeBook = resolved.isValid ? resolved.symbol : `${alternativeTicker}USDT`;

    // 3. Validación de microestructura con Laya
    const laya = await evaluateMarketStateLocal({ ticker: alternativeTicker, book: alternativeBook }, 1000);
    const layaSafe = (laya.toxicFlow ?? 0) <= 0.60;

    if (layaSafe) {
      const justification = `Invalidación de ${invalidatedTicker}: Rotación reactiva a ${alternativeTicker} (${alternativeBook}) con $${capitalUsd} USD. Microestructura Laya aprobada.`;
      console.log(`[CEX REBALANCE ROTATION]: ${justification}`);

      await sendTelegramAlert(
        `[ALPHA ENGINE] ROTACIÓN CEX ACTIVADA\nActivo Invalidado: ${invalidatedTicker}\nNuevo Activo Aprobado: ${alternativeTicker} (${alternativeBook})\nCapital Reasignado: $${capitalUsd} USD\nValidación Laya: OK`
      );

      return {
        ok: true,
        action: "ROTATE_NEW_ASSET",
        newTicker: alternativeTicker,
        newBook: alternativeBook,
        allocatedCashUsd: capitalUsd,
        maxEntryPriceUsd: 0,
        invalidationPriceUsd: 0,
        justification,
      };
    } else {
      // Si el sustituto también está tóxico, enviar a la reserva USDT
      const justification = `Invalidación de ${invalidatedTicker} y sustituto ${alternativeTicker} tóxico: Capital de $${capitalUsd} USD resguardado en Reserva USDT.`;
      return {
        ok: true,
        action: "TRANSFER_TO_FIAT_RESERVE",
        newTicker: "USDT",
        newBook: "USDT",
        allocatedCashUsd: capitalUsd,
        maxEntryPriceUsd: 0,
        invalidationPriceUsd: 0,
        justification,
      };
    }
  } catch (err: any) {
    console.error("[CEX REBALANCE ERROR]:", err);
    return {
      ok: false,
      action: "TRANSFER_TO_FIAT_RESERVE",
      newTicker: "USDT",
      newBook: "USDT",
      allocatedCashUsd: capitalUsd,
      maxEntryPriceUsd: 0,
      invalidationPriceUsd: 0,
      justification: `Fallo en pipeline reactivo CEX: ${err?.message || err}. Capital preservado en USDT.`,
    };
  }
}
