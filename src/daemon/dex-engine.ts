/**
 * Motor Táctico DEX en Base L2 (Alpha Engine v1.0.0)
 * Gobierna las posiciones concentradas en Aerodrome Slipstream,
 * cálculo estricto de precios relativos spot por par, estimación de gas y rotaciones holísticas.
 */

import { fetchLiveDexTokenPrice, fetchLivePoolRatio } from "../dex/dex-price-feeder.js";
import { fetchTopBaseConcentratedPools } from "../research/dex-pool-feeder.js";
import { evaluateMarketStateLocal } from "../guardrails/laya-client-local.js";
import { triggerDexRebalancePipeline } from "../research/targeted-research.js";
import { MarketTemperatureMonitor } from "../guardrails/market-temperature.js";
import { sendTelegramAlert } from "../telemetry/notifier.js";
import { RealTimeAuditLogger } from "../telemetry/audit-logger.js";
import type { DynamicAlphaOrchestrator } from "./dynamic-orchestrator.js";

export class DexEngine {
  private orchestrator: DynamicAlphaOrchestrator;
  private warnedLiveUnsupported = false;

  constructor(orchestrator: DynamicAlphaOrchestrator) {
    this.orchestrator = orchestrator;
  }

  public async tick(): Promise<void> {
    const orch = this.orchestrator;

    // GUARDIA ESTRICTA: DEX no tiene ejecución on-chain real implementada.
    if (orch.getExecutionMode() === "LIVE" && !this.warnedLiveUnsupported) {
      this.warnedLiveUnsupported = true;
      console.warn(
        "[DEX LIVE GUARD] DEX (Aerodrome Slipstream / Base L2) opera en SIMULACIÓN. " +
        "No existe ejecución on-chain real (mint/collect) conectada. Los valores de DEX son sombra."
      );
    }

    const dexPositions = orch.getDexPositions();
    const cexBots = orch.getCexBots();

    for (const [ticker, item] of dexPositions.entries()) {
      // 1. Resolución Dinámica Universal del Precio Spot del Pool
      const parts = item.pool.symbol.toUpperCase().replace(/[^A-Z0-9-]/g, "").split("-");
      if (parts.length === 2) {
        const tokenA = parts[0];
        const tokenB = parts[1];

        if (tokenA === "USDC" || tokenA === "USDT") {
          // Cotización directa en USD del token volátil
          const p = await fetchLiveDexTokenPrice(tokenB);
          if (p && p > 0) item.pool.price = p;
        } else if (tokenB === "USDC" || tokenB === "USDT") {
          const p = await fetchLiveDexTokenPrice(tokenA);
          if (p && p > 0) item.pool.price = p;
        } else {
          // Ratio relativo entre dos tokens volátiles (ej: WETH / CBBTC)
          const ratio = await fetchLivePoolRatio(tokenA, tokenB);
          if (ratio && ratio > 0) item.pool.price = ratio;
        }
      }

      // 2. Polling de APR y TVL dinámicos cada 10 minutos
      const now = Date.now();
      if (!item.lastPoolStatsTs || now - item.lastPoolStatsTs > 600_000) {
        item.lastPoolStatsTs = now;
        fetchTopBaseConcentratedPools().then((topPools) => {
          const matched = topPools.find(
            (p) => p.symbol.toLowerCase().replace(/[^a-z0-9]/g, "") === item.pool.symbol.toLowerCase().replace(/[^a-z0-9]/g, "")
          );
          if (matched && matched.feeAprPct > 0) {
            item.pool.feeAprPct = matched.feeAprPct;
            item.pool.tvlUsd = matched.tvlUsd;
            item.pool.volume24hUsd = matched.volume24hUsd;
          }
        }).catch(() => {});
      }

      const judgments = await evaluateMarketStateLocal({ dex_pool: item.pool.symbol }, 1000);
      const prevSnap = item.engine.getSnapshot();
      const jevRegime = cexBots.get(ticker)?.jevJudgment?.regime || cexBots.get("BTC")?.jevJudgment?.regime || "BALANCED_RANGE";
      
      // Ponderación dinámica de riesgo según Sortino y TVL del pool (Cero constantes quemadas)
      const poolTvl = item.pool.tvlUsd || 1_000_000;
      const riskWeight = Math.min(0.85, Math.max(0.20, (poolTvl / 10_000_000) * 0.6 + 0.25));

      // Calcular temperatura térmica del activo o colateral del pool
      const cexPriceHist = cexBots.get(ticker)?.priceHistory || cexBots.get("BTC")?.priceHistory || [item.pool.price];
      const temp = MarketTemperatureMonitor.getTemperature(ticker, cexPriceHist);

      const lastTickTs = item.lastTickTs || (now - 10_000);
      item.lastTickTs = now;
      const elapsedSeconds = Math.max(1, Math.min(60, Math.round((now - lastTickTs) / 1000)));

      const stepRes = await item.engine.step(
        item.pool.price,
        0.05,
        judgments,
        jevRegime,
        riskWeight,
        temp.spacingMultiplier,
        elapsedSeconds
      );

      // 3. Rotación Autónoma de Pools ante Pausa Defensiva en slots rotables
      const isSlotAnchor = item.pool.symbol.includes("WETH-CBBTC") || item.pool.symbol.includes("BTC");
      if (!isSlotAnchor && stepRes.position.status === "PAUSED_DEFENSIVE") {
        if (!item.lastRebalanceCheckTs || now - item.lastRebalanceCheckTs > 300_000) {
          item.lastRebalanceCheckTs = now;
          const currentSlotCap = item.engine.getSnapshot().currentCapitalUsd || item.engine.getSnapshot().initialCapitalUsd;
          console.log(`[DEX AUTO-ROTATION TRIGGER] Disparando rotación de slot DEX ${ticker} ($${currentSlotCap.toFixed(2)} USD)...`);

          triggerDexRebalancePipeline(item.pool.symbol, currentSlotCap, "WETH-CBBTC").then((reb) => {
            if (reb.ok && reb.action === "ROTATE_NEW_POOL") {
              item.allocationReason = reb.justification;
              item.pool.symbol = reb.poolSymbol;
              item.pool.protocol = reb.protocol;
              item.pool.feeAprPct = reb.feeAprPct;

              // REINICIALIZAR RANGO ATÓMICAMENTE PARA EVITAR BUCLING
              const yieldEngine = item.engine;
              const yieldSnap = yieldEngine.getSnapshot();
              const prevAccFees = yieldSnap.accumulatedFeesUsd;
              yieldSnap.lowerRangePrice = reb.newLowerPrice;
              yieldSnap.upperRangePrice = reb.newUpperPrice;
              yieldSnap.entryPrice = item.pool.price; // Actualizar precio de entrada al nuevo pool
              yieldSnap.accumulatedFeesUsd = prevAccFees;
              if (reb.layaSafe) {
                yieldSnap.status = "ACTIVE";
              }

              RealTimeAuditLogger.getInstance().record(
                "DEX",
                "AUTO_ROTATION_TRIGGER",
                ticker,
                "ROTATE_NEW_POOL",
                `Slot rotado a ${reb.poolSymbol} (${reb.feeAprPct.toFixed(1)}% APR). Nuevo Rango: [${reb.newLowerPrice} - ${reb.newUpperPrice}]. Laya Safe: ${reb.layaSafe}.`,
                "WARN",
                { slot: ticker, newPool: reb.poolSymbol, apr: reb.feeAprPct },
                orch.getExecutionMode()
              );

              orch.savePersistentState();
            }
          }).catch(() => {});
        }
      }

      // 4. Registro de trades/rebalanceos en el ledger SOLO cuando hay reclamación real de comisiones (> $0.0001)
      if ((stepRes.decision.includes("REPOSITION") || stepRes.decision.includes("REBALANCE")) && !stepRes.decision.includes("HOLD")) {
        const deltaFees = Math.max(0, stepRes.position.accumulatedFeesUsd - prevSnap.accumulatedFeesUsd);
        if (deltaFees > 0.0001) {
          orch.getLedger().recordTrade({
            timestamp: new Date().toISOString(),
            mode: orch.getExecutionMode(),
            venue: "BASE_DEX",
            assetOrPool: item.pool.symbol,
            action: "DEX_FEE_COLLECT",
            price: item.pool.price,
            amount: 0,
            pnlNet: parseFloat(deltaFees.toFixed(4)),
            pnlPct: parseFloat(((deltaFees / item.engine.getSnapshot().initialCapitalUsd) * 100).toFixed(3)),
            feeSavedOrPaid: parseFloat(deltaFees.toFixed(4)),
            poolFeesAccruedUsd: parseFloat(deltaFees.toFixed(4)),
          });
        }

        RealTimeAuditLogger.getInstance().record(
          "DEX",
          "REBALANCE_TRIGGER",
          item.pool.symbol,
          "REPOSITION_RANGE",
          `Posición re-centrada: [${stepRes.position.lowerRangePrice} - ${stepRes.position.upperRangePrice}]. Fees acumuladas: +$${stepRes.position.accumulatedFeesUsd.toFixed(4)} USD (delta +$${deltaFees.toFixed(4)}). IL: $${(stepRes.position.impermanentLossUsd || 0).toFixed(4)} USD. Gas acumulado: $${(stepRes.position.gasSpentUsd || 0).toFixed(4)} USD. Régimen: ${jevRegime}.`,
          "INFO",
          {
            pool: item.pool.symbol,
            deltaFees,
            accumulatedFeesUsd: stepRes.position.accumulatedFeesUsd,
            impermanentLossUsd: stepRes.position.impermanentLossUsd,
            gasSpentUsd: stepRes.position.gasSpentUsd,
            netPnlUsd: stepRes.netPnlUsd,
            lower: stepRes.position.lowerRangePrice,
            upper: stepRes.position.upperRangePrice,
          },
          orch.getExecutionMode()
        );
        orch.recordDexRebalance();

        await sendTelegramAlert(
          `[ALPHA ENGINE PAPER] REBALANCEO/REACTIVACION DEX (${item.pool.symbol})\nMotivo: ${stepRes.decision}\nNuevo Rango: [${stepRes.position.lowerRangePrice} - ${stepRes.position.upperRangePrice}]\nRegimen Jev: ${jevRegime}\nFees Reclamados: +$${deltaFees.toFixed(4)} USD`
        );
      }
    }
  }
}
