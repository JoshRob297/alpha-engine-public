/**
 * Orquestador Unificado Dinámico Multi-Activo (Alpha Engine)
 * Coordinador central delgado desacoplado en 5 módulos:
 * 1. CapitalAllocator: Paridad de riesgo causal, watchlist sync y optimización SETS.
 * 2. CexEngine: Loop táctico de microestructura CEX, Laya, OFI y gobernanza de salidas.
 * 3. DexEngine: Loop de provisión de liquidez en Base L2 y rotación holística.
 * 4. StatePersistenceManager: Persistencia atómica de estado en disco.
 * 5. HttpServerManager: API REST de telemetría y control para UI / Telegram.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Cargar secrets de Compute-node si existen en el entorno
try {
  const secretsPath = join(homedir(), ".env.secrets");
  if (existsSync(secretsPath)) {
    const lines = readFileSync(secretsPath, "utf-8").split("\n");
    for (const line of lines) {
      const match = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim();
      }
    }
  }
} catch {}

import { BinanceLiveDriver } from "../cex/binance-live-driver.js";
import { ShadowLPEngine, type PoolState } from "../dex/shadow-lp-simulator.js";
import { GridBot, type Genome } from "../genetic/bot.js";
import { type JevMarketJudgment } from "../guardrails/typesafe-jev-client.js";
import { loadActiveWatchlist } from "../research/watchlist-loader.js";
import { TradeLedger } from "../telemetry/trade-ledger.js";
import { setTradeContextProvider } from "../telemetry/trade-ledger.js";
import { buildTradeContext } from "../telemetry/trade-context.js";
import { RealAccountingLedger } from "../telemetry/real-accounting.js";
import { TelemetryLogger } from "../guardrails/telemetry-logger.js";
import { sendProactiveAlert } from "../telemetry/telegram-bot.js";
import { sendTelegramAlert } from "../telemetry/notifier.js";
import { getRegimePolicy } from "../guardrails/regime-policy.js";

import { StatePersistenceManager, STATE_FILE } from "./state-persistence.js";
import { auditCapitalConservation, auditReserveSlack } from "./capital-conservation.js";
import { initialAllocationRegimeState, type AllocationRegimeState } from "./regime-hysteresis.js";
import { appendEquitySample } from "./metrics-series.js";
import { HttpServerManager, HTTP_PORT } from "./http-server.js";
import { CexEngine } from "./cex-engine.js";
import { DexEngine } from "./dex-engine.js";
import { CapitalAllocator, DEFAULT_GENOME, BINANCE_PAIRS } from "./capital-allocator.js";
import { adaptEvolvedAtrGenome } from "../genetic/genome-adapter.js";
import { FuturesHedgeEngine } from "./futures-hedge-engine.js";
import { MemorySentinel } from "./memory-sentinel.js";
import { RiskGuard } from "./risk-guard.js";
import { RealTimeAuditLogger } from "../telemetry/audit-logger.js";
import { getMeasurementWindow, logMeasurementWindowBanner } from "../guardrails/measurement-window.js";

export interface ActiveCexBot {
  ticker: string;
  book: string;
  bot: GridBot;
  allocatedCashUsd: number;
  allocationReason: string;
  lastMidPrice?: number;
  priceHistory?: number[];
  lastOfiScore?: number;
  lastToxicFlow?: number;
  jevJudgment?: JevMarketJudgment;
  lastJevCheckTs?: number;
  partialTakenPct?: number;
  cooldownUntil?: number;
  postShockRecovery?: boolean;
  awaitingLayaRecovery?: boolean;
  /**
   * Fraccion de la profundidad del libro que esta DELANTE en la cola para los fills
   * pasivos (0 = primera en cola, 0.5 = default del modelo PAPER). Regula el fill
   * parcial de las ordenes maker.
   */
  paperQueueFactor?: number;
}

export interface ActiveDexPosition {
  ticker: string;
  pool: PoolState;
  engine: ShadowLPEngine;
  allocationReason?: string;
  lastRebalanceCheckTs?: number;
  lastPoolStatsTs?: number;
  lastTickTs?: number;
}

export class DynamicAlphaOrchestrator {
  private totalCapitalUsd: number;
  private cexBots: Map<string, ActiveCexBot> = new Map();
  private dexPositions: Map<string, ActiveDexPosition> = new Map();
  private isRunning = false;
  private lastEvolutionTs = 0;
  private pulseCount = 0;
  private startedAt = "2026-09-23T18:46:57.000Z";
  private activeGenomes: Map<string, Genome> = new Map();
  private telemetryLogger: TelemetryLogger = new TelemetryLogger();
  private ledger: TradeLedger = new TradeLedger(2000);
  private binanceDriver: BinanceLiveDriver = new BinanceLiveDriver();
  private persistenceManager: StatePersistenceManager = new StatePersistenceManager();
  private pendingCexRestoration: any = null;
  private pendingDexRestoration: any = null;
  private realLedger: RealAccountingLedger = new RealAccountingLedger();
  private riskGuard: RiskGuard = new RiskGuard({
    maxDailyLossUsd: parseFloat(process.env.RISK_MAX_DAILY_LOSS_USD || "3"),
    maxAggregateExposurePct: parseFloat(process.env.RISK_MAX_AGGREGATE_EXPOSURE_PCT || "0.70"),
    maxSingleAssetExposurePct: parseFloat(process.env.RISK_MAX_SINGLE_ASSET_EXPOSURE_PCT || "0.50"),
  });
  private lastTickAt: number = Date.now();
  /** Eventos de rebalanceo DEX observados en vivo (para cuadrar con el audit log). */
  private dexRebalanceEvents = 0;
  /** Caja retirada de circulacion por normalizacion de capital (bucket real, no etiqueta). */
  private unallocatedCashUsd = 0;
  /** Throttle del aviso de deriva contable de equity. */
  private lastEquityDriftAlertTs = 0;
  /** Regimen de asignacion de capital (lento: 12 h de persistencia para mover buckets). */
  private allocationRegime: AllocationRegimeState = initialAllocationRegimeState();
  /** Timestamp de la ultima normalizacion de capital aplicada (rate limit). */
  private lastNormalizationTs = 0;
  /** Reparaciones de conservacion aplicadas (telemetria del invariante). */
  private conservationRepairs = 0;
  /** Capital movido entre buckets (suma de valores absolutos): metrica de churn. */
  private capitalMovedTotalUsd = 0;
  /** Motivos por los que la ventana OOS dejo de ser comparable (persistido en el payload). */
  private windowInvalidations: Array<{ ts: string; reason: string; detail: string }> = [];
  private invalidationKeys = new Set<string>();
  /** Ultima muestra registrada en la serie temporal de equity. */
  private lastEquitySampleTs = 0;
  /** Throttle del aviso de holgura no etiquetada. */
  private lastSlackAlertTs = 0;
  private executionMode: "PAPER" | "LIVE" = (process.env.EXECUTION_MODE as "PAPER" | "LIVE") || "PAPER";
  private liveTradingEnabled: boolean = process.env.LIVE_TRADING_ENABLED === "true";
  private totalSimulationCapitalUsd: number = parseFloat(process.env.SIMULATION_CAPITAL_USD || "200");

