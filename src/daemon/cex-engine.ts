/**
 * Motor Táctico y de Microestructura CEX (Alpha Engine)
 * Gobierna las órdenes límite Maker (POST_ONLY), mallas dinámicas,
 * cálculo de OFI, consultas de microestructura a Laya System 1 y salidas causales.
 */

import { evaluateMarketStateLocal } from "../guardrails/laya-client-local.js";
import { evaluateExitGovernance } from "../guardrails/exit-governance.js";
import { evaluateMarketWithJev } from "../guardrails/typesafe-jev-client.js";
import { OrderFlowImbalanceAnalyzer } from "../guardrails/ofi-analyzer.js";
import { sendTelegramAlert } from "../telemetry/notifier.js";
import { triggerCexRebalancePipeline } from "../research/targeted-research.js";
import { MarketTemperatureMonitor } from "../guardrails/market-temperature.js";
import { BinanceHistoricalFeeder } from "../cex/binance-history.js";
import { JitEvolutionEngine } from "../genetic/jit-evolution.js";
import { BINANCE_PAIRS } from "./capital-allocator.js";
import { RealTimeAuditLogger } from "../telemetry/audit-logger.js";
import { computePaperFill, DEFAULT_TAKER_FEE_BPS } from "./paper-execution.js";
import { recordPulseInput } from "../guardrails/input-recorder.js";
import type { DynamicAlphaOrchestrator, ActiveCexBot } from "./dynamic-orchestrator.js";
import type { ResearchWatchlist } from "../research/watchlist-loader.js";

/** Comisión Maker/Taker por defecto en Binance Spot VIP0 (0.10%). */
export const BINANCE_MAKER_FEE = 0.0010;

export interface LiveOrderResult {
  ok: boolean;
  orderId?: number;
  clientOrderId?: string;
  status?: "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED" | "EXPIRED";
  executedQty?: number;
  reason?: string;
}

/**
 * Intención de mutación contable diferida. En modo LIVE, el estado interno
 * solo se modifica cuando Binance confirma la ejecución real (FILLED).
 */
type LiveMutation =
  | { kind: "GRID_FILL"; ticker: string; levelName: string; usd: number }
  | { kind: "EXIT_FULL"; ticker: string; action: string }
  | { kind: "EXIT_PARTIAL"; ticker: string; action: string; fraction: number }
  | { kind: "PINGPONG"; ticker: string; levelName: string; usd: number }
  | { kind: "OPEN_GRID"; ticker: string; exposureFraction: number; stopMultiplier: number; spacingMultiplier: number };

interface PendingLiveOrder {
  ticker: string;
  symbol: string;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  taker: boolean;
  mutation: LiveMutation;
  placedAt: number;
}

export class CexEngine {
  private orchestrator: DynamicAlphaOrchestrator;
  private ofiAnalyzers: Map<string, OrderFlowImbalanceAnalyzer> = new Map();
  private pendingLiveOrders: Map<string, PendingLiveOrder> = new Map();

  constructor(orchestrator: DynamicAlphaOrchestrator) {
    this.orchestrator = orchestrator;
  }

  public getOfiAnalyzer(ticker: string): OrderFlowImbalanceAnalyzer {
    if (!this.ofiAnalyzers.has(ticker)) {
      this.ofiAnalyzers.set(ticker, new OrderFlowImbalanceAnalyzer());
    }
    return this.ofiAnalyzers.get(ticker)!;
  }

  /**
   * Envía una orden Maker real (POST_ONLY / LIMIT_MAKER) a Binance y devuelve su
   * resultado exacto. Cero fallback a otros exchanges.
   */
  public async placeCexOrder(
    ticker: string,
    side: "buy" | "sell",
    price: number,
    qty: number,
    clientOrderId?: string,
    taker = false
  ): Promise<LiveOrderResult> {
    const orch = this.orchestrator;
    const symbol = BINANCE_PAIRS[ticker];

    if (!symbol) {
      console.warn(`[CEX LIVE ABORT] Ticker ${ticker} sin par Binance resuelto. Orden NO enviada.`);
      return { ok: false, reason: "SYMBOL_NOT_RESOLVED" };
    }
    if (!orch.getBinanceDriver().isConfigured()) {
      console.warn(`[CEX LIVE ABORT] Binance driver no configurado. Orden NO enviada para ${symbol}.`);
      return { ok: false, reason: "DRIVER_NOT_CONFIGURED" };
    }

    const binanceSide = side.toUpperCase() as "BUY" | "SELL";
    const rulesMgr = orch.getBinanceDriver().getMarketRulesManager();
    const sanitized = rulesMgr.sanitizeOrder(symbol, price, qty);

    if (!sanitized.valid) {
      console.warn(`[BINANCE FILTER REJECT] Orden omitida para ${symbol} (${binanceSide}): ${sanitized.reason}`);
      return { ok: false, reason: `FILTER_REJECT: ${sanitized.reason}` };
    }

    try {
      const order = taker
        ? await orch.getBinanceDriver().placeMarketOrder(symbol, binanceSide, sanitized.qty, clientOrderId)
        : await orch.getBinanceDriver().placePostOnlyOrder(symbol, binanceSide, sanitized.price, sanitized.qty, clientOrderId);
      return {
        ok: true,
        orderId: order.orderId,
        clientOrderId: order.clientOrderId,
        status: order.status,
        executedQty: parseFloat(order.executedQty || "0"),
      };
    } catch (err: any) {
      console.warn(`[BINANCE ORDER WARN] ${symbol} ${binanceSide} fallo: ${err?.message || err}`);
      return { ok: false, reason: err?.message || String(err) };
    }
  }

