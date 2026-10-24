/**
 * Asignador Cuantitativo de Capital y Sincronizador de Watchlist (Alpha Engine v1.0.0)
 * 100% DINÁMICO: Cero mapas estáticos quemados (BASE_POOLS purgado).
 * Los pools de Base L2 se indexan directamente por su símbolo real on-chain.
 */

import { FAMILIES, GridBot, DEFAULT_GENOME, type Genome } from "../genetic/bot.js";
import { ParallelEvolutionEngine } from "../genetic/parallel-evolution.js";
import { makeSeries } from "../genetic/series.js";
import { calculateDynamicRiskWeights, type AssetCandidate } from "../guardrails/risk-weight-allocator.js";
import { getRegimePolicy } from "../guardrails/regime-policy.js";
import { ShadowLPEngine, type PoolState } from "../dex/shadow-lp-simulator.js";
import { fetchFuturesFundingRates } from "../research/deep-data-feeder.js";
import { loadActiveWatchlist } from "../research/watchlist-loader.js";
import { sendTelegramAlert } from "../telemetry/notifier.js";
import { BinanceSymbolResolver } from "../cex/symbol-resolver.js";
import { BinanceHistoricalFeeder } from "../cex/binance-history.js";
import { JitEvolutionEngine } from "../genetic/jit-evolution.js";
import { isGenomeFrozen } from "../guardrails/measurement-window.js";
import { planCapitalNormalization, planDexCapitalNormalization } from "./capital-normalizer.js";
import { decideAllocationRegime } from "./regime-hysteresis.js";
import { applyUniverseFreeze, loadUniverse, universeExpanded } from "../guardrails/measurement-universe.js";
import { RealTimeAuditLogger } from "../telemetry/audit-logger.js";
import { fetchTopBaseConcentratedPools } from "../research/dex-pool-feeder.js";
import { adaptEvolvedAtrGenome } from "../genetic/genome-adapter.js";
import type { DynamicAlphaOrchestrator } from "./dynamic-orchestrator.js";

export const BINANCE_PAIRS: Record<string, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  SOL: "SOLUSDT",
  AVAX: "AVAXUSDT",
  SUI: "SUIUSDT",
};

/**
 * Mapea el vocabulario de régimen de Jev System One al vocabulario del
 * optimizador de paridad de riesgo, garantizando que la reserva fiduciaria
 * y el apetito de capital respondan al régimen macro real.
 */
export function mapJevRegimeToRiskRegime(
  regime: string
): "ACCUMULATE" | "DEFENSIVE" | "VOLATILE_CRASH" | "BALANCED_RANGE" {
  switch (regime) {
    case "AGGRESSIVE_ACCUMULATION":
      return "ACCUMULATE";
    case "DEFENSIVE_STRESS":
      return "VOLATILE_CRASH";
    case "BALANCED_RANGE":
      return "BALANCED_RANGE";
    default:
      return "BALANCED_RANGE";
  }
}

export { DEFAULT_GENOME };

export class CapitalAllocator {
  private orchestrator: DynamicAlphaOrchestrator;
  /** Throttle de avisos de congelamiento por ticker (evita spam de log). */
  private static freezeNoticeTs: Map<string, number> = new Map();

  constructor(orchestrator: DynamicAlphaOrchestrator) {
    this.orchestrator = orchestrator;
  }

  /** Ventana minima entre normalizaciones de capital (anti-churn). */
  private static readonly NORMALIZATION_MIN_INTERVAL_MS = 15 * 60_000;

