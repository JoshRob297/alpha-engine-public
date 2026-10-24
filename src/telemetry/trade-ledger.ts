/**
 * Trade History Ledger & Performance Metrics Manager
 * Registra cada ejecucion (fills, TP, stops, rebalanceos DEX)
 * calculando retornos porcentuales, win rate y profit factor.
 */

export type TradeComponent =
  | "GRID_FILL"
  | "PINGPONG"
  | "DCA_OUT"
  | "FRONT_RUN"
  | "TAKE_PROFIT"
  | "HARD_STOP"
  | "EMERGENCY"
  | "DEX_FEE"
  | "OTHER";

import type { TradeContext } from "./trade-context.js";

export interface TradeHistoryItem {  id: string;
  timestamp: string;
  mode?: "PAPER" | "LIVE";
  venue: "BASE_DEX" | "BINANCE_SPOT";
  assetOrPool: string;
  action: "BUY_GRID" | "TAKE_PROFIT" | "STOP_LOSS" | "DEX_REBALANCE" | "DEFENSIVE_PAUSE" | string;
  price: number;
  amount: number;
  pnlNet: number;
  pnlPct: number;
  feeSavedOrPaid: number;
  poolFeesAccruedUsd?: number;
  /** Categoría de atribución de la operación (Fase 0). */
  component?: TradeComponent;
  /** Comisión real cobrada por el exchange (USD). */
  feePaidUsd?: number;
  /** Liquidez de ejecución: Maker (post-only) o Taker (mercado). */
  liquidity?: "MAKER" | "TAKER";
  /** Slippage real observado en ejecución Taker (USD). */
  slippageUsd?: number;
  /**
   * Contexto de la decision (provenance): regimen, OFI, toxicidad, juicio de Laya,
   * modelo de IL y version del motor. Sin esto el cierre no es reconstruible.
   */
  context?: TradeContext | Record<string, unknown>;
}

export interface ComponentAttribution {
  component: TradeComponent;
  trades: number;
  grossPnlUsd: number;
  feesUsd: number;
  slippageUsd: number;
  netPnlUsd: number;
  winRatePct: number;
}

export interface PortfolioSummaryMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRatePct: number;
  profitFactor: number;
  totalPnlRealizedUsd: number;
  totalPnlDexUsd: number;
  totalFeePaidUsd: number;
  totalSlippageUsd: number;
  netPnlAfterCostsUsd: number;
  effectiveAprPct: number;
  maxDrawdownPct: number;
  worstTradePct: number;
}

/** Clasifica una acción del ledger en su componente de atribución. */
export function classifyTradeComponent(action: string): TradeComponent {
  const a = (action || "").toUpperCase();
  if (a.includes("PINGPONG")) return "PINGPONG";
  if (a.includes("FRONT_RUN") || a.includes("FRONTRUN")) return "FRONT_RUN";
  if (a.includes("EMERGENCY")) return "EMERGENCY";
  if (a.includes("HARD_STOP")) return "HARD_STOP";
  if (a.includes("TP_PARTIAL") || a.includes("SELL_FRACTION") || a.includes("DCA")) return "DCA_OUT";
  if (a.includes("TAKE_PROFIT") || a.includes("SELL")) return "TAKE_PROFIT";
  if (a.includes("BUY_GRID") || a.includes("GRID_FILL")) return "GRID_FILL";
  if (a.includes("DEX_")) return "DEX_FEE";
  return "OTHER";
}

/**
 * Proveedor de contexto de operacion (provenance). Lo registra el motor al arrancar y
 * permite enriquecer cada cierre con el estado que lo produjo sin tocar los 11 puntos
 * de registro del ledger.
 */
let tradeContextProvider:
  | ((trade: TradeHistoryItem) => TradeContext | Record<string, unknown> | undefined)
  | null = null;

export function setTradeContextProvider(
  fn: ((trade: TradeHistoryItem) => TradeContext | Record<string, unknown> | undefined) | null
): void {
  tradeContextProvider = fn;
}