  // Sub-motores desacoplados
  private cexEngine: CexEngine;
  private dexEngine: DexEngine;
  private futuresHedgeEngine: FuturesHedgeEngine;
  private capitalAllocator: CapitalAllocator;
  private httpServerManager: HttpServerManager;

  constructor(totalSimulationCapitalUsd = 200) {
    this.totalSimulationCapitalUsd = parseFloat(process.env.SIMULATION_CAPITAL_USD || String(totalSimulationCapitalUsd));
    this.totalCapitalUsd = this.totalSimulationCapitalUsd;

    this.cexEngine = new CexEngine(this);
    this.dexEngine = new DexEngine(this);
    this.futuresHedgeEngine = new FuturesHedgeEngine();
    this.capitalAllocator = new CapitalAllocator(this);
    this.httpServerManager = new HttpServerManager(this, HTTP_PORT);

    this.loadInitialState();
    this.registerTradeContextProvider();
    this.startProactiveWatcher();
  }

  /**
   * Registra el proveedor de provenance: cada cierre del ledger queda con el contexto
   * de la decision (regimen, OFI, toxicidad, juicio de Laya, huella del genoma, modelo
   * de IL y version del motor).
   */
  private registerTradeContextProvider(): void {
    setTradeContextProvider((trade) => {
      const appliedRegime = this.allocationRegime.applied || undefined;
      if (trade.venue === "BASE_DEX") {
        const pool = trade.assetOrPool;
        const dexItem = Array.from(this.dexPositions.entries()).find(([key]) => key === pool);
        const snap = dexItem ? dexItem[1].engine.getSnapshot() : null;
        return buildTradeContext({
          appliedRegime,
          assetRegime: appliedRegime,
          layaToxicFlow: undefined,
        });
      }
      const ticker =
        Object.keys(BINANCE_PAIRS).find((t) => BINANCE_PAIRS[t] === trade.assetOrPool) ||
        trade.assetOrPool.replace(/USDT$|USDC$/, "");
      const item = this.cexBots.get(ticker);
      if (!item) return buildTradeContext({ appliedRegime });
      return buildTradeContext({
        appliedRegime,
        assetRegime: item.jevJudgment?.regime,
        jevConfidence: (item.jevJudgment as any)?.confidence,
        ofiScore: item.lastOfiScore,
        toxicFlow: item.lastToxicFlow,
        genome: this.activeGenomes.get(ticker),
        partialTakenPct: item.partialTakenPct,
      });
    });
  }

  // Cooldowns para alertas proactivas Telegram
  private lastPfRedAlertTs = 0;
  private cexPausedAlertTs: Map<string, number> = new Map();
  private cexPausedSince: Map<string, number> = new Map();
  private dexPausedAlertTs: Map<string, number> = new Map();
  private dexPausedSince: Map<string, number> = new Map();

  private startProactiveWatcher() {
    // Watcher en segundo plano cada 60 segundos
    setInterval(async () => {
      try {
        const now = Date.now();

        // 1. Alerta de Semáforo de Profit Factor -> RED
        const metrics = this.ledger.calculateMetrics(this.totalCapitalUsd);
        if (metrics.profitFactor < 0.75 && metrics.totalTrades >= 5) {
          if (now - this.lastPfRedAlertTs > 30 * 60_000) {
            this.lastPfRedAlertTs = now;
            await sendProactiveAlert("SISTEMA EN RIESGO: PROFIT FACTOR CRITICO", [
              `• Señal: <b>RED</b>`,
              `• Profit Factor: <code>${metrics.profitFactor.toFixed(2)}</code>`,
              `• Win Rate: <code>${metrics.winRatePct.toFixed(1)}%</code>`,
              `• Trades Evaluados: <code>${metrics.totalTrades}</code> (${metrics.winningTrades}W / ${metrics.losingTrades}L)`,
              `• Accion recomendada: Auditar toxicidad o evaluar recalibracion SETS`,
            ]);
          }
        }

        // 2. Alerta de Posición CEX en PAUSED con posición abierta por >30 min
        for (const [ticker, item] of this.cexBots.entries()) {
          const isPaused = item.bot.circuitBreakerActive;
          const inPos = item.bot.inPos;

          if (isPaused && inPos) {
            if (!this.cexPausedSince.has(ticker)) {
              this.cexPausedSince.set(ticker, now);
            }
            const pausedDurationMs = now - (this.cexPausedSince.get(ticker) || now);
            const lastAlert = this.cexPausedAlertTs.get(ticker) || 0;

            if (pausedDurationMs >= 30 * 60_000 && now - lastAlert > 60 * 60_000) {
              this.cexPausedAlertTs.set(ticker, now);
              const durationMin = Math.round(pausedDurationMs / 60_000);
              const toxicPct = ((item.lastToxicFlow || 0) * 100).toFixed(1);
              const ofiPct = ((item.lastOfiScore || 0) * 100).toFixed(1);

              await sendProactiveAlert(`CEX: POSICION PAUSADA PROLONGADA (${ticker})`, [
                `• Activo: <b>${ticker}</b> (${item.book})`,
                `• Tiempo en Pausa: <code>${durationMin} min</code> con posicion abierta`,
                `• Flujo Toxico (Laya): <code>${toxicPct}%</code>`,
                `• OFI Score: <code>${ofiPct}%</code>`,
                `• Regimen Jev: <code>${item.jevJudgment?.regime || "DESCONOCIDO"}</code>`,
                `• Precio Actual: $${(item.lastMidPrice || item.bot.avg).toFixed(2)} USD`,
                `• Hard Stop Protegido: $${item.bot.stop.toFixed(2)} USD`,
              ]);
            }
          } else {
            this.cexPausedSince.delete(ticker);
          }
        }

        // 3. Alerta de Posición DEX en DEFENSIVE_PAUSE por >10 min
        for (const [ticker, item] of this.dexPositions.entries()) {
          const snap = item.engine.getSnapshot();
          const isDexPaused = snap.status === "PAUSED_DEFENSIVE";

          if (isDexPaused) {
            if (!this.dexPausedSince.has(ticker)) {
              this.dexPausedSince.set(ticker, now);
            }
            const pausedDurationMs = now - (this.dexPausedSince.get(ticker) || now);
            const lastAlert = this.dexPausedAlertTs.get(ticker) || 0;

            if (pausedDurationMs >= 10 * 60_000 && now - lastAlert > 30 * 60_000) {
              this.dexPausedAlertTs.set(ticker, now);
              const durationMin = Math.round(pausedDurationMs / 60_000);

              await sendProactiveAlert(`DEX: PROVISION LP EN PAUSA DEFENSIVA (${item.pool.symbol})`, [
                `• Pool: <b>${item.pool.symbol}</b> en Base L2`,
                `• Tiempo Fuera de Rango: <code>${durationMin} min</code>`,
                `• Capital Asignado: $${(snap.currentCapitalUsd || 0).toFixed(2)} USD`,
                `• Rango Concentrado: [${(snap.lowerRangePrice || 0).toFixed(4)} - ${(snap.upperRangePrice || 0).toFixed(4)}]`,
                `• Precio Spot Actual: ${(item.pool.price || 0).toFixed(4)}`,
                `• Accion Automatica: Evaluando rotacion holistica hacia pool alternativo`,
              ]);
            }
          } else {
            this.dexPausedSince.delete(ticker);
          }
        }
      } catch (err) {
        console.error("[PROACTIVE WATCHER ERROR]:", err);
      }
    }, 60_000);
  }