  /**
   * Rate limit del rebalanceo de capital por politica. El churn de regimen generaba
   * hasta 4 normalizaciones por hora moviendo caja real en ambos sentidos; con el
   * objetivo anclado por histeresis, 15 minutos son suficientes para corregir desvios.
   */
  private canNormalize(): boolean {
    return Date.now() - this.orchestrator.getLastNormalizationTs() >= CapitalAllocator.NORMALIZATION_MIN_INTERVAL_MS;
  }
  public async evaluateReactiveEvolution(ticker: string, reason = "ESTRÉS"): Promise<boolean> {
    const orch = this.orchestrator;

    // Ventana de medicion out-of-sample: no se recalibran genomas en vivo.
    if (isGenomeFrozen()) {
      const lastLog = CapitalAllocator.freezeNoticeTs.get(ticker) || 0;
      if (Date.now() - lastLog > 3_600_000) {
        CapitalAllocator.freezeNoticeTs.set(ticker, Date.now());
        console.log(
          `[GENOME FREEZE] Recalibracion para ${ticker} omitida ante ${reason} (ventana de medicion OOS activa).`
        );
      }
      return false;
    }

    const now = Date.now();
    const lastEvo = orch.getLastEvolutionTs();

    if (now - lastEvo < 900_000) {
      return false;
    }
    orch.setLastEvolutionTs(now);

    console.log(`[SETS REACTIVE TRIGGER] Disparando recalibracion genetica paralela para ${ticker} ante ${reason}...`);

    try {
      const botItem = orch.getCexBots().get(ticker);
      const currentRegime = botItem?.jevJudgment?.regime || "BALANCED_RANGE";
      const currentOfi = botItem?.lastOfiScore ?? 0;

      let fundingRatePct = 0.01;
      try {
        const rates = await fetchFuturesFundingRates();
        const found = rates.find((r) => r.symbol.startsWith(ticker));
        if (found) fundingRatePct = found.fundingRatePct;
      } catch {}

      const url = `https://api.binance.com/api/v3/klines?symbol=${ticker}USDT&interval=1h&limit=1000`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      const raw = await res.json();
      if (!Array.isArray(raw) || raw.length < 100) return false;

      const candles: Array<[number, number, number, number, number, number]> = raw.map((k: any) => [
        k[0],
        parseFloat(k[1]),
        parseFloat(k[2]),
        parseFloat(k[3]),
        parseFloat(k[4]),
        parseFloat(k[5]),
      ]);

      const series = makeSeries(candles);

      const engine = new ParallelEvolutionEngine(candles, series, {
        pop: 128,
        elite: 8,
        immigrants: 12,
        numWindows: 3,
        threads: 22,
        context: {
          regime: currentRegime as any,
          fundingRatePct,
          ofiScore: currentOfi,
        },
      });

      await engine.initPopulation();
      for (let g = 0; g < 12; g++) {
        await engine.step();
      }

      if (engine.leader) {
        orch.getActiveGenomes().set(ticker, engine.leader.genome);
        if (botItem) {
          botItem.bot.g = engine.leader.genome;
        }
        console.log(
          `[PARALLEL EVOLUTION] ${ticker} optimizado en 22 hilos: ${FAMILIES[engine.leader.genome.family]} (Sortino Fit: ${engine.leader.fit.toFixed(2)}, Contexto: ${currentRegime}, Funding: ${fundingRatePct.toFixed(3)}%, OFI: ${(currentOfi * 100).toFixed(1)}%)`
        );
        RealTimeAuditLogger.getInstance().record(
          "SETS",
          "REACTIVE_EVOLUTION_TRIGGER",
          ticker,
          "MUTATE_GENOME_PARALLEL",
          `Genoma re-calibrado en 22 hilos: ${FAMILIES[engine.leader.genome.family]} (Sortino: ${engine.leader.fit.toFixed(2)}). Spacing=${(engine.leader.genome.spacing * 100).toFixed(2)}% | TP=${(engine.leader.genome.tp * 100).toFixed(2)}% | Stop=${(engine.leader.genome.stop * 100).toFixed(2)}%. Contexto: ${currentRegime}.`,
          "INFO",
          { ticker, family: FAMILIES[engine.leader.genome.family], sortino: engine.leader.fit, regime: currentRegime }
        );
        return true;
      }
    } catch (err) {
      console.error(`[PARALLEL EVOLUTION ERROR ${ticker}]:`, err);
    }
    return false;
  }