export class TradeLedger {
  private history: TradeHistoryItem[] = [];
  private maxItems: number;
  private smoothedApr: number = 68.92;

  constructor(maxItems = 2000) {
    this.maxItems = maxItems;
  }

  public recordTrade(item: Omit<TradeHistoryItem, "id">): TradeHistoryItem {
    const fullItem: TradeHistoryItem = {
      ...item,
      component: item.component || classifyTradeComponent(item.action),
      id: "tr_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
    };

    // Provenance: si el cierre no trae contexto, se lo pide al proveedor registrado
    // (el motor). Se hace aqui para cubrir TODOS los puntos de registro sin duplicar
    // la construccion del contexto en cada call site.
    if (!fullItem.context && tradeContextProvider) {
      try {
        const ctx = tradeContextProvider(fullItem);
        if (ctx) fullItem.context = ctx;
      } catch {}
    }

    this.history.unshift(fullItem);
    if (this.history.length > this.maxItems) {
      this.history = this.history.slice(0, this.maxItems);
    }
    return fullItem;
  }

  public getHistory(): TradeHistoryItem[] {
    return this.history;
  }

  /**
   * Atribución de PnL realizada por componente (Fase 0).
   * Permite saber qué parte del sistema aporta y qué parte resta.
   */
  public getAttribution(filterMode?: "PAPER" | "LIVE"): ComponentAttribution[] {
    const list = filterMode ? this.history.filter((t) => (t.mode || "PAPER") === filterMode) : this.history;
    const groups = new Map<TradeComponent, TradeHistoryItem[]>();

    for (const t of list) {
      const comp = t.component || classifyTradeComponent(t.action);
      if (!groups.has(comp)) groups.set(comp, []);
      groups.get(comp)!.push(t);
    }

    const result: ComponentAttribution[] = [];
    for (const [component, items] of groups.entries()) {
      const grossPnlUsd = items.reduce((a, t) => a + (t.pnlNet || 0), 0);
      const feesUsd = items.reduce((a, t) => a + (t.feePaidUsd ?? t.feeSavedOrPaid ?? 0), 0);
      const slippageUsd = items.reduce((a, t) => a + (t.slippageUsd || 0), 0);
      const wins = items.filter((t) => (t.pnlNet || 0) > 0).length;
      const losses = items.filter((t) => (t.pnlNet || 0) < 0).length;
      const decisive = wins + losses;

      result.push({
        component,
        trades: items.length,
        grossPnlUsd: parseFloat(grossPnlUsd.toFixed(4)),
        feesUsd: parseFloat(feesUsd.toFixed(4)),
        slippageUsd: parseFloat(slippageUsd.toFixed(4)),
        netPnlUsd: parseFloat((grossPnlUsd - feesUsd - slippageUsd).toFixed(4)),
        winRatePct: decisive > 0 ? parseFloat(((wins / decisive) * 100).toFixed(1)) : 0,
      });
    }

    return result.sort((a, b) => b.netPnlUsd - a.netPnlUsd);
  }

  public loadHistory(items: TradeHistoryItem[]) {
    this.history = Array.isArray(items) ? items.slice(0, this.maxItems) : [];
  }