  /**
   * En LIVE: coloca la orden y registra la mutación diferida. El bot NO asume el fill.
   * En PAPER: devuelve false para que el llamador aplique la lógica de simulación normal.
   */
  private async submitLiveOrder(
    ticker: string,
    side: "buy" | "sell",
    price: number,
    qty: number,
    mutation: LiveMutation,
    taker = false
  ): Promise<boolean> {
    const symbol = BINANCE_PAIRS[ticker];
    if (!symbol) return false;

    const coid = `alpha_${ticker}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const result = await this.placeCexOrder(ticker, side, price, qty, coid, taker);

    if (!result.ok) {
      RealTimeAuditLogger.getInstance().record(
        "CEX",
        "ORDER_REJECTED",
        ticker,
        mutation.kind,
        `Orden ${side.toUpperCase()} rechazada por Binance (${result.reason}). Sin mutación contable.`,
        "WARN",
        { price, qty, reason: result.reason, taker },
        this.orchestrator.getExecutionMode()
      );
      return false;
    }

    // Si ya se ejecutó instantáneamente (típico de MARKET), aplicar de inmediato.
    if (result.status === "FILLED") {
      this.applyLiveMutation(mutation, result.executedQty || qty, price, { liquidity: taker ? "TAKER" : "MAKER", expectedPrice: price });
      return true;
    }

    // Orden descansando en el libro: registrar para reconciliación diferida.
    const key = result.clientOrderId || coid;
    this.pendingLiveOrders.set(key, {
      ticker,
      symbol,
      side: side.toUpperCase() as "BUY" | "SELL",
      price,
      qty,
      taker,
      mutation,
      placedAt: Date.now(),
    });
    return true;
  }

  /**
   * Analiza si ya existe una orden LIVE pendiente (en memoria) que cubra el nivel,
   * el ticker o el tipo de mutación indicado. Evita reenviar órdenes duplicadas en
   * ticks sucesivos mientras la orden previa sigue descansando en el libro.
   */
  private hasPendingLiveOrder(ticker: string, opts: { levelName?: string; kinds?: LiveMutation["kind"][] } = {}): boolean {
    for (const p of this.pendingLiveOrders.values()) {
      if (p.ticker !== ticker) continue;
      if (opts.kinds && !opts.kinds.includes(p.mutation.kind)) continue;
      if (opts.levelName !== undefined) {
        if (!("levelName" in p.mutation) || p.mutation.levelName !== opts.levelName) continue;
      }
      return true;
    }
    return false;
  }

  /**
   * Profundidad del libro (USD) como suma de los 5 mejores niveles de cada lado.
   * Es la referencia del modelo PAPER para el impacto de las ordenes agresivas. Si el
   * libro no trae profundidad se usa un minimo documentado (50k USD) para no inflar
   * el impacto de forma artificial.
   */
  private bookDepthUsd(
    bids: Array<{ price: number; amount: number }>,
    asks: Array<{ price: number; amount: number }>
  ): number {
    const sum = (arr: Array<{ price: number; amount: number }>) =>
      arr.slice(0, 5).reduce((a, e) => a + (Number(e.price) || 0) * (Number(e.amount) || 0), 0);
    const depth = Math.min(sum(bids || []), sum(asks || []));
    return depth > 0 ? depth : 50_000;
  }

  /**
   * Calcula el costo de slippage (solo positivo = en contra) para una ejecución.
   */
  private computeSlippageUsd(side: "BUY" | "SELL", expectedPrice: number, fillPrice: number, qty: number): number {
    if (!expectedPrice || !fillPrice || qty <= 0) return 0;
    const diff = side === "SELL" ? expectedPrice - fillPrice : fillPrice - expectedPrice;
    return diff > 0 ? parseFloat((diff * qty).toFixed(4)) : 0;
  }

  /**
   * Aplica una mutación contable confirmada por Binance sobre el estado interno.
   */
  private applyLiveMutation(
    mutation: LiveMutation,
    filledQty: number,
    fillPrice: number,
    opts: { liquidity: "MAKER" | "TAKER"; expectedPrice: number } = { liquidity: "MAKER", expectedPrice: fillPrice }
  ): void {
    const cexBots = this.orchestrator.getCexBots();
    const item = cexBots.get(mutation.ticker);
    if (!item) return;

    const feePaidUsd = parseFloat((filledQty * fillPrice * BINANCE_MAKER_FEE).toFixed(4));

    if (mutation.kind === "OPEN_GRID") {
      item.bot._open(fillPrice, 0, mutation.exposureFraction, mutation.stopMultiplier, mutation.spacingMultiplier);
      RealTimeAuditLogger.getInstance().record(
        "CEX",
        "GRID_INITIALIZATION",
        mutation.ticker,
        "OPEN_GRID_L1",
        `Malla abierta en LIVE con fill real a $${fillPrice}. Exposición ${(mutation.exposureFraction * 100).toFixed(1)}%.`,
        "INFO",
        { fillPrice, exposureFraction: mutation.exposureFraction },
        this.orchestrator.getExecutionMode()
      );
      return;
    }

    if (mutation.kind === "GRID_FILL") {
      const lvl = item.bot.levels.find((l) => l.name === mutation.levelName);
      if (lvl && !lvl.filled) {
        lvl.usd = mutation.usd;
        item.bot._fill(lvl, fillPrice, 0);
        this.orchestrator.getLedger().recordTrade({
          timestamp: new Date().toISOString(),
          mode: this.orchestrator.getExecutionMode(),
          venue: "BINANCE_SPOT",
          assetOrPool: item.book,
          action: `BUY_GRID_FILL_${mutation.levelName}`,
          price: fillPrice,
          amount: filledQty,
          pnlNet: 0,
          pnlPct: 0,
          feeSavedOrPaid: 0,
          feePaidUsd,
          liquidity: opts.liquidity,
        });
      }
    } else if (mutation.kind === "EXIT_FULL") {
      const qty = Math.min(filledQty, item.bot.qty);
      const pnlNet = (fillPrice - item.bot.avg) * qty;
      const pnlPct = item.bot.avg > 0 ? ((fillPrice / item.bot.avg) - 1) * 100 : 0;
      this.orchestrator.getLedger().recordTrade({
        timestamp: new Date().toISOString(),
        mode: this.orchestrator.getExecutionMode(),
        venue: "BINANCE_SPOT",
        assetOrPool: item.book,
        action: mutation.action,
        price: fillPrice,
        amount: qty,
        pnlNet: parseFloat(pnlNet.toFixed(2)),
        pnlPct: parseFloat(pnlPct.toFixed(2)),
        feeSavedOrPaid: 0,
        feePaidUsd,
        liquidity: opts.liquidity,
        slippageUsd: this.computeSlippageUsd("SELL", opts.expectedPrice, fillPrice, qty),
      });
      item.bot._close(fillPrice, 0, mutation.action === "EMERGENCY_DELEVERAGE" ? "STOP" : "TP");
      item.partialTakenPct = 0;
      if (mutation.action !== "EMERGENCY_DELEVERAGE") item.postShockRecovery = false;
      if (mutation.action === "EMERGENCY_DELEVERAGE") item.awaitingLayaRecovery = true;
    } else if (mutation.kind === "EXIT_PARTIAL") {
      const qtyToClose = Math.min(item.bot.qty * mutation.fraction, filledQty);
      const entryAvg = item.bot.avg;
      const pnlNet = (fillPrice - entryAvg) * qtyToClose;
      const pnlPct = entryAvg > 0 ? ((fillPrice / entryAvg) - 1) * 100 : 0;
      item.bot.qty -= qtyToClose;
      item.bot.cost = Math.max(0, item.bot.cost - qtyToClose * entryAvg);
      item.partialTakenPct = (item.partialTakenPct || 0) + mutation.fraction;
      item.bot.cash += qtyToClose * fillPrice;
      item.bot.stop = Math.max(item.bot.stop, entryAvg * 1.002, fillPrice * 0.996);
      this.orchestrator.getLedger().recordTrade({
        timestamp: new Date().toISOString(),
        mode: this.orchestrator.getExecutionMode(),
        venue: "BINANCE_SPOT",
        assetOrPool: item.book,
        action: "TP_PARTIAL_DCA",
        price: fillPrice,
        amount: qtyToClose,
        pnlNet: parseFloat(pnlNet.toFixed(2)),
        pnlPct: parseFloat(pnlPct.toFixed(2)),
        feeSavedOrPaid: parseFloat((qtyToClose * fillPrice * 0.0055).toFixed(2)),
        feePaidUsd: parseFloat((qtyToClose * fillPrice * BINANCE_MAKER_FEE).toFixed(4)),
        liquidity: opts.liquidity,
        slippageUsd: this.computeSlippageUsd("SELL", opts.expectedPrice, fillPrice, qtyToClose),
      });
    } else if (mutation.kind === "PINGPONG") {
      const lvl = item.bot.levels.find((l) => l.name === mutation.levelName);
      const boughtPrice = lvl?.fillPrice || fillPrice;
      const chunkQty = Math.min(mutation.usd / boughtPrice, filledQty);
      const chunkPnlNet = (fillPrice - boughtPrice) * chunkQty;
      const chunkPnlPct = boughtPrice > 0 ? ((fillPrice / boughtPrice) - 1) * 100 : 0;
      item.bot.cash += chunkQty * fillPrice;
      item.bot.qty = Math.max(0, item.bot.qty - chunkQty);
      item.bot.cost = Math.max(0, item.bot.cost - mutation.usd);
      if (lvl) {
        lvl.filled = false;
        lvl.t = -1;
      }
      this.orchestrator.getLedger().recordTrade({
        timestamp: new Date().toISOString(),
        mode: this.orchestrator.getExecutionMode(),
        venue: "BINANCE_SPOT",
        assetOrPool: item.book,
        action: `TP_GRID_PINGPONG_${mutation.levelName}`,
        price: fillPrice,
        amount: chunkQty,
        pnlNet: parseFloat(chunkPnlNet.toFixed(2)),
        pnlPct: parseFloat(chunkPnlPct.toFixed(2)),
        feeSavedOrPaid: 0,
        feePaidUsd: parseFloat((chunkQty * fillPrice * BINANCE_MAKER_FEE).toFixed(4)),
        liquidity: opts.liquidity,
        slippageUsd: this.computeSlippageUsd("SELL", opts.expectedPrice, fillPrice, chunkQty),
      });
    }
  }

  /**
   * Reconcilia las órdenes LIVE pendientes contra el estado real de Binance.
   * Solo aplica la mutación contable cuando Binance reporta FILLED.
   * Si una orden envejece sin llenarse (> 30 min), se cancela para no dejar
   * liquidez huérfana en el libro.
   */
  private async reconcileLiveOrders(): Promise<void> {
    if (this.pendingLiveOrders.size === 0) return;
    const driver = this.orchestrator.getBinanceDriver();
    if (!driver.isConfigured()) return;

    for (const [key, pending] of Array.from(this.pendingLiveOrders.entries())) {
      try {
        const order = await driver.getOrderStatus(pending.symbol, undefined, key);
        if (order.status === "FILLED") {
          const executed = parseFloat(order.executedQty || "0") || pending.qty;
          const avgPrice = parseFloat(order.price || "0") || pending.price;
          this.applyLiveMutation(pending.mutation, executed, avgPrice, {
            liquidity: pending.taker ? "TAKER" : "MAKER",
            expectedPrice: pending.price,
          });
          const lvlName = "levelName" in pending.mutation ? ` ${pending.mutation.levelName}` : "";
          RealTimeAuditLogger.getInstance().record(
            "CEX",
            "ORDER_FILLED_REAL",
            pending.ticker,
            pending.mutation.kind,
            `Fill real confirmado por Binance${lvlName}: ${pending.side} ${executed} @ $${avgPrice}.`,
            "INFO",
            { orderId: order.orderId, executed, avgPrice },
            this.orchestrator.getExecutionMode()
          );
          this.pendingLiveOrders.delete(key);
        } else if (order.status === "CANCELED" || order.status === "REJECTED" || order.status === "EXPIRED") {
          this.pendingLiveOrders.delete(key);
        } else if (Date.now() - pending.placedAt > 30 * 60_000) {
          await driver.cancelOrder(pending.symbol, undefined, key).catch(() => {});
          this.pendingLiveOrders.delete(key);
          console.log(`[LIVE ORDER TTL] Orden ${key} cancelada por inactividad (30 min sin fill).`);
        }
      } catch {
        // Orden aún no propagada o error transitorio: reintentar en el siguiente tick.
      }
    }
  }

  /**
   * Estima la cantidad del nivel L1 de la malla para colocarla como orden real
   * en LIVE (replica el sizing de GridBot._open antes del fill).
   */
  private estimateGridL1Qty(item: ActiveCexBot, price: number): number {
    if (price <= 0) return 0;
    const cap = item.bot.currentExposureCap;
    const equity = item.bot.equity(price);
    const allocatedCapital = Math.min(item.bot.cash, equity * cap);
    const g = item.bot.g as any;
    const levels = Math.max(1, g.levels || 1);
    const mult = g.mult || 1.1;
    let w = 0;
    for (let k = 0; k < levels; k++) w += Math.pow(mult, k);
    const base = allocatedCapital / w;
    return base / price;
  }

  public async tick(watchlist: ResearchWatchlist | null): Promise<void> {
    const orch = this.orchestrator;
    const cexBots = orch.getCexBots();
    const isLive = orch.getExecutionMode() === "LIVE" && orch.isLiveTradingEnabled();

    // En LIVE, reconciliar primero las órdenes reales pendientes contra Binance
    // para que el estado interno refleje exclusivamente fills confirmados.
    if (isLive) {
      await this.reconcileLiveOrders();
    }

    for (const [ticker, item] of cexBots.entries()) {
      const directive = watchlist?.candidates.find((c) => c.ticker === ticker);
      const symbol = BINANCE_PAIRS[ticker] || item.book;

      if (!symbol) {
        console.warn(`[CEX SKIP] ${ticker} sin símbolo Binance resuelto. Omitido en este ciclo.`);
        continue;
      }

      let rawBids: { price: number; amount: number }[] = [];
      let rawAsks: { price: number; amount: number }[] = [];

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=20`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) continue;
        const data = await res.json();
        rawBids = (data.bids || []).map((b: any) => ({ price: parseFloat(b[0]), amount: parseFloat(b[1]) }));
        rawAsks = (data.asks || []).map((a: any) => ({ price: parseFloat(a[0]), amount: parseFloat(a[1]) }));
      } catch (fetchErr: any) {
        console.warn(`[CEX NETWORK WARN] Fallo lectura de libro para ${symbol}: ${fetchErr?.message || fetchErr}`);
        continue;
      }

      if (rawBids.length === 0 || rawAsks.length === 0) continue;

      const bid = rawBids[0].price;
      const ask = rawAsks[0].price;
      const midPrice = (bid + ask) / 2;
      const spreadBps = ((ask - bid) / midPrice) * 10000;
      item.lastMidPrice = midPrice;

      // Mantener buffer de precios para cálculo de tendencia EMA(20)
      if (!item.priceHistory) item.priceHistory = [];
      item.priceHistory.push(midPrice);
      if (item.priceHistory.length > 50) item.priceHistory.shift();

      const computeEma = (prices: number[], period: number = 20): number => {
        if (prices.length === 0) return 0;
        const k = 2 / (period + 1);
        let ema = prices[0];
        for (let idx = 1; idx < prices.length; idx++) {
          ema = prices[idx] * k + ema * (1 - k);
        }
        return ema;
      };

      const ema20 = computeEma(item.priceHistory, 20);
      const isUpwardTrend = item.priceHistory.length >= 10 ? midPrice >= ema20 * 0.999 : true;

      // Cálculo de OFI y evaporación de liquidez
      const ofiMetrics = this.getOfiAnalyzer(ticker).analyze({
        timestamp: Date.now(),
        bids: rawBids,
        asks: rawAsks,
      });

      // Filtro de invalidez macro de research
      if (directive) {
        const maxEntry = directive.max_entry_price_usd ? directive.max_entry_price_usd * 1.03 : 0;
        if (maxEntry > 0 && midPrice > maxEntry) {
          continue;
        }
        if (directive.invalidation_price_usd && midPrice < directive.invalidation_price_usd) {
          if (item.bot.inPos) {
            item.bot._close(bid, 0, "MACRO_INVALIDATION");
            await sendTelegramAlert(
              `[ALPHA ENGINE] STOP MACRO EJECUTADO PARA ${ticker}\nPrecio cayó por debajo de $${directive.invalidation_price_usd} USD.\nPosición liquidada. Disparando rotación causal...`
            );

            const currentRegime = item.jevJudgment?.regime || "BALANCED_RANGE";
            triggerCexRebalancePipeline(ticker, item.allocatedCashUsd, currentRegime).then((reb) => {
              if (reb.ok) {
                if (reb.action === "TRANSFER_TO_FIAT_RESERVE") {
                  const fiatBot = cexBots.get("USD");
                  if (fiatBot) {
                    fiatBot.allocatedCashUsd += reb.allocatedCashUsd;
                    fiatBot.bot.cash += reb.allocatedCashUsd;
                  }
                  cexBots.delete(ticker);
                }
                orch.savePersistentState();
              }
            }).catch(() => {});
          }
          continue;
        }
      }

      // 1. Consultar Laya Microestructura (< 1 ms en compute-node)
      const layaJudgments = await evaluateMarketStateLocal(
        {
          ticker,
          book: item.book,
          spread_bps: spreadBps,
          mid_price: midPrice,
          ofi_score: ofiMetrics.ofiScore,
          depth_ratio: ofiMetrics.depthRatio,
          evaporating: ofiMetrics.isLiquidityEvaporating,
        },
        1000
      );

      const currentToxicFlow = layaJudgments.ok && layaJudgments.toxicFlow !== null ? layaJudgments.toxicFlow : 0.12;
      item.lastToxicFlow = currentToxicFlow;

      // 2. Escalado reactivo a Jev System 2
      const now = Date.now();
      const isCriticalStress = currentToxicFlow > 0.75;
      const timeForJev = !item.lastJevCheckTs || now - item.lastJevCheckTs > 120_000;

      if (timeForJev || isCriticalStress) {
        const bidsDepthUsd = rawBids.slice(0, 3).reduce((acc: number, b: any) => acc + (b.price * b.amount), 0);
        const asksDepthUsd = rawAsks.slice(0, 3).reduce((acc: number, a: any) => acc + (a.price * a.amount), 0);

        item.jevJudgment = await evaluateMarketWithJev({
          ticker,
          book: item.book,
          midPrice,
          spreadBps,
          bidsDepthUsd,
          asksDepthUsd,
          ofiScore: ofiMetrics.ofiScore,
          depthRatio: ofiMetrics.depthRatio,
          isLiquidityEvaporating: ofiMetrics.isLiquidityEvaporating,
        });
        item.lastJevCheckTs = now;
        if (item.jevJudgment) {
          item.bot.currentExposureCap = item.jevJudgment.recommendedExposurePct;
        }

        // Gatillo reactivo a SETS
        if ((item.jevJudgment?.regime === "DEFENSIVE_STRESS" || currentToxicFlow > 0.80) && ticker !== "USD") {
          if (now - orch.getLastEvolutionTs() > 15 * 60_000) {
            orch.setLastEvolutionTs(now);
            console.log(`[SETS REACTIVE TRIGGER] Disparando recalibracion genetica paralela para ${ticker} ante estres agudo (${(currentToxicFlow * 100).toFixed(1)}% toxicidad)...`);
            orch.reEvolveGenome(ticker).catch(() => {});
          }
        }
      }

      // Circuit Breaker Causal Laya con Umbral Ponderado por Regimen y Reconciliacion OFI
      // 1. Umbral base calibrado por regimen macro de Jev
      const currentRegime = item.jevJudgment?.regime || "BALANCED_RANGE";
      const baseToxicThreshold = 0.60;
      const regimeMultiplier = currentRegime === "AGGRESSIVE_ACCUMULATION" ? 1.37 : // ~0.82
                               currentRegime === "BALANCED_RANGE" ? 1.17 :          // ~0.70
                               1.00;                                                // 0.60 en DEFENSIVE_STRESS
      const effectiveToxicThreshold = baseToxicThreshold * regimeMultiplier;

      // 2. Reconciliacion OFI: Si hay presion compradora neta fuerte (>0.55), el flujo no es toxico de salida institucional
      const isOfiBullish = ofiMetrics.ofiScore > 0.55;
      const isToxicFlowDetected = currentToxicFlow > effectiveToxicThreshold && !isOfiBullish;

      const isToxic =
        isToxicFlowDetected ||
        spreadBps > 35 ||
        ofiMetrics.ofiScore < -0.45 ||
        ofiMetrics.isLiquidityEvaporating;

      item.bot.circuitBreakerActive = isToxic;

      // Registro de telemetría continua
      orch.getTelemetryLogger().recordPulse({
        timestamp: new Date().toISOString(),
        ticker,
        book: item.book,
        midPrice,
        spreadBps,
        ofiScore: ofiMetrics.ofiScore,
        depthRatio: ofiMetrics.depthRatio,
        isLiquidityEvaporating: ofiMetrics.isLiquidityEvaporating,
        layaToxicFlow: layaJudgments.toxicFlow ?? 0,
        jevRegime: item.jevJudgment?.regime || "BALANCED_RANGE",
        jevConfidence: item.jevJudgment?.confidence || 0.75,
        exposurePct: item.bot.currentExposureCap,
        circuitBreakerActive: item.bot.circuitBreakerActive,
        gridLevelsActive: item.bot.levels.length,
      });

      // Inicializar malla si aún no está desplegada (Stop modulado según régimen Jev)
      if (!item.bot.inPos && item.bot.levels.length === 0) {
        if (isUpwardTrend && !isToxic) {
          const currentRegime = item.jevJudgment?.regime || "BALANCED_RANGE";
          // Ajuste fino del stop según régimen macro para mitigar cortes asimétricos
          const stopMultiplier = currentRegime === "DEFENSIVE_STRESS" ? 0.70 : currentRegime === "AGGRESSIVE_ACCUMULATION" ? 1.20 : 1.0;

          if (isLive) {
            if (this.hasPendingLiveOrder(ticker, { kinds: ["OPEN_GRID"] })) continue;
            const l1Qty = this.estimateGridL1Qty(item, midPrice);
            await this.submitLiveOrder(ticker, "buy", midPrice, l1Qty, {
              kind: "OPEN_GRID",
              ticker,
              exposureFraction: item.bot.currentExposureCap,
              stopMultiplier,
              spacingMultiplier: 1.0,
            });
            continue; // La malla se abrirá solo cuando Binance confirme el fill L1.
          }

          item.bot._open(midPrice, 0, item.bot.currentExposureCap, stopMultiplier);
          const stopDisplayVal = item.bot.stop && !isNaN(item.bot.stop) ? `$${item.bot.stop.toFixed(2)} USD` : "Gobernado por Laya (Trailing)";
          console.log(`[GRID INIT] Desplegada malla inicial para ${ticker} a $${midPrice.toFixed(2)} USD con ${item.bot.levels.length} niveles (Régimen: ${currentRegime}, Stop: ${stopDisplayVal})`);
          RealTimeAuditLogger.getInstance().record(
            "CEX",
            "GRID_INITIALIZATION",
            ticker,
            "OPEN_GRID_L1",
            `Malla desplegada a $${midPrice.toFixed(2)} USD. ${item.bot.levels.length} niveles activos. Stop Loss en ${stopDisplayVal}.`,
            "INFO",
            { midPrice, regime: currentRegime, stopMultiplier, levels: item.bot.levels.length, stopPrice: item.bot.stop },
            orch.getExecutionMode()
          );
          orch.savePersistentState();
        }
      }

      // Si hay toxicidad y NO hay posición abierta, no abrir nada nuevo
      if (isToxic && !item.bot.inPos) {
        continue;
      }

      // Guardarraíl de riesgo (Fase 0): el kill-switch bloquea NUEVAS entradas,
      // pero NUNCA bloquea la gestión/salida de posiciones ya abiertas.
      if (orch.isRiskKilled() && !item.bot.inPos) {
        continue;
      }

      // Fills de Take-Profit o Stop con Gobernanza Causal de Salidas
      if (item.bot.inPos) {
        // Guardia LIVE: si existe una orden de salida pendiente, esperar su confirmación real
        // antes de evaluar/generar una nueva orden de salida (evita duplicados).
        if (isLive && this.hasPendingLiveOrder(ticker, { kinds: ["EXIT_FULL", "EXIT_PARTIAL", "PINGPONG"] })) {
          continue;
        }

        // Hard-stop previo incondicional
        if (item.bot.stop > 0 && midPrice <= item.bot.stop) {
          const pnlNet = (midPrice - item.bot.avg) * item.bot.qty;
          const pnlPct = ((midPrice / item.bot.avg) - 1) * 100;

          if (isLive) {
            await this.submitLiveOrder(ticker, "sell", midPrice, item.bot.qty, { kind: "EXIT_FULL", ticker, action: "HARD_STOP_LOSS" }, true);
            continue; // Mutación contable diferida hasta confirmación real de Binance.
          }

          orch.getLedger().recordTrade({
            timestamp: new Date().toISOString(),
            mode: orch.getExecutionMode(),
            venue: "BINANCE_SPOT",
            assetOrPool: item.book,
            action: "HARD_STOP_LOSS",
            price: midPrice,
            amount: item.bot.qty,
            pnlNet: parseFloat(pnlNet.toFixed(2)),
            pnlPct: parseFloat(pnlPct.toFixed(2)),
            feeSavedOrPaid: 0,
            feePaidUsd: parseFloat((item.bot.qty * midPrice * BINANCE_MAKER_FEE).toFixed(4)),
            liquidity: "TAKER",
          });
          item.bot._close(midPrice, 0, "STOP");
          item.partialTakenPct = 0;
          RealTimeAuditLogger.getInstance().record(
            "CEX",
            "HARD_STOP_TRIGGER",
            ticker,
            "CLOSE_INVENTORY",
            `Hard Stop ejecutado a $${midPrice.toFixed(2)} USD. Retorno: ${pnlPct.toFixed(2)}%. PnL: $${pnlNet.toFixed(2)} USD. Gatillada re-calibración JIT 2 años.`,
            "CRITICAL",
            { midPrice, pnlNet, pnlPct }
          );
          await sendTelegramAlert(
            `[ALPHA ENGINE ${orch.getExecutionMode()}] HARD STOP LOSS CEX (${ticker})\nPrecio: $${midPrice.toFixed(2)} USD\nRetorno: ${pnlPct.toFixed(2)}%\nNet PnL: $${pnlNet.toFixed(2)} USD\nAcción: Gatillada re-calibración genética JIT de 2 años en segundo plano.`
          );

          // Disparar re-evolución deslizante de 2 años en background para re-calibrar la malla
          const symbolToRevolve = BINANCE_PAIRS[ticker] || item.book;
          BinanceHistoricalFeeder.fetchHistoricalSeries(symbolToRevolve, 17_520, 2_160)
            .then(async (series) => {
              if (series) {
                console.log(`[JIT RE-CALIBRATION TRIGGER] Re-calibrando genoma tras Stop Loss en ${ticker}...`);
                const evoResult = await JitEvolutionEngine.evolveGenomeForAsset(ticker, symbolToRevolve, series);
                if (evoResult.isViable) {
                  orch.getActiveGenomes().set(ticker, evoResult.genome);
                  item.bot.g = evoResult.genome; // Hot-swap del genoma activo
                  console.log(`[JIT HOT-SWAP SUCCESS] Genoma para ${ticker} actualizado tras Stop: Spacing=${evoResult.k_spacing}x ATR | Stop=${evoResult.k_stop}x ATR`);
                }
              }
            })
            .catch((err) => {
              console.warn(`[JIT RE-CALIBRATION WARN] Fallo re-evolución tras Stop: ${err?.message || err}`);
            });

          continue;
        }

        const currentPartialTaken = item.partialTakenPct || 0;
        const ofiScore = ofiMetrics.ofiScore;
        item.lastOfiScore = ofiScore;
        const exitEval = await evaluateExitGovernance(
          ticker,
          item.book,
          item.bot.avg,
          midPrice,
          item.bot.tp,
          ofiScore,
          spreadBps,
          item.jevJudgment?.regime || "BALANCED_RANGE",
          currentPartialTaken
        );

        // Grabacion del pulso para replay determinista (ver input-recorder + replay-decisions).
        // Incluye el contexto de posicion que el kernel de salidas necesita para poder
        // reproducir la decision sin red.
        try {
          recordPulseInput({
            ticker,
            book: item.book,
            mid: midPrice,
            bid,
            ask,
            spreadBps,
            ofiScore,
            depthRatio: ofiMetrics.depthRatio,
            toxicFlow: currentToxicFlow,
            jevRegime: item.jevJudgment?.regime || "BALANCED_RANGE",
            jevConfidence: (item.jevJudgment as any)?.confidence ?? 0,
            layaToxicFlow: item.lastToxicFlow,
            decision: exitEval.action,
            reason: exitEval.reason,
            entryAvgPrice: item.bot.avg,
            currentGainPct: item.bot.avg > 0 ? ((midPrice / item.bot.avg) - 1) * 100 : 0,
            targetTpPrice: item.bot.tp,
            alreadyPartialTakenPct: currentPartialTaken,
          });
        } catch {}

        // TP Parcial (DCA Out)
        if (exitEval.action === "TAKE_PROFIT_PARTIAL" && exitEval.fractionToClose > 0) {
          const qtyToClose = item.bot.qty * exitEval.fractionToClose;
          const pnlNet = (midPrice - item.bot.avg) * qtyToClose;
          const pnlPct = ((midPrice / item.bot.avg) - 1) * 100;

          if (isLive) {
            await this.submitLiveOrder(ticker, "sell", midPrice, qtyToClose, {
              kind: "EXIT_PARTIAL",
              ticker,
              action: "TP_PARTIAL_DCA",
              fraction: exitEval.fractionToClose,
            });
            continue; // Mutación contable diferida hasta confirmación real de Binance.
          }

          const entryAvg = item.bot.avg;
          item.bot.qty -= qtyToClose;
          item.bot.cost = Math.max(0, item.bot.cost - qtyToClose * entryAvg);
          item.partialTakenPct = currentPartialTaken + exitEval.fractionToClose;
          const cashRealized = qtyToClose * midPrice;
          item.bot.cash += cashRealized;
          // Subir stop loss a Break-Even + activar trailing stop dinámico al 0.4% por debajo del precio actual
          const breakEvenStop = entryAvg * 1.002;
          const trailingStop = midPrice * 0.996;
          item.bot.stop = Math.max(item.bot.stop, breakEvenStop, trailingStop);

          RealTimeAuditLogger.getInstance().record(
            "CEX",
            "TAKE_PROFIT_PARTIAL",
            ticker,
            "SELL_FRACTION",
            `TP Parcial ejecutado a $${midPrice.toFixed(2)} USD (+${pnlPct.toFixed(2)}%). Realizado: +$${pnlNet.toFixed(2)} USD. Stop elevado a Break-Even ($${item.bot.stop.toFixed(2)}).`,
            "INFO",
            { midPrice, pnlNet, pnlPct, newStop: item.bot.stop },
            orch.getExecutionMode()
          );

          orch.getLedger().recordTrade({
            timestamp: new Date().toISOString(),
            mode: orch.getExecutionMode(),
            venue: "BINANCE_SPOT",
            assetOrPool: item.book,
            action: "TP_PARTIAL_DCA",
            price: midPrice,
            amount: qtyToClose,
            pnlNet: parseFloat(pnlNet.toFixed(2)),
            pnlPct: parseFloat(pnlPct.toFixed(2)),
            feeSavedOrPaid: parseFloat((cashRealized * 0.0055).toFixed(2)),
            feePaidUsd: parseFloat((qtyToClose * midPrice * BINANCE_MAKER_FEE).toFixed(4)),
            liquidity: "MAKER",
          });

          await sendTelegramAlert(
            `[ALPHA ENGINE ${orch.getExecutionMode()}] TP PARCIAL DCA [MAKER POST_ONLY] (${ticker})\nMotivo: ${exitEval.reason}\nPrecio: $${midPrice.toFixed(2)} USD\nRetorno: +${pnlPct.toFixed(2)}%\nNet PnL Realizado: +$${pnlNet.toFixed(2)} USD\nStop subido a Break-Even: $${item.bot.stop.toFixed(2)}`
          );
        }
        // Salidas Totales
        else if (
          exitEval.action === "FRONT_RUN_EXIT" ||
          exitEval.action === "EMERGENCY_DELEVERAGE" ||
          (exitEval.action === "TAKE_PROFIT_STANDARD" && midPrice >= item.bot.tp && item.bot.tp > 0)
        ) {
          const pnlNet = (midPrice - item.bot.avg) * item.bot.qty;
          const pnlPct = ((midPrice / item.bot.avg) - 1) * 100;
          const actionLabel =
            exitEval.action === "FRONT_RUN_EXIT"
              ? "TP_FRONTRUN_LAYA"
              : exitEval.action === "EMERGENCY_DELEVERAGE"
              ? "EMERGENCY_DELEVERAGE"
              : "TAKE_PROFIT_FULL";

          const isMaker = exitEval.action === "TAKE_PROFIT_STANDARD";
          if (isLive) {
            await this.submitLiveOrder(ticker, "sell", midPrice, item.bot.qty, { kind: "EXIT_FULL", ticker, action: actionLabel }, !isMaker);
            continue; // Mutación contable diferida hasta confirmación real de Binance.
          }

          orch.getLedger().recordTrade({
            timestamp: new Date().toISOString(),
            mode: orch.getExecutionMode(),
            venue: "BINANCE_SPOT",
            assetOrPool: item.book,
            action: actionLabel,
            price: midPrice,
            amount: item.bot.qty,
            pnlNet: parseFloat(pnlNet.toFixed(2)),
            pnlPct: parseFloat(pnlPct.toFixed(2)),
            feeSavedOrPaid: isMaker ? parseFloat((item.bot.qty * midPrice * 0.0055).toFixed(2)) : 0,
            feePaidUsd: parseFloat((item.bot.qty * midPrice * BINANCE_MAKER_FEE).toFixed(4)),
            liquidity: isMaker ? "MAKER" : "TAKER",
          });

          RealTimeAuditLogger.getInstance().record(
            "CEX",
            "POSITION_EXIT",
            ticker,
            actionLabel,
            `Salida ${actionLabel} ejecutada a $${midPrice.toFixed(2)} USD (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%). Net PnL: $${pnlNet.toFixed(2)} USD. Motivo: ${exitEval.reason}`,
            pnlNet >= 0 ? "INFO" : "WARN",
            { midPrice, pnlNet, pnlPct, action: actionLabel, reason: exitEval.reason },
            orch.getExecutionMode()
          );

          item.bot._close(midPrice, 0, exitEval.action === "EMERGENCY_DELEVERAGE" ? "STOP" : "TP");
          item.partialTakenPct = 0;
          if (exitEval.action !== "EMERGENCY_DELEVERAGE") {
            item.postShockRecovery = false; // Recuperación completada exitosamente
          }

          // Si fue salida defensiva (Stop / Deleveraging), pasar la custodia a Laya Continuo
          if (exitEval.action === "EMERGENCY_DELEVERAGE") {
            item.awaitingLayaRecovery = true;
            console.log(`[LAYA CONTINUOUS] ${ticker} en custodia continua de Laya tras corte defensivo.`);
          }
          await sendTelegramAlert(
            `[ALPHA ENGINE ${orch.getExecutionMode()}] ${actionLabel} [${isMaker ? "MAKER POST_ONLY" : "TAKER ESCAPE"}] (${ticker})\nMotivo: ${exitEval.reason}\nPrecio: $${midPrice.toFixed(2)} USD\nRetorno: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%\nNet PnL: ${pnlNet >= 0 ? "+" : ""}$${pnlNet.toFixed(2)} USD`
          );
        } else if (exitEval.action === "TRAILING_EXPANSION" && exitEval.adjustedTpPrice) {
          item.bot.tp = exitEval.adjustedTpPrice;
        }

        // Llenado de niveles pasivos L1/L2
        for (const lvl of item.bot.levels) {
          if (!lvl.filled && midPrice <= lvl.price) {
            const buyQty = lvl.usd / lvl.price;

            if (isLive) {
              // Guardia persistente: no reenviar si el nivel ya tiene orden descansando.
              if (this.hasPendingLiveOrder(ticker, { levelName: lvl.name, kinds: ["GRID_FILL"] })) continue;
              await this.submitLiveOrder(ticker, "buy", lvl.price, buyQty, {
                kind: "GRID_FILL",
                ticker,
                levelName: lvl.name,
                usd: lvl.usd,
              });
              // El fill se aplicará solo cuando Binance confirme la ejecución real.
              continue;
            }

            // Ejecucion PAPER con modelo de fills: cola (fill parcial de maker) y
            // slippage/impacto si el nivel cruza el libro. Antes se asumia fill total al
            // precio del nivel, lo que sesgaba a favor del motor.
            const bookDepthUsd = this.bookDepthUsd(rawBids, rawAsks);
            const paperFill = computePaperFill({
              side: "buy",
              intent: "MAKER",
              levelPrice: lvl.price,
              bestBid: bid,
              bestAsk: ask,
              qty: buyQty,
              depthUsd: bookDepthUsd,
              queueFactor: item.paperQueueFactor,
              makeFeeBps: BINANCE_MAKER_FEE * 10000,
              takeFeeBps: DEFAULT_TAKER_FEE_BPS,
            });
            if (!paperFill.filled) {
              RealTimeAuditLogger.getInstance().record(
                "CEX",
                "ORDER_FILL",
                ticker,
                `NO_FILL_${lvl.name}`,
                `Nivel ${lvl.name} alcanzado pero SIN llenado PAPER: ${paperFill.reason}`,
                "INFO",
                { level: lvl.name, price: lvl.price, reason: paperFill.reason },
                orch.getExecutionMode()
              );
              continue;
            }
            item.bot._fill(lvl, paperFill.fillPrice, 0);
            orch.getLedger().recordTrade({
              timestamp: new Date().toISOString(),
              mode: orch.getExecutionMode(),
              venue: "BINANCE_SPOT",
              assetOrPool: item.book,
              action: `BUY_GRID_FILL_${lvl.name}`,
              price: paperFill.fillPrice,
              amount: paperFill.filledQty,
              pnlNet: 0,
              pnlPct: 0,
              feeSavedOrPaid: 0,
              feePaidUsd: paperFill.feeUsd,
              slippageUsd: paperFill.slippageUsd,
              liquidity: paperFill.liquidity,
            });
            RealTimeAuditLogger.getInstance().record(
              "CEX",
              "ORDER_FILL",
              ticker,
              `FILL_${lvl.name}`,
              `Compra ${paperFill.liquidity} llenada en ${lvl.name} a $${paperFill.fillPrice.toFixed(2)} USD (${paperFill.filledQty.toFixed(6)} de ${buyQty.toFixed(6)} pedidos; slippage $${paperFill.slippageUsd}). ${paperFill.reason}`,
              "INFO",
              {
                level: lvl.name,
                price: paperFill.fillPrice,
                usd: lvl.usd,
                qty: paperFill.filledQty,
                liquidity: paperFill.liquidity,
                slippageUsd: paperFill.slippageUsd,
                depthUsd: bookDepthUsd,
              },
              orch.getExecutionMode()
            );
          }
          // Ping-Pong Reciclador
          else if (lvl.filled && lvl.name !== "L1" && (lvl.fillPrice || lvl.price) > 0) {
            const boughtPrice = lvl.fillPrice || lvl.price;
            const targetBouncePrice = boughtPrice * (1 + Math.max(item.bot.g.spacing * 1.05, 0.004));

            if (midPrice >= targetBouncePrice) {
              const chunkQty = lvl.usd / boughtPrice;
              const chunkProceeds = chunkQty * midPrice;
              const chunkPnlNet = (midPrice - boughtPrice) * chunkQty;
              const chunkPnlPct = ((midPrice / boughtPrice) - 1) * 100;

              if (isLive) {
                await this.submitLiveOrder(ticker, "sell", midPrice, chunkQty, {
                  kind: "PINGPONG",
                  ticker,
                  levelName: lvl.name,
                  usd: lvl.usd,
                });
                continue; // Mutación contable diferida hasta confirmación real de Binance.
              }

              item.bot.cash += chunkProceeds;
              item.bot.qty = Math.max(0, item.bot.qty - chunkQty);
              item.bot.cost = Math.max(0, item.bot.cost - lvl.usd);

              lvl.filled = false;
              lvl.t = -1;

              orch.getLedger().recordTrade({
                timestamp: new Date().toISOString(),
                mode: orch.getExecutionMode(),
                venue: "BINANCE_SPOT",
                assetOrPool: item.book,
                action: `TP_GRID_PINGPONG_${lvl.name}`,
                price: midPrice,
                amount: chunkQty,
                pnlNet: parseFloat(chunkPnlNet.toFixed(2)),
                pnlPct: parseFloat(chunkPnlPct.toFixed(2)),
                feeSavedOrPaid: 0,
                feePaidUsd: parseFloat((chunkQty * midPrice * BINANCE_MAKER_FEE).toFixed(4)),
                liquidity: "MAKER",
              });
              RealTimeAuditLogger.getInstance().record(
                "CEX",
                "PING_PONG_RECYCLE",
                ticker,
                `TP_PINGPONG_${lvl.name}`,
                `Ping-Pong venta parcial ${lvl.name} a $${midPrice.toFixed(2)} USD. Ganancia: +$${chunkPnlNet.toFixed(2)} USD (+${chunkPnlPct.toFixed(2)}%). Nivel reabierto.`,
                "INFO",
                { level: lvl.name, price: midPrice, pnlNet: chunkPnlNet, pnlPct: chunkPnlPct },
                orch.getExecutionMode()
              );

              console.log(`[PING-PONG RECYCLE] ${ticker} recicló ${lvl.name}: Venta a $${midPrice.toFixed(2)} USD (+${chunkPnlPct.toFixed(2)}%). Nivel reabierto.`);
              await sendTelegramAlert(
                `[ALPHA ENGINE ${orch.getExecutionMode()}] PING-PONG RECICLADO (${ticker} - ${lvl.name})\nVenta Parcial de Tramo: $${midPrice.toFixed(2)} USD\nGanancia Realizada: +$${chunkPnlNet.toFixed(2)} USD (+${chunkPnlPct.toFixed(2)}%)\nEstado: ${lvl.name} reactivado para recomprar abajo.`
              );
            }
          }
        }
      } else {
        // Re-entrada a la malla fuera de posición (Gobernada por Veto de Régimen y Candado Post-Stop)
        const currentRegime = item.jevJudgment?.regime || "BALANCED_RANGE";

        // 1. Veto Preventivo de Jev: En DEFENSIVE_STRESS está estrictamente prohibido abrir nuevas compras
        if (currentRegime === "DEFENSIVE_STRESS") {
          continue;
        }

        // 2. Desbloqueo Inteligente de Laya (Sin reloj ciego de 16h)
        if (item.awaitingLayaRecovery) {
          const isHealthy = ofiMetrics.ofiScore > 0.20 && (layaJudgments.toxicFlow ?? 0) < 0.35 && !isToxic;
          if (!isHealthy) {
            continue; // Mantener liquidez mientras el libro siga tóxico
          }
          console.log(`[LAYA RECOVERY] ${ticker} libro estabilizado (OFI: ${ofiMetrics.ofiScore.toFixed(2)}). Veto levantado.`);
          item.awaitingLayaRecovery = false;
          item.postShockRecovery = true; // Activar Lote Asimétrico del 30%
        }

        if (item.bot.circuitBreakerActive || isToxic) {
          continue;
        }
        if (item.bot.levels.length > 0) {
          item.bot.levels = [];
        }
        if (isUpwardTrend && (layaJudgments.toxicFlow ?? 0) <= 0.60) {
          // Evaluar temperatura térmica de mercado (HOT, BALANCED, COLD)
          const temp = MarketTemperatureMonitor.getTemperature(ticker, item.priceHistory || [midPrice]);
          const regimeMultiplier = currentRegime === "AGGRESSIVE_ACCUMULATION" ? 1.20 : 1.0;
          const combinedStopMultiplier = parseFloat((regimeMultiplier * temp.stopMultiplier).toFixed(2));
          const combinedSpacingMultiplier = temp.spacingMultiplier;

          // Lote Dinámico Asimétrico: Si estamos saliendo de un shock, operar con cuota reducida al 30%
          const exposureFraction = item.postShockRecovery ? item.bot.currentExposureCap * 0.30 : item.bot.currentExposureCap;

          if (isLive) {
            if (this.hasPendingLiveOrder(ticker, { kinds: ["OPEN_GRID"] })) continue;
            const l1Qty = this.estimateGridL1Qty(item, midPrice);
            await this.submitLiveOrder(ticker, "buy", midPrice, l1Qty, {
              kind: "OPEN_GRID",
              ticker,
              exposureFraction,
              stopMultiplier: combinedStopMultiplier,
              spacingMultiplier: combinedSpacingMultiplier,
            });
            continue; // La malla se abrirá solo cuando Binance confirme el fill L1.
          }

          item.bot._open(midPrice, 0, exposureFraction, combinedStopMultiplier, combinedSpacingMultiplier);
          console.log(`[GRID RE-ENTRY ${orch.getExecutionMode()}] Abierta nueva malla para ${ticker} a $${midPrice.toFixed(2)} USD (Régimen: ${currentRegime} [${temp.regime}], Spacing Mult: ${combinedSpacingMultiplier}x, Stop Mult: ${combinedStopMultiplier}x, Exposición: ${(exposureFraction * 100).toFixed(1)}%)`);
        }
      }
    }
  }
}