  public async syncWithWatchlist(): Promise<void> {
    const orch = this.orchestrator;
    const watchlist = loadActiveWatchlist();
    if (!watchlist || !watchlist.candidates) return;

    const approvedCexCandidates = watchlist.candidates.filter(
      (c) => c.action_bias === "ACCUMULATE"
    );

    const cexBots = orch.getCexBots();
    const dexPositions = orch.getDexPositions();

    // 1. Gestión CEX: Desactivar activos eliminados
    for (const [ticker, active] of cexBots.entries()) {
      const stillApproved = approvedCexCandidates.some((c) => c.ticker === ticker);
      if (!stillApproved) {
        console.log(`[WATCHLIST SYNC] Desactivando bot CEX para ${ticker}.`);
        active.bot.circuitBreakerActive = true;
        cexBots.delete(ticker);
        await sendTelegramAlert(`[ALPHA ENGINE] PAR DESACTIVADO: ${ticker} ya no cuenta con sesgo ACCUMULATE.`);
      }
    }

    // 2. Obtener política macro de capital basada en el régimen predominante
    let predominantRegime = "BALANCED_RANGE";
    const regimeCounts: Record<string, number> = {};
    for (const [, item] of cexBots.entries()) {
      const reg = item.jevJudgment?.regime || "BALANCED_RANGE";
      regimeCounts[reg] = (regimeCounts[reg] || 0) + 1;
    }
    for (const [r, count] of Object.entries(regimeCounts)) {
      if (count > (regimeCounts[predominantRegime] || 0)) {
        predominantRegime = r;
      }
    }
    // 2.b Regimen de ASIGNACION (lento): el regimen observado persiste solo 5-9 h y
    // cada cambio movia el objetivo de capital ~40 USD, forzando al normalizador a
    // mover caja real cada pocas horas (segunda deriva detectada el 2026-10-22).
    // El capital solo se reasigna si el regimen observado se mantiene IGUAL >= 12 h.
    // El regimen tactico (TP/salidas) sigue usando el juicio por activo directamente.
    const regimeDecision = decideAllocationRegime(
      orch.getAllocationRegime(),
      predominantRegime,
      Date.now()
    );
    orch.setAllocationRegime(regimeDecision.state);
    const appliedRegime = regimeDecision.applied;
    if (regimeDecision.changed) {
      console.log(
        `[ALLOCATION REGIME] Capital reasignado a ${appliedRegime} tras persistencia (observado ${predominantRegime}).`
      );
    } else if (appliedRegime !== predominantRegime) {
      console.log(
        `[ALLOCATION REGIME] Objetivo de capital anclado en ${appliedRegime} (observado ${predominantRegime} hace ${Math.round(regimeDecision.state.persistedMs / 3_600_000)}h; umbral 12h). Sin churn de reasignacion.`
      );
    }
    const policy = getRegimePolicy(appliedRegime);
    const fiatReservePct = policy.fiatPct;
    const activeCapitalUsd = orch.getTotalSimulationCapitalUsd() * (1 - fiatReservePct);
    const cexTotalPoolUsd = activeCapitalUsd * policy.cexPct;

    // 3. Activar o re-ponderar CEX dinámicamente
    if (approvedCexCandidates.length > 0) {
      const validatedCandidates: Array<(typeof approvedCexCandidates)[0] & { resolvedSymbol: string }> = [];

      for (const candidate of approvedCexCandidates) {
        let symbol = BINANCE_PAIRS[candidate.ticker];
        if (!symbol) {
          const resolved = await BinanceSymbolResolver.resolveSymbol(candidate.ticker);
          if (resolved.isValid) {
            symbol = resolved.symbol;
            BINANCE_PAIRS[candidate.ticker] = symbol;
          } else {
            continue;
          }
        }

        if (!orch.getActiveGenomes().has(candidate.ticker)) {
          // Con genomas congelados (ventana de medicion OOS) el activo nuevo entra
          // con el genoma por defecto: sin ajuste en caliente no hay contaminacion.
          if (isGenomeFrozen()) {
            orch.getActiveGenomes().set(candidate.ticker, DEFAULT_GENOME);
            validatedCandidates.push({ ...candidate, resolvedSymbol: symbol });
            continue;
          }
          const series = await BinanceHistoricalFeeder.fetchHistoricalSeries(symbol, 17_520, 2_160);
          if (series) {
            const evoResult = await JitEvolutionEngine.evolveGenomeForAsset(candidate.ticker, symbol, series);
            if (evoResult.isViable) {
              orch.getActiveGenomes().set(candidate.ticker, evoResult.genome);
            } else {
              continue;
            }
          } else {
            continue;
          }
        }
        validatedCandidates.push({ ...candidate, resolvedSymbol: symbol });
      }

      const binanceSymbolsToSync = validatedCandidates.map((c) => c.resolvedSymbol);
      if (binanceSymbolsToSync.length > 0) {
        await orch.getBinanceDriver().syncMarketRules(binanceSymbolsToSync);
      }

      // 3.a.b Congelamiento del universo de medicion: durante la ventana OOS solo se
      // operan los activos registrados al inicio. Sin esto el test pre-registrado se
      // vuelve seleccion adaptativa (research semanal + onboarding admitian activos
      // nuevos dentro de la ventana).
      if (isGenomeFrozen()) {
        const universe = loadUniverse();
        const { decision, admissions } = applyUniverseFreeze(
          validatedCandidates.map((c) => c.ticker),
          universe,
          "ASSET",
          process.env.UNIVERSE_ALLOW_EXPANSION === "true"
        );
        if (decision.rejected.length > 0) {
          logUniverseAdmissions("ASSET", decision.rejected, admissions);
        }
        if (universeExpanded(admissions)) {
          orch.recordWindowInvalidation(
            "UNIVERSE_EXPANSION",
            `Activos admitidos dentro de la ventana congelada: ${admissions.filter((a) => a.allowed).map((a) => a.key).join(", ")}`
          );
        }
        const allowedSet = new Set(decision.allowed);
        for (let i = validatedCandidates.length - 1; i >= 0; i--) {
          if (!allowedSet.has(validatedCandidates[i].ticker)) validatedCandidates.splice(i, 1);
        }
      }

      const candidatesForWeights: AssetCandidate[] = validatedCandidates.map((c) => {
        const isAnchor = c.ticker === "BTC" || c.ticker === "ETH";
        const vol = (c as any).current_volatility || (isAnchor ? 0.28 : 0.60);
        const sortino = (c as any).historical_sortino || (isAnchor ? 1.85 : 1.25);
        return {
          ticker: c.ticker,
          isAnchor,
          volatility: vol,
          sortino: sortino,
          liquidityScore: isAnchor ? 1.0 : Math.min(1.0, (c.current_mc_usd || 100_000_000) / 1_000_000_000),
        };
      });

      const allocation = calculateDynamicRiskWeights(candidatesForWeights, mapJevRegimeToRiskRegime(predominantRegime));

      for (const candidate of validatedCandidates) {
        if (!cexBots.has(candidate.ticker)) {
          const rawWeight = allocation.weights[candidate.ticker] || (1 / validatedCandidates.length);
          const isAnchor = candidate.ticker === "BTC" || candidate.ticker === "ETH";
          const cexSharePct = isAnchor ? rawWeight : Math.min(rawWeight, 0.20);
          const capitalForThisBot = cexTotalPoolUsd * cexSharePct;
          const reason = `Ponderación Causal ${(cexSharePct * 100).toFixed(1)}% de $${cexTotalPoolUsd.toFixed(2)} USD (${isAnchor ? "Ancla Institucional" : "Beta Momentum"})`;

          const book = candidate.resolvedSymbol;
          const rawGenome: any = orch.getActiveGenomes().get(candidate.ticker);
          const genome: Genome = adaptEvolvedAtrGenome(rawGenome, DEFAULT_GENOME);
          const bot = new GridBot(genome, capitalForThisBot);

          cexBots.set(candidate.ticker, {
            ticker: candidate.ticker,
            book,
            bot,
            allocatedCashUsd: capitalForThisBot,
            allocationReason: reason,
          });

          const pendingCex = orch.getPendingCexRestoration();
          if (pendingCex && pendingCex[candidate.ticker]) {
            const saved = pendingCex[candidate.ticker];
            if (saved.qty > 0 || (Array.isArray(saved.levels) && saved.levels.length > 0)) {
              bot.qty = saved.qty || 0;
              bot.cost = (saved.qty || 0) * (saved.avgPrice || 0);
              // Restaurar la CAJA REAL persistida, no re-crearla desde el objetivo.
              // Antes: cash = capitalForThisBot - cost, lo que ACUÑABA capital en cada
              // reinicio (cada bot recibia el objetivo completo aunque ya tuviera NAV).
              const savedCash = typeof saved.cashUsd === "number" ? saved.cashUsd : undefined;
              bot.cash = savedCash !== undefined ? savedCash : Math.max(0, capitalForThisBot - bot.cost);
              if (saved.tpPrice) bot.tp = saved.tpPrice;
              if (saved.stopPrice) bot.stop = saved.stopPrice;
              if (Array.isArray(saved.priceHistory) && saved.priceHistory.length > 0) {
                const botItem = cexBots.get(candidate.ticker);
                if (botItem) botItem.priceHistory = [...saved.priceHistory];
              }
              if (Array.isArray(saved.levels) && saved.levels.length > 0) {
                bot.levels = saved.levels.map((lvl: any) => ({
                  name: lvl.name,
                  price: lvl.price,
                  usd: lvl.amountUsd || 0,
                  filled: lvl.filled,
                  t: 0,
                }));
              }
            }
          }
          console.log(`[WATCHLIST SYNC] Activando nuevo bot CEX Nativo USD: ${candidate.ticker} (${book}) con $${capitalForThisBot.toFixed(2)} USD (${(cexSharePct * 100).toFixed(1)}% de CEX). Motivo: ${reason}`);
        }
      }

      // 3.b Normalizacion de capital: alinear la caja REAL con el objetivo de la
      // politica vigente. El asignador fijaba la etiqueta `allocatedCashUsd` pero nunca
      // movia caja, de modo que los bots creados bajo una politica previa conservaban el
      // dinero y el desplegado excedia el presupuesto del regimen (hueco de conservacion).
      const freshTargets = new Map<string, number>();
      for (const candidate of validatedCandidates) {
        const rawWeight = allocation.weights[candidate.ticker] || 1 / validatedCandidates.length;
        const isAnchor = candidate.ticker === "BTC" || candidate.ticker === "ETH";
        const cexSharePct = isAnchor ? rawWeight : Math.min(rawWeight, 0.20);
        freshTargets.set(candidate.ticker, cexTotalPoolUsd * cexSharePct);
      }

      const botsForPlan = [];
      for (const [ticker, item] of cexBots.entries()) {
        const target = freshTargets.get(ticker);
        if (target === undefined) continue;
        const price = item.lastMidPrice || item.bot.avg || 0;
        botsForPlan.push({
          ticker,
          cashUsd: item.bot.cash,
          inventoryValueUsd: item.bot.qty * price,
          targetUsd: target,
        });
      }

      const plan = this.canNormalize()
        ? planCapitalNormalization(botsForPlan, orch.getUnallocatedCashUsd(), 0.10)
        : { moves: [], reserveDeltaUsd: 0, overAllocatedUsd: 0, underAllocatedUsd: 0 };
      if (plan.moves.length > 0) {
        for (const move of plan.moves) {
          const item = cexBots.get(move.ticker);
          if (!item) continue;
          item.bot.cash += move.deltaUsd;
          item.allocatedCashUsd = freshTargets.get(move.ticker) || item.allocatedCashUsd;
        }
        orch.addUnallocatedCash(plan.reserveDeltaUsd);
        orch.addCapitalMovement(plan.moves.reduce((a, m) => a + Math.abs(m.deltaUsd), 0));
        orch.markNormalizationApplied();
        RealTimeAuditLogger.getInstance().record(
          "CEX",
          "CAPITAL_NORMALIZATION",
          "PORTFOLIO",
          "REBALANCE_TO_POLICY",
          `Normalizacion de capital: retirado $${plan.overAllocatedUsd} de excedentes, reinyectado $${plan.underAllocatedUsd} en deficitarios, reserva neta $${plan.reserveDeltaUsd}. Movimientos: ${plan.moves.map((m) => `${m.ticker}:${m.deltaUsd > 0 ? "+" : ""}${m.deltaUsd}`).join(", ")}`,
          "INFO",
          { moves: plan.moves, reserveDeltaUsd: plan.reserveDeltaUsd, reserveTotalUsd: orch.getUnallocatedCashUsd() },
          orch.getExecutionMode()
        );
      }
    }

    // 4. Gestión DEX 100% DINÁMICA: Causal Risk Budgeting vía Jev & Laya
    // Cero constantes de "3 en 3": El número de pools y el apetito de riesgo lo modula Jev y Laya
    let maxDexSlots = 2; // Base por defecto
    if (appliedRegime === "AGGRESSIVE_ACCUMULATION") {
      maxDexSlots = 4; // En régimen expansivo y seguro, abrir hasta 4 bóvedas concentradas de alto rendimiento
    } else if (appliedRegime === "DEFENSIVE_STRESS") {
      maxDexSlots = 1; // En estrés o toxicidad, replegarse a 1 sola bóveda hiper-segura (Ancla BTC/ETH)
    } else {
      maxDexSlots = 3; // En balance, 2 a 3 bóvedas
    }

    const dexTotalPoolUsd = activeCapitalUsd * policy.dexPct;
    const pendingDex = orch.getPendingDexRestoration() || {};

    const poolsToOperate: PoolState[] = [];
    const seenSymbols = new Set<string>();

    // 4.1. Primero preservar posiciones preexistentes si ya estaban corriendo (hasta el límite de slots de Jev)
    for (const [key, saved] of Object.entries(pendingDex)) {
      if (poolsToOperate.length >= maxDexSlots) break;
      const pSym = (saved as any).pool || key;
      if (pSym && !seenSymbols.has(pSym)) {
        seenSymbols.add(pSym);
        poolsToOperate.push({
          symbol: pSym,
          chain: "Base",
          protocol: (saved as any).protocol || "Aerodrome Slipstream",
          price: (saved as any).price || 1.0,
          feeAprPct: (saved as any).feeAprPct || 100.0,
          volume24hUsd: 10_000_000,
          tvlUsd: 5_000_000,
        });
      }
    }

    // 4.2. Si faltan slots según el apetito de Jev, consultar dinámicamente DeFiLlama en Base L2
    if (poolsToOperate.length < maxDexSlots) {
      try {
        const livePools = await fetchTopBaseConcentratedPools(1_000_000, 1_000_000);
        // Filtrar pools en Base con liquidez robusta y APR > 30%
        const candidates = livePools.filter((p) => !seenSymbols.has(p.symbol) && p.feeAprPct > 30.0);
        for (const cand of candidates) {
          if (poolsToOperate.length >= maxDexSlots) break;

          // Si el régimen es DEFENSIVE_STRESS, prohibir pools de alto beta o exóticos
          if (appliedRegime === "DEFENSIVE_STRESS" && !cand.symbol.includes("BTC") && !cand.symbol.includes("CBBTC") && !cand.symbol.includes("WETH")) {
            continue;
          }

          seenSymbols.add(cand.symbol);
          poolsToOperate.push({
            symbol: cand.symbol,
            chain: "Base",
            protocol: cand.project === "aerodrome-slipstream" ? "Aerodrome Slipstream" : cand.project,
            price: cand.symbol.includes("BTC") || cand.symbol.includes("CBBTC") ? 84000.0 : 1.0,
            feeAprPct: cand.feeAprPct,
            volume24hUsd: cand.volume24hUsd,
            tvlUsd: cand.tvlUsd,
          });
        }
      } catch (err) {
        console.warn("[CAPITAL ALLOCATOR] Error consultando DeFiLlama en vivo:", err);
      }
    }

    // 4.1.b Congelamiento del universo DEX: los pools operables se fijan al inicio de la
    // ventana. La seleccion en vivo (DeFiLlama, APR > 30%) solo puede elegir dentro del
    // universo congelado; el resto queda registrado como bloqueado.
    if (isGenomeFrozen()) {
      const universe = loadUniverse();
      const { decision, admissions } = applyUniverseFreeze(
        poolsToOperate.map((p) => p.symbol),
        universe,
        "POOL",
        process.env.UNIVERSE_ALLOW_EXPANSION === "true"
      );
      if (decision.rejected.length > 0) {
        logUniverseAdmissions("POOL", decision.rejected, admissions);
      }
      if (universeExpanded(admissions)) {
        orch.recordWindowInvalidation(
          "UNIVERSE_EXPANSION",
          `Pools admitidos dentro de la ventana congelada: ${admissions.filter((a) => a.allowed).map((a) => a.key).join(", ")}`
        );
      }
      const allowedPools = new Set(decision.allowed);
      for (let i = poolsToOperate.length - 1; i >= 0; i--) {
        if (!allowedPools.has(poolsToOperate[i].symbol)) poolsToOperate.splice(i, 1);
      }
    }

    const dexCandidatesForWeights: AssetCandidate[] = poolsToOperate.map((p) => {      const isAnchor = p.symbol.includes("BTC") || p.symbol.includes("CBBTC");
      return {
        ticker: p.symbol,
        isAnchor,
        volatility: isAnchor ? 0.22 : 0.55,
        sortino: isAnchor ? 2.10 : 1.40,
        liquidityScore: Math.min(1.0, p.tvlUsd / 5_000_000),
      };
    });

    const dexAllocation = calculateDynamicRiskWeights(dexCandidatesForWeights, mapJevRegimeToRiskRegime(appliedRegime));

    // 4.3. Si el régimen macro se contrajo (ej. DEFENSIVE_STRESS o BALANCED)
    // podar posiciones excedentes que ya no caben en el presupuesto de riesgo de Jev
    const allowedPoolSymbols = new Set(poolsToOperate.map((p) => p.symbol));
    for (const [existingKey, existingItem] of dexPositions.entries()) {
      if (!allowedPoolSymbols.has(existingKey)) {
        // Cierre contable del slot: el capital modelado vuelve a la reserva capturada.
        // Antes el slot se borraba en silencio y su capital desaparecia de los libros
        // (perdida no contabilizada); combinado con la creacion sin debito producia
        // churn con deriva neta.
        const closingSnap = existingItem.engine.getSnapshot();
        const recoveredUsd = parseFloat((closingSnap.currentCapitalUsd || 0).toFixed(4));
        if (recoveredUsd > 0) {
          orch.addUnallocatedCash(recoveredUsd);
          orch.addCapitalMovement(recoveredUsd);
        }
        dexPositions.delete(existingKey);
        RealTimeAuditLogger.getInstance().record(
          "DEX",
          "CAPITAL_NORMALIZATION",
          existingKey,
          "DEX_SLOT_CLOSED",
          `Boveda DEX ${existingKey} cerrada por repliegue de regimen (${appliedRegime}: max ${maxDexSlots} slots). Capital devuelto a reserva: $${recoveredUsd}. Fees acumuladas en el slot: $${(closingSnap.accumulatedFeesUsd || 0).toFixed(4)}.`,
          "INFO",
          { key: existingKey, recoveredUsd, appliedRegime, reserveTotalUsd: orch.getUnallocatedCashUsd() },
          orch.getExecutionMode()
        );
        console.log(`[DEX PRUNING] Bóveda DEX ${existingKey} cerrada por repliegue causal (${appliedRegime}: máx ${maxDexSlots} slots). Capital $${recoveredUsd} devuelto a reserva.`);
      }
    }

    for (const pool of poolsToOperate) {
      const poolKey = pool.symbol; // Clave 100% real: el símbolo del pool
      if (!dexPositions.has(poolKey)) {
        const poolSharePct = dexAllocation.weights[poolKey] || (1 / poolsToOperate.length);
        const desiredCapitalUsd = dexTotalPoolUsd * poolSharePct;
        const isAnchor = pool.symbol.includes("BTC") || pool.symbol.includes("CBBTC");
        const reason = `Dynamic Risk Parity ${(poolSharePct * 100).toFixed(1)}% de $${dexTotalPoolUsd.toFixed(2)} USD (${isAnchor ? "Ancla Correlacionada" : "Yield Líquido"}, TVL: $${(pool.tvlUsd / 1e6).toFixed(2)}M)`;

        const prevDex = pendingDex[poolKey] || pendingDex[pool.symbol];

        // FINANCIACION SIN ACUÑAR: el capital de un slot nuevo se retira de la reserva
        // capturada. Antes se instanciaba el slot con `dexTotalPoolUsd * share` sin
        // debito alguno: cada creacion acuñaba capital y la normalizacion posterior lo
        // convertia en caja (139.66 USD de reserva inexistente en 2.9 dias).
        // Un slot restaurado de snapshot ya tiene su capital en el estado: no se debita
        // de nuevo (el par estado<->reserva ya venia cuadrando).
        let capitalForThisPool = desiredCapitalUsd;
        if (!prevDex) {
          const availableReserveUsd = Math.max(0, orch.getUnallocatedCashUsd());
          capitalForThisPool = Math.min(desiredCapitalUsd, availableReserveUsd);
          if (capitalForThisPool < 1) {
            console.log(
              `[DEX FUNDING SKIP] Reserva insuficiente para ${poolKey}: objetivo $${desiredCapitalUsd.toFixed(2)}, disponible $${availableReserveUsd.toFixed(2)}. No se acuña capital.`
            );
            continue;
          }
          orch.addUnallocatedCash(-capitalForThisPool);
          orch.addCapitalMovement(capitalForThisPool);
          RealTimeAuditLogger.getInstance().record(
            "DEX",
            "CAPITAL_NORMALIZATION",
            poolKey,
            "DEX_SLOT_FUNDED",
            `Slot DEX ${poolKey} financiado desde la reserva capturada: $${capitalForThisPool.toFixed(2)} de un objetivo de $${desiredCapitalUsd.toFixed(2)}. Reserva restante $${orch.getUnallocatedCashUsd().toFixed(2)}.`,
            capitalForThisPool < desiredCapitalUsd - 0.05 ? "WARN" : "INFO",
            { poolKey, fundedUsd: capitalForThisPool, desiredCapitalUsd, reserveTotalUsd: orch.getUnallocatedCashUsd() },
            orch.getExecutionMode()
          );
        }

        const engine = new ShadowLPEngine(pool, capitalForThisPool);

        // Restaurar si existía snapshot previo (el capital ya esta contabilizado)
        if (prevDex) {
          engine.restoreState(prevDex);
        }

        dexPositions.set(poolKey, {
          ticker: poolKey,
          pool,
          engine,
          allocationReason: reason,
        });

        const dexModeLabel = orch.getExecutionMode() === "LIVE" ? "Real" : "SIM";
        console.log(`[WATCHLIST SYNC] Activando posición DEX ${dexModeLabel}: ${pool.symbol} (${pool.protocol}) con $${capitalForThisPool.toFixed(2)} USD (${(poolSharePct * 100).toFixed(1)}% de DEX). Motivo: ${reason}`);
      }
    }

    // 4.b Normalizacion de capital DEX: alinear los slots con el presupuesto del regimen.
    // Los slots conservaban el capital con el que fueron creados bajo una politica previa,
    // de modo que el desplegado DEX excedia el objetivo (evidencia: 61.72 USD vs 40 de
    // politica, -21.61 de sobre-despliegue global). El retiro es contable en PAPER.
    if (poolsToOperate.length > 0 && dexPositions.size > 0) {
      const dexSlotsForPlan = Array.from(dexPositions.entries()).map(([key, item]) => {
        const snap = item.engine.getSnapshot();
        return {
          key,
          currentCapitalUsd: snap.currentCapitalUsd,
          initialCapitalUsd: snap.initialCapitalUsd,
        };
      });
      const dexPlan = this.canNormalize()
        ? planDexCapitalNormalization(dexSlotsForPlan, dexTotalPoolUsd, orch.getUnallocatedCashUsd(), 0.10)
        : { moves: [], reserveDeltaUsd: 0, overAllocatedUsd: 0, underAllocatedUsd: 0, unfundedDeficitUsd: 0 };
      if (dexPlan.moves.length > 0) {
        for (const move of dexPlan.moves) {
          const item = dexPositions.get(move.key);
          if (!item) continue;
          item.engine.restoreState({
            currentCapitalUsd: move.newCurrentCapitalUsd,
            initialCapitalUsd: move.newInitialCapitalUsd,
          });
        }
        orch.addUnallocatedCash(dexPlan.reserveDeltaUsd);
        orch.addCapitalMovement(dexPlan.moves.reduce((a, m) => a + Math.abs(m.deltaUsd), 0));
        orch.markNormalizationApplied();
        RealTimeAuditLogger.getInstance().record(
          "DEX",
          "CAPITAL_NORMALIZATION",
          "PORTFOLIO",
          "REBALANCE_TO_POLICY",
          `Normalizacion de capital DEX contra el objetivo de $${dexTotalPoolUsd.toFixed(2)}: sobre-asignado $${dexPlan.overAllocatedUsd}, sub-asignado $${dexPlan.underAllocatedUsd}, deficit no financiado $${dexPlan.unfundedDeficitUsd}. Reserva neta $${dexPlan.reserveDeltaUsd}.`,
          dexPlan.unfundedDeficitUsd > 0 ? "WARN" : "INFO",
          { moves: dexPlan.moves, dexPlan },
          orch.getExecutionMode()
        );
      }
    }
  }
}