  private loadInitialState() {
    // 1. Cargar genomas evolucionados bicentenarios (BTC, SOL, AVAX, SUI)
    try {
      const genomePath = existsSync("./data/evolved_atr_genomes.json")
        ? "./data/evolved_atr_genomes.json"
        : existsSync("/home/user/proyectos/alpha-engine/data/evolved_atr_genomes.json")
        ? "/home/user/proyectos/alpha-engine/data/evolved_atr_genomes.json"
        : null;

      if (genomePath) {
        const raw = readFileSync(genomePath, "utf-8");
        const parsedGenomes = JSON.parse(raw);
        if (parsedGenomes.bestBtc) this.activeGenomes.set("BTC", adaptEvolvedAtrGenome(parsedGenomes.bestBtc));
        if (parsedGenomes.bestSol) this.activeGenomes.set("SOL", adaptEvolvedAtrGenome(parsedGenomes.bestSol));
        if (parsedGenomes.bestAvax) this.activeGenomes.set("AVAX", adaptEvolvedAtrGenome(parsedGenomes.bestAvax));
        if (parsedGenomes.bestSui) this.activeGenomes.set("SUI", adaptEvolvedAtrGenome(parsedGenomes.bestSui));
        console.log(`[GENOMES LOADED] Genomas bicentenarios cargados para: ${Array.from(this.activeGenomes.keys()).join(", ")}`);
      }
    } catch (err) {
      console.warn("[GENOMES LOAD WARNING] No se pudieron cargar genomas bicentenarios:", err);
    }

    // 2. Restaurar estado de persistencia
    const parsed = this.persistenceManager.load();
    if (parsed) {
      if (typeof parsed.pulseCount === "number") this.pulseCount = parsed.pulseCount;
      if (typeof parsed.startedAt === "string") this.startedAt = parsed.startedAt;
      if (Array.isArray(parsed.history)) this.ledger.loadHistory(parsed.history);
      if (parsed.cex && typeof parsed.cex === "object") this.pendingCexRestoration = parsed.cex;
      if (parsed.dex && typeof parsed.dex === "object") this.pendingDexRestoration = parsed.dex;
      if (typeof parsed.unallocatedCashUsd === "number") this.unallocatedCashUsd = parsed.unallocatedCashUsd;
      if (parsed.regimeHysteresis && typeof parsed.regimeHysteresis === "object") {
        const h = parsed.regimeHysteresis as any;
        const applied = typeof h.applied === "string" ? h.applied : null;
        const candidate = typeof h.candidate === "string" ? h.candidate : typeof h.observed === "string" ? h.observed : applied;
        this.allocationRegime = {
          applied,
          candidate,
          candidateSinceMs: typeof h.candidateSinceMs === "number" ? h.candidateSinceMs : typeof h.changedAtMs === "number" ? h.changedAtMs : Date.now(),
          changedAtMs: typeof h.changedAtMs === "number" ? h.changedAtMs : Date.now(),
          persistedMs: typeof h.persistedMs === "number" ? h.persistedMs : 0,
        };
      }
      if (typeof parsed.dexRebalanceEventsTotal === "number") this.dexRebalanceEvents = parsed.dexRebalanceEventsTotal;
      if (typeof parsed.conservationRepairs === "number") this.conservationRepairs = parsed.conservationRepairs;
      if (typeof parsed.capitalMovedTotalUsd === "number") this.capitalMovedTotalUsd = parsed.capitalMovedTotalUsd;
      if (Array.isArray(parsed.windowInvalidations)) {
        this.windowInvalidations = parsed.windowInvalidations
          .filter((e: any) => e && typeof e.reason === "string")
          .slice(-50);
      }
      if (parsed.futuresHedge && Array.isArray(parsed.futuresHedge.positions)) {
        this.futuresHedgeEngine.restorePositions(parsed.futuresHedge.positions);
      }
    }
  }

  // Getters para los sub-motores
  public getCexBots() { return this.cexBots; }
  public getDexPositions() { return this.dexPositions; }
  public getCexEngine() { return this.cexEngine; }
  public getDexEngine() { return this.dexEngine; }
  public getCapitalAllocator() { return this.capitalAllocator; }
  public getHttpServerManager() { return this.httpServerManager; }
  public getActiveGenomes() { return this.activeGenomes; }
  public getTelemetryLogger() { return this.telemetryLogger; }
  public getLedger() { return this.ledger; }
  public getRealLedger() { return this.realLedger; }
  public getRiskGuard() { return this.riskGuard; }
  public isRiskKilled() { return this.riskGuard.isKilled(); }
  public getLastTickAt() { return this.lastTickAt; }
  public getBinanceDriver() { return this.binanceDriver; }
  public getExecutionMode() { return this.executionMode; }

  /** Cuenta un rebalanceo DEX real observado (cuadre con el audit log). */
  public recordDexRebalance() {
    this.dexRebalanceEvents++;
  }