  public calculateMetrics(
    initialEquityUsd = 1000,
    initialCapitalDexUsd = 240,
    filterMode?: "PAPER" | "LIVE",
    accruedDexFeesUsd = 0,
    dynamicDexAprPct?: number
  ): PortfolioSummaryMetrics {
    const list = filterMode ? this.history.filter((t) => (t.mode || "PAPER") === filterMode) : this.history;
    const closed = list.filter(
      (t) =>
        t.action.includes("TAKE_PROFIT") ||
        t.action.includes("TP_") ||
        t.action.includes("STOP") ||
        t.action.includes("EMERGENCY") ||
        t.action.includes("DEX_")
    );
    const wins = closed.filter((t) => t.pnlNet > 0);
    const losses = closed.filter((t) => t.pnlNet < 0);

    // Homogeneidad de unidades: todos los trades se registran nativamente en USD.
    const winsNormalized = wins.map((t) => t.pnlNet);
    const lossesNormalized = losses.map((t) => t.pnlNet);

    const grossProfit = winsNormalized.reduce((acc, v) => acc + v, 0);
    const grossLoss = Math.abs(lossesNormalized.reduce((acc, v) => acc + v, 0));

    // Win rate computado estrictamente sobre trades cerrados decisivos (con PnL != 0)
    const decisiveTrades = wins.length + losses.length;
    const totalTrades = closed.length;
    const winRatePct = decisiveTrades > 0 ? (wins.length / decisiveTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 1.0;

    const totalPnlRealizedUsd = closed
      .filter((t) => t.venue !== "BASE_DEX")
      .reduce((acc, t) => acc + t.pnlNet, 0);
    const closedDexPnl = list
      .filter((t) => t.venue === "BASE_DEX")
      .reduce((acc, t) => acc + t.pnlNet, 0);
    const totalPnlDexUsd = closedDexPnl + accruedDexFeesUsd;

    // Costos reales (fees + slippage) sobre trades cerrados de CEX.
    const cexClosed = closed.filter((t) => t.venue !== "BASE_DEX");
    const totalFeePaidUsd = cexClosed.reduce((a, t) => a + (t.feePaidUsd ?? 0), 0);
    const totalSlippageUsd = cexClosed.reduce((a, t) => a + (t.slippageUsd ?? 0), 0);
    const netPnlAfterCostsUsd = totalPnlRealizedUsd - totalFeePaidUsd - totalSlippageUsd;

    // Suavizado EMA(20) sobre el APR dinámico para evitar saltos abruptos por volatilidad de un solo pool
    if (dynamicDexAprPct !== undefined && dynamicDexAprPct > 0) {
      const k = 2 / (20 + 1); // Alpha para EMA(20)
      this.smoothedApr = dynamicDexAprPct * k + this.smoothedApr * (1 - k);
    }

    // Curva de Equity para Max Drawdown sobre trades cerrados (en orden cronológico)
    const chronologicalClosed = [...closed].reverse();
    let peakCumulative = 0;
    let maxDrawdownAbs = 0;
    let currentCumulative = 0;

    for (const t of chronologicalClosed) {
      currentCumulative += t.pnlNet;
      if (currentCumulative > peakCumulative) {
        peakCumulative = currentCumulative;
      }
      const dd = peakCumulative - currentCumulative;
      if (dd > maxDrawdownAbs) {
        maxDrawdownAbs = dd;
      }
    }

    // Capital base de referencia para el cálculo de Drawdown relativo
    const effectiveBase = initialEquityUsd > 0 ? initialEquityUsd : 1000;
    const maxDrawdownPct = effectiveBase > 0 ? (maxDrawdownAbs / effectiveBase) * 100 : 0;

    // Peor pérdida porcentual registrada en una sola operación
    let worstTradePct = 0;
    if (losses.length > 0) {
      worstTradePct = Math.min(...losses.map((t) => t.pnlPct));
    }

    return {
      totalTrades,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRatePct: parseFloat(winRatePct.toFixed(1)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      totalPnlRealizedUsd: parseFloat(totalPnlRealizedUsd.toFixed(2)),
      totalPnlDexUsd: parseFloat(totalPnlDexUsd.toFixed(4)),
      totalFeePaidUsd: parseFloat(totalFeePaidUsd.toFixed(4)),
      totalSlippageUsd: parseFloat(totalSlippageUsd.toFixed(4)),
      netPnlAfterCostsUsd: parseFloat(netPnlAfterCostsUsd.toFixed(4)),
      effectiveAprPct: parseFloat(this.smoothedApr.toFixed(2)),
      maxDrawdownPct: parseFloat(maxDrawdownPct.toFixed(2)),
      worstTradePct: parseFloat(worstTradePct.toFixed(2)),
    };
  }
}