/**
 * Registro (una sola vez por clave) de las admisiones bloqueadas por el congelamiento
 * del universo de medicion. Sin el deduplicado el audit log se llenaria en cada
 * sincronizacion de watchlist.
 */
const loggedUniverseBlocks = new Set<string>();

function logUniverseAdmissions(
  kind: "ASSET" | "POOL",
  rejected: string[],
  admissions: Array<{ key: string; reason: string; allowed: boolean }>
): void {
  const fresh = rejected.filter((k) => !loggedUniverseBlocks.has(`${kind}:${k}`));
  if (fresh.length === 0) return;
  for (const k of fresh) loggedUniverseBlocks.add(`${kind}:${k}`);
  const detail = admissions.find((a) => !a.allowed)?.reason ?? "universo congelado";
  console.log(
    `[UNIVERSE FREEZE] ${kind === "ASSET" ? "Activos" : "Pools"} fuera de la ventana bloqueados: ${fresh.join(", ")}. ${detail}`
  );
  RealTimeAuditLogger.getInstance().record(
    kind === "ASSET" ? "CEX" : "DEX",
    "CAPITAL_NORMALIZATION",
    "UNIVERSE",
    "UNIVERSE_ADMISSION_BLOCKED",
    `Admision bloqueada por congelamiento del universo: ${fresh.join(", ")}. ${detail}`,
    "INFO",
    { kind, blocked: fresh, reason: detail },
    "PAPER"
  );
}