  public getDexRebalanceEvents() { return this.dexRebalanceEvents; }

  public getUnallocatedCashUsd() { return this.unallocatedCashUsd; }

  public addUnallocatedCash(deltaUsd: number) {
    this.unallocatedCashUsd = parseFloat((this.unallocatedCashUsd + deltaUsd).toFixed(4));
  }

  public getAllocationRegime(): AllocationRegimeState {
    return { ...this.allocationRegime };
  }

  public setAllocationRegime(state: AllocationRegimeState) {
    this.allocationRegime = state;
  }

  public getLastNormalizationTs(): number {
    return this.lastNormalizationTs;
  }

  public markNormalizationApplied(ts = Date.now()) {
    this.lastNormalizationTs = ts;
  }

  public getConservationRepairs(): number {
    return this.conservationRepairs;
  }

  /** Acumula capital movido entre buckets (metrica de churn para el reporte). */
  public addCapitalMovement(usd: number) {
    const v = Math.abs(usd || 0);
    this.capitalMovedTotalUsd = parseFloat((this.capitalMovedTotalUsd + v).toFixed(4));
  }

  public getCapitalMovedTotalUsd(): number {
    return this.capitalMovedTotalUsd;
  }

  /**
   * Marca la ventana de medicion como no comparable (invalidez de muestra). Se registra
   * en el estado y en el audit log: el reporte lo expone como `windowValid=false`.
   * Deduplicado por razon + hora para no inundar el log.
   */
  public recordWindowInvalidation(reason: string, detail: string) {
    const hourBucket = new Date().toISOString().slice(0, 13);
    const key = `${reason}:${hourBucket}`;
    if (this.invalidationKeys.has(key)) return;
    this.invalidationKeys.add(key);
    const entry = { ts: new Date().toISOString(), reason, detail };
    this.windowInvalidations.push(entry);
    if (this.windowInvalidations.length > 50) this.windowInvalidations.shift();
    RealTimeAuditLogger.getInstance().record(
      "SYS",
      "CAPITAL_CONSERVATION",
      "PORTFOLIO",
      "WINDOW_INVALIDATION",
      `Ventana de medicion invalidada (${reason}): ${detail}`,
      "CRITICAL",
      entry,
      this.executionMode
    );
  }

  public getWindowInvalidations(): Array<{ ts: string; reason: string; detail: string }> {
    return this.windowInvalidations;
  }

  public setUnallocatedCashUsd(valueUsd: number) {
    this.unallocatedCashUsd = parseFloat((valueUsd || 0).toFixed(4));
  }
  public isLiveTradingEnabled() { return this.liveTradingEnabled; }
  public getTotalSimulationCapitalUsd() { return this.totalSimulationCapitalUsd; }
  public getTotalCapitalUsd() { return this.totalCapitalUsd; }
  public getLastEvolutionTs() { return this.lastEvolutionTs; }
  public setLastEvolutionTs(ts: number) { this.lastEvolutionTs = ts; }
  public getPendingCexRestoration() { return this.pendingCexRestoration; }
  public getPendingDexRestoration() { return this.pendingDexRestoration; }
  public getStateFilePath() { return this.persistenceManager.getFilePath(); }

  public getActiveCexTickers(): string[] { return Array.from(this.cexBots.keys()); }
  public getActiveDexTickers(): string[] { return Array.from(this.dexPositions.keys()); }

  public pausePaper(): void {
    for (const item of this.cexBots.values()) item.bot.circuitBreakerActive = true;
    for (const item of this.dexPositions.values()) item.engine.pause();
  }

  public resumePaper(): void {
    for (const item of this.cexBots.values()) item.bot.circuitBreakerActive = false;
    for (const item of this.dexPositions.values()) item.engine.resume();
  }

  public cancelLiveOrders(): void {
    if (this.binanceDriver.isConfigured()) {
      this.binanceDriver.getOpenOrders().then((orders) => {
        for (const o of orders) {
          this.binanceDriver.cancelOrder(o.symbol, o.orderId).catch(() => {});
        }
      }).catch(() => {});
    }
  }

  public async flattenPaperPositions(): Promise<void> {
    for (const item of this.cexBots.values()) {
      if (!item.bot.inPos) continue;
      let bid = item.lastMidPrice || 0;
      const symbol = BINANCE_PAIRS[item.ticker];
      if (symbol) {
        try {
          const r = await fetch(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=5`);
          const d = await r.json();
          bid = parseFloat(d?.bids?.[0]?.[0] || "0") || bid;
        } catch {}
      }
      item.bot._close(bid > 0 ? bid : item.bot.avg, 0, "EMERGENCY_FLATTEN");
    }
    this.savePersistentState();
  }

  public async reEvolveGenome(ticker = "BTC"): Promise<boolean> {
    return this.capitalAllocator.evaluateReactiveEvolution(ticker, "ESTRÉS");
  }

  public async syncWithWatchlist(): Promise<void> {
    return this.capitalAllocator.syncWithWatchlist();
  }

  public savePersistentState() {
    const cexSummary: any = {};
    for (const [ticker, item] of this.cexBots.entries()) {
      const currentPrice = item.lastMidPrice || item.bot.avg || 0;
      let unrealizedPnlUsd = 0;
      let unrealizedPnlPct = 0;

      if (item.bot.inPos && item.bot.avg > 0 && currentPrice > 0) {
        // qty en crypto y precios en USD (Binance Spot nativo)
        unrealizedPnlUsd = item.bot.qty * (currentPrice - item.bot.avg);
        unrealizedPnlPct = ((currentPrice - item.bot.avg) / item.bot.avg) * 100;
      }

      const inventoryCostUsd = item.bot.qty * (item.bot.avg || 0);
      const inventoryCurrentValueUsd = item.bot.qty * currentPrice;
      const openOrdersUsd = (item.bot.levels || [])
        .filter((lvl) => !lvl.filled && lvl.price && lvl.price > 0)
        .reduce((sum, lvl) => sum + (lvl.usd || 0), 0);
      const idleCashUsd = item.bot.cash || 0;
      // NAV = caja + inventario a mercado.
      // Las ordenes en reposo NO se suman: su USD sigue dentro de la caja (el fill es
      // quien debita `cash`, ver GridBot._fill), asi que sumarlas contaba el mismo
      // dinero dos veces e inflaba el NAV de cada bot.
      const realNavUsd = idleCashUsd + inventoryCurrentValueUsd;

      cexSummary[ticker] = {
        book: item.book,
        cashUsd: item.bot.cash,
        idleCashUsd: parseFloat(idleCashUsd.toFixed(2)),
        openOrdersUsd: parseFloat(openOrdersUsd.toFixed(2)),
        // Ordenes en reposo: informativo, ya incluidas dentro de idleCashUsd.
        restingOrdersUsd: parseFloat(openOrdersUsd.toFixed(2)),
        inventoryCostUsd: parseFloat(inventoryCostUsd.toFixed(2)),
        inventoryCurrentValueUsd: parseFloat(inventoryCurrentValueUsd.toFixed(2)),
        realNavUsd: parseFloat(realNavUsd.toFixed(2)),
        qty: item.bot.qty,
        inPos: item.bot.inPos,
        avgPrice: item.bot.avg,
        lastPrice: currentPrice,
        unrealizedPnlUsd: parseFloat(unrealizedPnlUsd.toFixed(4)),
        unrealizedPnlPct: parseFloat(unrealizedPnlPct.toFixed(2)),
        allocationReason: item.allocationReason,
        allocatedCashUsd: item.allocatedCashUsd,
        ofiScore: item.lastOfiScore ?? null,
        toxicFlow: item.lastToxicFlow ?? null,
        status: item.bot.circuitBreakerActive ? "PAUSED" : "ACTIVE",
        exposurePct: item.bot.currentExposureCap,
        jevRegime: item.jevJudgment?.regime || "BALANCED_RANGE",
        jevConfidence: item.jevJudgment?.confidence || 0.75,
        tpPrice: item.bot.tp,
        stopPrice: item.bot.stop,
        priceHistory: item.priceHistory ? [...item.priceHistory] : [],
        levels: (item.bot.levels || []).map((lvl) => ({
          name: lvl.name,
          price: lvl.price,
          amountUsd: lvl.usd,
          filled: lvl.filled,
        })),
      };
    }

    const dexSummary: any = {};
    let dexIlTotal = 0;
    let dexGasTotal = 0;
    let dexFeesTotalPersisted = 0;
    let dexIlFullRangeTotal = 0;
    let dexInitialCapitalTotal = 0;
    for (const [ticker, item] of this.dexPositions.entries()) {
      const snap = item.engine.getSnapshot();
      dexIlTotal += snap.impermanentLossUsd || 0;
      dexIlFullRangeTotal += snap.impermanentLossFullRangeUsd || 0;
      dexGasTotal += snap.gasSpentUsd || 0;
      dexFeesTotalPersisted += snap.accumulatedFeesUsd || 0;
      dexInitialCapitalTotal += snap.initialCapitalUsd || 0;
      dexSummary[ticker] = {
        pool: item.pool.symbol,
        protocol: item.pool.protocol,
        feeAprPct: item.pool.feeAprPct,
        price: item.pool.price,
        initialCapitalUsd: parseFloat((snap.initialCapitalUsd || 0).toFixed(4)),
        currentCapitalUsd: parseFloat((snap.currentCapitalUsd || 0).toFixed(4)),
        accumulatedFeesUsd: parseFloat((snap.accumulatedFeesUsd || 0).toFixed(4)),
        impermanentLossUsd: parseFloat((snap.impermanentLossUsd || 0).toFixed(4)),
        gasSpentUsd: parseFloat((snap.gasSpentUsd || 0).toFixed(4)),
        // PnL neto real del slot: fees - IL - gas (lo que el LP gana o pierde de verdad)
        netPnlUsd: parseFloat(
          ((snap.accumulatedFeesUsd || 0) - (snap.impermanentLossUsd || 0) - (snap.gasSpentUsd || 0)).toFixed(4)
        ),
        status: snap.status,
        allocationReason: item.allocationReason,
        entryPrice: snap.entryPrice,
        lowerRangePrice: snap.lowerRangePrice,
        upperRangePrice: snap.upperRangePrice,
        totalRebalances: snap.totalRebalances,
        defensivePauses: snap.defensivePauses,
      };
    }

    // Determinar régimen macro predominante para computar la política de asignación
    let macroRegime = "BALANCED_RANGE";
    const regCounts: Record<string, number> = {};
    for (const [, item] of this.cexBots.entries()) {
      const reg = item.jevJudgment?.regime || "BALANCED_RANGE";
      regCounts[reg] = (regCounts[reg] || 0) + 1;
    }
    for (const [r, count] of Object.entries(regCounts)) {
      if (count > (regCounts[macroRegime] || 0)) {
        macroRegime = r;
      }
    }
    const policy = getRegimePolicy(macroRegime);

    const fiatReservePct = policy.fiatPct;
    const fiatReserveUsd = this.totalSimulationCapitalUsd * fiatReservePct;
    const activeCapitalUsd = this.totalSimulationCapitalUsd * (1 - fiatReservePct);
    const cexPoolUsd = activeCapitalUsd * policy.cexPct;
    const dexPoolUsd = activeCapitalUsd * policy.dexPct;

    const macroAllocation = {
      totalSimulationCapitalUsd: this.totalSimulationCapitalUsd,
      predominantRegime: macroRegime,
      appliedRegime: this.allocationRegime.applied || macroRegime,
      allocationRegimePersistedMs: this.allocationRegime.persistedMs,
      allocationRegimeCandidate: this.allocationRegime.candidate,
      fiatReserve: {
        usd: fiatReserveUsd,
        pct: fiatReservePct * 100,
        book: "USDT",
        reason: `Régimen ${macroRegime}: ${(fiatReservePct * 100).toFixed(0)}% de caja defensiva líquida en reserva USDT.`,
      },
      cexAllocation: {
        usd: cexPoolUsd,
        pct: (cexPoolUsd / this.totalSimulationCapitalUsd) * 100,
        reason: `${(policy.cexPct * 100).toFixed(0)}% del capital activo a mallas spot Binance (${macroRegime}).`,
      },
      dexAllocation: {
        usd: dexPoolUsd,
        pct: (dexPoolUsd / this.totalSimulationCapitalUsd) * 100,
        reason: `${(policy.dexPct * 100).toFixed(0)}% del capital activo a provisión LP en Aerodrome (${macroRegime}).`,
      },
      rationale: policy.rationale,
    };

    let totalAccruedDexFees = 0;
    let weightedDexAprSum = 0;
    let totalDexAllocated = 0;
    for (const [, item] of this.dexPositions.entries()) {
      const snap = item.engine.getSnapshot();
      totalAccruedDexFees += snap.accumulatedFeesUsd || 0;
      const cap = snap.currentCapitalUsd || 1;
      weightedDexAprSum += item.pool.feeAprPct * cap;
      totalDexAllocated += cap;
    }
    const dynamicWeightedApr = totalDexAllocated > 0 ? weightedDexAprSum / totalDexAllocated : 68.92;

    // Calculo del PnL latente (unrealized PnL) de posiciones CEX abiertas
    let openPositionPnlUsd = 0;
    for (const [, item] of this.cexBots.entries()) {
      if (item.bot.inPos && item.lastMidPrice && item.bot.avg > 0 && item.bot.qty > 0) {
        openPositionPnlUsd += (item.lastMidPrice - item.bot.avg) * item.bot.qty;
      }
    }

    // === RECONCILIACION DE EQUITY (fuente unica de verdad) ===
    // Valor liquidable por componente, todos ya persistidos en el estado:
    //   - cexNavTotal: caja inmovilizada + ordenes abiertas + inventario a mercado
    //   - dexCapitalTotal: capital actual del slot (ya incluye fees - IL - gas)
    // La formula legacy (totalCapitalUsd + openPnl + dexFees) contaba dos veces las
    // fees DEX y omitia el realizado del CEX: se conserva solo para medir el desvio.
    const cexNavTotal = Object.values(cexSummary as Record<string, any>).reduce(
      (acc: number, c: any) => acc + (c.realNavUsd || 0),
      0
    );
    const dexCapitalTotal = parseFloat(totalDexAllocated.toFixed(4));
    const deployedValueUsd = parseFloat((cexNavTotal + dexCapitalTotal).toFixed(2));
    const dexNetPnlTotal = parseFloat((dexFeesTotalPersisted - dexIlTotal - dexGasTotal).toFixed(4));

    const portfolioMetricsEarly = this.ledger.calculateMetrics(
      this.totalCapitalUsd,
      this.totalCapitalUsd,
      undefined,
      totalAccruedDexFees,
      dynamicWeightedApr
    );
    const realizedNetUsd = portfolioMetricsEarly.netPnlAfterCostsUsd || 0;

    // === REPARACION DE CONSERVACION ===
    // La reserva capturada es una ETIQUETA, no una posicion. El total contable
    // confiable es capital + PnL realizado - desplegado; si la etiqueta lo excede,
    // hay capital inexistente en los libros. Se repara al valor real y se registra
    // el evento: la magnitud del exceso es la metrica del defecto.
    const conservation = auditCapitalConservation({
      capitalUsd: this.totalCapitalUsd,
      realizedNetUsd,
      deployedValueUsd,
      capturedReserveUsd: this.unallocatedCashUsd,
    });
    if (conservation.needsRepair && process.env.CAPITAL_AUTOREPAIR !== "false") {
      const beforeUsd = this.unallocatedCashUsd;
      this.setUnallocatedCashUsd(conservation.repairToUsd);
      this.conservationRepairs++;
      this.recordWindowInvalidation(
        "CAPITAL_REPAIR",
        `Etiqueta de reserva ${beforeUsd.toFixed(2)} contra caja real ${conservation.totalCashUsd.toFixed(2)}: exceso ${conservation.overshootUsd.toFixed(2)} (${conservation.overshootPct}% del capital).` +
          ` La muestra previa no es comparable contablemente.`
      );
      if (Date.now() - this.lastEquityDriftAlertTs > 1_800_000) {
        this.lastEquityDriftAlertTs = Date.now();
        RealTimeAuditLogger.getInstance().record(
          "SYS",
          "CAPITAL_CONSERVATION",
          "PORTFOLIO",
          "CAPITAL_REPAIR",
          `Reserva capturada reparada: la etiqueta declaraba $${beforeUsd.toFixed(2)} pero la caja existente es $${conservation.totalCashUsd.toFixed(2)} (capital $${this.totalCapitalUsd} + PnL realizado $${realizedNetUsd.toFixed(2)} - desplegado $${deployedValueUsd}). Exceso retirado $${conservation.overshootUsd.toFixed(2)} (${conservation.overshootPct}% del capital). Causa tipica: credito de reserva sin debito del bucket origen (creacion de slots DEX sin financiar).`,
          "CRITICAL",
          { ...conservation, beforeUsd, repairsTotal: this.conservationRepairs },
          this.executionMode
        );
      }
    }

    // INVARIANTE CONTABLE (formulacion honesta):
    // El simulador tiene tres estados de dinero: desplegado (bots + slots), reserva
    // capturada por normalizacion, y caja no desplegada. La caja no desplegada es un
    // RESIDUO derivado: capital + PnL realizado - desplegado - reserva capturada.
    // Asi la identidad se cumple por construccion y lo unico que puede romperse es el
    // signo del residuo (capital desplegado que no existe = capital fantasma).
    const untradedReserveUsd = parseFloat(
      (this.totalCapitalUsd + realizedNetUsd - deployedValueUsd - this.unallocatedCashUsd).toFixed(2)
    );
    const simEquityUsd = parseFloat((deployedValueUsd + untradedReserveUsd + this.unallocatedCashUsd).toFixed(2));
    const policyReserveTargetUsd = parseFloat(fiatReserveUsd.toFixed(2));
    const policyActiveTargetUsd = parseFloat((this.totalCapitalUsd - policyReserveTargetUsd).toFixed(2));
    const underDeploymentVsPolicyUsd = parseFloat((policyActiveTargetUsd - deployedValueUsd).toFixed(2));
    const phantomCapitalUsd = untradedReserveUsd < 0 ? untradedReserveUsd : 0;

    // Holgura no etiquetada: senal complementaria al invariante (ver auditReserveSlack).
    const slack = auditReserveSlack(untradedReserveUsd, this.totalCapitalUsd, fiatReserveUsd);
    if (slack.suspicious && Date.now() - this.lastSlackAlertTs > 1_800_000) {
      this.lastSlackAlertTs = Date.now();
      RealTimeAuditLogger.getInstance().record(
        "SYS",
        "CAPITAL_CONSERVATION",
        "PORTFOLIO",
        "UNALLOCATED_SLACK",
        `Holgura no etiquetada de $${untradedReserveUsd} (umbral $${slack.thresholdUsd}): hay caja sin asignar por encima de lo esperado, lo que vuelve ciego al invariante para acuñamientos menores a esa holgura.`,
        "WARN",
        { untradedReserveUsd, thresholdUsd: slack.thresholdUsd, excessUsd: slack.excessUsd, unallocatedCashUsd: this.unallocatedCashUsd },
        this.executionMode
      );
    }

    const equityReconciled = simEquityUsd;
    const equityLegacy = parseFloat((this.totalCapitalUsd + openPositionPnlUsd + totalAccruedDexFees).toFixed(2));
    const equityDriftUsd = parseFloat((deployedValueUsd - equityLegacy).toFixed(2));
    const equityDriftPct = parseFloat(((equityDriftUsd / this.totalCapitalUsd) * 100).toFixed(3));

    // Alarma 1 (CRITICO): capital fantasma (se desplego mas dinero del que existe).
    // Alarma 2 (WARN): sobre-despliegue contra la politica (riesgo real de sizing).
    // Sub-despliegue: INFO, no es peligroso y suele ser estructural (no se acuna capital).
    const overDeployed = underDeploymentVsPolicyUsd < 0;
    const equityAlertReason =
      untradedReserveUsd < 0
        ? `Capital fantasma: caja no desplegada negativa ($${untradedReserveUsd}). El desplegado excede capital+PnL.`
        : Math.abs(underDeploymentVsPolicyUsd) > this.totalCapitalUsd * 0.05
        ? `Politica de regimen vs despliegue real: desplegado $${deployedValueUsd} contra objetivo activo $${policyActiveTargetUsd} (${overDeployed ? "SOBRE" : "sub"}-despliegue de $${Math.abs(underDeploymentVsPolicyUsd)}). Sobre-despliegue = riesgo de sizing; sub-despliegue suele ser estructural (no se acuna capital para financiarlo).`
        : null;
    if (equityAlertReason && Date.now() - this.lastEquityDriftAlertTs > 1_800_000) {
      this.lastEquityDriftAlertTs = Date.now();
      RealTimeAuditLogger.getInstance().record(
        "SYS",
        "CAPITAL_CONSERVATION",
        "PORTFOLIO",
        untradedReserveUsd < 0 ? "PHANTOM_CAPITAL" : overDeployed ? "POLICY_OVER_DEPLOY" : "POLICY_UNDER_DEPLOY",
        equityAlertReason,
        untradedReserveUsd < 0 ? "CRITICAL" : overDeployed ? "WARN" : "INFO",
        {
          deployedValueUsd,
          untradedReserveUsd,
          unallocatedCashUsd: this.unallocatedCashUsd,
          policyActiveTargetUsd,
          policyReserveTargetUsd,
          underDeploymentVsPolicyUsd,
          cexNavUsd: parseFloat(cexNavTotal.toFixed(2)),
          dexCapitalUsd: dexCapitalTotal,
          realizedNetUsd,
        },
        this.executionMode
      );
    }

    const effectivePortfolioUsd = equityReconciled;
    const portfolioMetrics = this.ledger.calculateMetrics(
      this.totalCapitalUsd,
      this.totalCapitalUsd,
      undefined,
      totalAccruedDexFees,
      dynamicWeightedApr
    );

    const payload = {
      executionMode: this.executionMode,
      totalCapitalUsd: this.totalCapitalUsd,
      effectivePortfolioUsd,
      openPositionPnlUsd: parseFloat(openPositionPnlUsd.toFixed(4)),
      equity: {
        reconciledUsd: equityReconciled,
        deployedValueUsd,
        unallocatedCashUsd: this.unallocatedCashUsd,
        untradedReserveUsd,
        policyReserveTargetUsd,
        policyActiveTargetUsd,
        underDeploymentVsPolicyUsd,
        phantomCapitalUsd,
        legacyFormulaUsd: equityLegacy,
        driftUsd: equityDriftUsd,
        driftPct: equityDriftPct,
        cexNavUsd: parseFloat(cexNavTotal.toFixed(2)),
        dexCapitalUsd: dexCapitalTotal,
        dexInitialCapitalUsd: parseFloat(dexInitialCapitalTotal.toFixed(4)),
        dexFeesUsd: parseFloat(dexFeesTotalPersisted.toFixed(4)),
        dexImpermanentLossUsd: parseFloat(dexIlTotal.toFixed(4)),
        dexImpermanentLossFullRangeUsd: parseFloat(dexIlFullRangeTotal.toFixed(4)),
        ilModel: process.env.DEX_IL_MODEL === "full_range" ? "full_range" : "concentrated",
        dexGasUsd: parseFloat(dexGasTotal.toFixed(4)),
        dexNetPnlUsd: dexNetPnlTotal,
        cexRealizedNetUsd: portfolioMetrics.netPnlAfterCostsUsd,
      },
      measurement: {
        ...getMeasurementWindow(),
        invalidations: this.windowInvalidations,
        windowValid: this.windowInvalidations.length === 0,
        conservationRepairs: this.conservationRepairs,
      },
      dexRebalanceEventsTotal: this.dexRebalanceEvents,
      unallocatedCashUsd: this.unallocatedCashUsd,
      regimeHysteresis: this.allocationRegime,
      conservationRepairs: this.conservationRepairs,
      capitalMovedTotalUsd: this.capitalMovedTotalUsd,
      windowInvalidations: this.windowInvalidations,
      macroAllocation,      cex: cexSummary,
      dex: dexSummary,
      futuresHedge: this.futuresHedgeEngine.getSummary(),
      pulseCount: this.pulseCount,
      startedAt: this.startedAt,
      history: this.ledger.getHistory(),
      metrics: portfolioMetrics,
      paperMetrics: this.ledger.calculateMetrics(this.totalCapitalUsd, this.totalCapitalUsd, "PAPER", totalAccruedDexFees, dynamicWeightedApr),
      liveMetrics: this.ledger.calculateMetrics(this.totalCapitalUsd, this.totalCapitalUsd, "LIVE", 0, undefined),
      cexPositions: cexSummary,
      dexPositions: dexSummary,
      lastUpdated: new Date().toISOString(),
    };

    this.persistenceManager.saveAtomic(payload);

    // Serie temporal del equity: una muestra por hora (y siempre tras una reparacion).
    // Permite ver la PENDIENTE del residuo de conservacion en lugar de esperar alertas.
    const seriesDue =
      this.pulseCount % 360 === 0 || Date.now() - this.lastEquitySampleTs > 3_600_000;
    if (seriesDue || conservation.needsRepair) {
      this.lastEquitySampleTs = Date.now();
      try {
        appendEquitySample({
          ts: new Date().toISOString(),
          capitalUsd: this.totalCapitalUsd,
          realizedNetUsd,
          deployedUsd: deployedValueUsd,
          capturedReserveUsd: this.unallocatedCashUsd,
          untradedReserveUsd,
          reconciledUsd: simEquityUsd,
          repairs: this.conservationRepairs,
          windowValid: this.windowInvalidations.length === 0,
          mode: this.executionMode,
        });
      } catch (err: any) {
        console.warn("[EQUITY SERIES WARN] No se pudo registrar la muestra:", err?.message || err);
      }
    }
  }

  public async tick() {
    try {
      this.pulseCount++;
      this.lastTickAt = Date.now();

      // 1. Sincronizar watchlist periódicamente (cada 10 min)
      if (this.pulseCount % 60 === 1) {
        await this.capitalAllocator.syncWithWatchlist();
      }

      const watchlist = loadActiveWatchlist();

      // 3. Ejecutar ciclo táctico CEX
      await this.cexEngine.tick(watchlist);

      // 4. Ejecutar ciclo táctico DEX
      await this.dexEngine.tick();

      // 5. Ejecutar ciclo de Cobertura Delta-Neutral de Futuros (Simulación Paper)
      try {
        this.futuresHedgeEngine.executionMode = this.executionMode;
        const reserveUsd = this.totalCapitalUsd * 0.40;
        const currentRegime = this.cexBots.get("BTC")?.jevJudgment?.regime || "BALANCED_RANGE";
        const priceHistories: Record<string, number[]> = {};
        for (const [ticker, item] of this.cexBots.entries()) {
          if (item.priceHistory) priceHistories[ticker] = item.priceHistory;
        }
        await this.futuresHedgeEngine.syncWithDexPositions(
          this.dexPositions as any,
          reserveUsd,
          currentRegime,
          priceHistories
        );
        this.futuresHedgeEngine.stepHour();
      } catch (fErr) {
        console.warn("[FUTURES HEDGE TICK ERROR]:", fErr);
      }

      // 6. Evaluar guardarraíles de riesgo (Fase 0)
      this.evaluateRisk();

      // 7. Persistir estado consolidado
      this.savePersistentState();

      // 8. Centinela de Memoria por Umbral (Limpia desechos pasivamente si supera 160 MB)
      MemorySentinel.getInstance(160).checkAndCompact();
    } catch (err) {
      console.error("[DYNAMIC ORCHESTRATOR ERROR]:", err);
    }
  }

  /**
   * Evalúa los guardarraíles de riesgo y dispara alerta una sola vez al activarse el kill-switch.
   */
  private evaluateRisk(): void {
    const wasKilled = this.riskGuard.isKilled();
    const exposures = Array.from(this.cexBots.entries()).map(([ticker, item]) => ({
      ticker,
      inventoryUsd: (item.bot.qty || 0) * (item.lastMidPrice || item.bot.avg || 0),
    }));
    const closedTrades = this.ledger.getHistory().map((t) => ({
      timestamp: t.timestamp,
      venue: t.venue,
      pnlNet: t.pnlNet || 0,
    }));

    const status = this.riskGuard.evaluate({
      capitalUsd: this.totalCapitalUsd,
      exposures,
      closedTrades,
    });

    if (status.killed && !wasKilled) {
      console.warn(`[RISK GUARD] Kill-switch ACTIVADO: ${status.killReason}`);
      sendTelegramAlert(
        `[ALPHA ENGINE] RISK GUARD: NUEVAS ENTRADAS BLOQUEADAS\nMotivo: ${status.killReason}\nPnL realizado hoy: $${status.dailyRealizedPnlUsd.toFixed(2)} USD\nExposicion agregada: $${status.aggregateExposureUsd.toFixed(2)} / $${status.aggregateExposureLimitUsd.toFixed(2)} USD`
      ).catch(() => {});
    }
  }

  /**
   * Reconciliación de arranque en modo LIVE.
   * Aterriza el estado interno en la realidad de Binance:
   *  1. Cancela órdenes abiertas huérfanas (previas a un reinicio del proceso).
   *  2. Reconstruye el inventario (qty) de cada bot desde el saldo real del activo base.
   *  3. Deriva el cash libre respetando la bolsa asignada a cada bot (bag - inventario).
   */
  public async reconcileLiveStateOnStartup(): Promise<void> {
    if (this.executionMode !== "LIVE" || !this.liveTradingEnabled) return;
    const driver = this.binanceDriver;
    if (!driver.isConfigured()) {
      console.warn("[LIVE STARTUP] Binance driver no configurado. Reconciliación de arranque omitida.");
      return;
    }

    console.log("[LIVE STARTUP] Reconciliando inventario real contra Binance...");
    for (const [ticker, item] of this.cexBots.entries()) {
      const symbol = BINANCE_PAIRS[ticker];
      if (!symbol) continue;
      try {
        await driver.cancelAllOpenOrders(symbol).catch(() => {});
        const baseAsset = symbol.replace(/USDT$|USDC$|FDUSD$|BUSD$/, "");
        const bal = await driver.getAssetBalance(baseAsset);
        const realQty = bal.total;

        item.bot.qty = realQty;
        const inventoryValue = item.bot.avg > 0 ? realQty * item.bot.avg : item.bot.cost;
        item.bot.cost = inventoryValue;
        item.bot.cash = Math.max(0, item.allocatedCashUsd - inventoryValue);

        console.log(
          `[LIVE STARTUP] ${ticker}: qty real=${realQty.toFixed(6)} | cash derivado=$${item.bot.cash.toFixed(2)} USD | en posición=${item.bot.inPos}`
        );
      } catch (err: any) {
        console.warn(`[LIVE STARTUP WARN] No se pudo reconciliar ${ticker}: ${err?.message || err}`);
      }
    }
    this.savePersistentState();
  }

  public startHttpServer() {
    this.httpServerManager.start();
  }

  public async start() {
    this.isRunning = true;
    console.log("=== INICIANDO DYNAMIC MULTI-ASSET ALPHA ENGINE (MODULAR V3) ===");
    console.log(`[MODE] EXECUTION_MODE=${this.executionMode} | LIVE_TRADING_ENABLED=${this.liveTradingEnabled}`);
    logMeasurementWindowBanner();
    if (this.executionMode === "LIVE") {
      console.log("[LIVE] CEX Spot (Binance) OPERATIVO con reconciliación de fills reales.");
      console.log("[LIVE] DEX (Base L2) y Futuros (Binance Futures) permanecen en SIMULACIÓN (sin ejecución real).");
    }
    this.startHttpServer();
    await this.capitalAllocator.syncWithWatchlist();
    await this.reconcileLiveStateOnStartup();

    while (this.isRunning) {
      await this.tick();
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

if (import.meta.main) {
  const simCapitalUsd = parseFloat(process.env.SIMULATION_CAPITAL_USD || "200");
  const orchestrator = new DynamicAlphaOrchestrator(simCapitalUsd);
  orchestrator.start();
}
