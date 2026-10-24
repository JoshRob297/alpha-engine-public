// GridBot blindado con Circuit Breakers y Sizing Defensivo (Half-Kelly)

import { rolling, zscore, type PriceSeries } from "./series.js";

export const FAMILIES = ["MOMENTUM", "MEAN REVERT", "VOL BREAKOUT", "RANGE GRID"] as const;
export type Family = (typeof FAMILIES)[number];

export const FEE = 0.0010; // Binance Spot Maker Fee (0.10%)

export interface Genome {
  family: number;
  lookback: number;
  entryZ: number;
  levels: number;
  spacing: number;
  mult: number;
  tp: number;
  stop: number;
}

/**
 * Genoma por defecto (RANGE GRID) usado cuando no hay genoma evolucionado disponible.
 * Fuente única de verdad para todo el sistema.
 */
export const DEFAULT_GENOME: Genome = {
  family: 3, // RANGE GRID
  lookback: 54,
  entryZ: 2.2,
  levels: 2,
  spacing: 0.004,
  mult: 1.1,
  tp: 0.038,
  stop: 0.075,
};

export interface GridLevel {
  name: string;
  price: number;
  usd: number;
  filled: boolean;
  t: number;
  fillPrice?: number;
}

export interface TradeRecord {
  pnl: number;
  ret: number;
  bars: number;
  exit: string;
  i: number;
}

export interface BotMetrics {
  ret: number;
  maxDD: number;
  trades: number;
  winRate: number;
  payoff: number;
  exposure: number;
}

export interface OrderBookState {
  spreadBps: number;
  bidAskImbalance: number; // bids / (bids + asks) de los primeros niveles
  volumeSpike1m: number;   // ratio vs media movil de volumen
}

export function signal(g: Genome, s: PriceSeries, j: number) {
  if (j < g.lookback) return { ok: false, z: 0 };
  const z = zscore(s, g.lookback, j);
  switch (g.family) {
    case 0:
      return { ok: z > g.entryZ && s.close[j] > s.close[j - 1], z };
    case 1:
      return { ok: z < -g.entryZ, z };
    case 2: {
      const hh = rolling(s, g.lookback).hh[j];
      const lvl = hh * (1 + g.entryZ * 0.001);
      return { ok: s.close[j] > lvl, z };
    }
    default: {
      const r = rolling(s, g.lookback);
      const width = r.std[j] / r.mean[j];
      return { ok: Math.abs(z) < g.entryZ * 0.5 && width < 0.02, z };
    }
  }
}

export class GridBot {
  public g: Genome;
  public cash: number;
  public start: number;
  public qty: number;
  public cost: number;
  public levels: GridLevel[];
  public tp: number;
  public stop: number;
  public trades: TradeRecord[];
  public openedAt: number;
  public peak: number;
  public maxDD: number;
  public bars: number;
  public exposed: number;
  public circuitBreakerActive: boolean;

  constructor(genome: Genome, equity = 10000) {
    this.g = genome;
    this.cash = equity;
    this.start = equity;
    this.qty = 0;
    this.cost = 0;
    this.levels = [];
    this.tp = 0;
    this.stop = 0;
    this.trades = [];
    this.openedAt = -1;
    this.peak = equity;
    this.maxDD = 0;
    this.bars = 0;
    this.exposed = 0;
    this.circuitBreakerActive = false;
  }

  get inPos() {
    return this.qty > 0;
  }
  get avg() {
    return this.qty > 0 ? this.cost / this.qty : 0;
  }
  equity(price: number) {
    return this.cash + this.qty * price;
  }

  /**
   * PUNTO CIEGO 2 CORREGIDO: Circuit Breaker asincrono de microestructura
   * Se evalua en tiempo real independiente del cierre de la vela de 1h
   */
  public checkCircuitBreaker(book: OrderBookState): boolean {
    // 1. Expansion anomala de spread (>40 bps indica falta de liquidez o inicio de flash crash)
    if (book.spreadBps > 40) {
      this.circuitBreakerActive = true;
      return true;
    }
    // 2. Colapso del lado comprador (imbalance < 0.20 significa que los vendedores dominan 4 a 1)
    if (book.bidAskImbalance < 0.20) {
      this.circuitBreakerActive = true;
      return true;
    }
    this.circuitBreakerActive = false;
    return false;
  }

  step(s: PriceSeries, i: number, toxicFlow = 0, bookState?: OrderBookState) {
    const g = this.g;

    // Verificar Circuit Breaker si hay datos de microestructura
    if (bookState && this.checkCircuitBreaker(bookState)) {
      // Congelar cualquier orden o cerrar si el estres es sistemico
      return;
    }

    // Si toxic_flow es elevado (>0.70), Laya bloquea aperturas nuevas
    if (!this.inPos && i > 0 && toxicFlow < 0.70 && !this.circuitBreakerActive) {
      const sig = signal(g, s, i - 1);
      if (sig.ok) this._open(s.open[i], i);
    }

    if (this.inPos) {
      // Adverse-first: fills primero, luego stop, luego TP
      for (const L of this.levels) {
        // Bloquear llenados mas profundos si hay toxic flow (>0.85) o Circuit Breaker
        if (!L.filled && s.low[i] <= L.price && toxicFlow < 0.85 && !this.circuitBreakerActive) {
          this._fill(L, L.price, i);
        }
      }
      this.tp = this.avg * (1 + g.tp);
      if (s.low[i] <= this.stop) this._close(this.stop, i, "STOP");
      else if (s.high[i] >= this.tp) this._close(this.tp, i, "TP");
    }

    const eq = this.equity(s.close[i]);
    this.peak = Math.max(this.peak, eq);
    this.maxDD = Math.max(this.maxDD, 1 - eq / this.peak);
    this.bars++;
    if (this.inPos) this.exposed++;
  }

  public currentExposureCap: number = 0.60;

  /**
   * Sizing Dinamico Adaptativo (governed by Jev / Laya hasta el 60%)
   * Limita la exposicion total de la malla al porcentaje objetivo (default 60%),
   * modula el espaciado según temperatura de mercado y escala el stop loss
   */
  _open(price: number, i: number, customExposureCap?: number, stopMultiplier = 1.0, spacingMultiplier = 1.0) {
    const g = this.g;
    const currentEquity = this.equity(price);

    const cap = customExposureCap !== undefined ? customExposureCap : this.currentExposureCap;
    // Exposición de la cuenta asignada a toda la malla activa (20% a 60%)
    const maxGridExposure = currentEquity * cap;
    const allocatedCapital = Math.min(this.cash, maxGridExposure);

    let w = 0;
    for (let k = 0; k < g.levels; k++) w += Math.pow(g.mult, k);
    const base = allocatedCapital / w;

    // Espaciado térmicamente modulado (0.75x a 1.45x)
    const effectiveSpacing = g.spacing * Math.max(0.70, Math.min(1.50, spacingMultiplier));

    this.levels = [];
    const count = Math.max(1, g.levels || 1);
    for (let k = 0; k < count; k++) {
      this.levels.push({
        name: "L" + (k + 1),
        price: price * (1 - effectiveSpacing * k),
        usd: base * Math.pow(g.mult, k),
        filled: false,
        t: -1,
      });
    }
    const effectiveStopPct = Math.max(0.015, Math.min(0.12, g.stop * stopMultiplier));
    const lastLevelPrice = this.levels.length > 0 ? this.levels[this.levels.length - 1].price : price;
    this.stop = lastLevelPrice * (1 - effectiveStopPct);
    this.openedAt = i;
    this._fill(this.levels[0], price, i);
  }

  _fill(L: GridLevel, price: number, i: number) {
    const usd = Math.min(L.usd, this.cash);
    if (usd <= 0) return;
    this.cash -= usd;
    this.qty += (usd * (1 - FEE)) / price;
    this.cost += usd;
    L.filled = true;
    L.t = i;
    L.fillPrice = price;
  }

  _close(price: number, i: number, why: string) {
    const proceeds = this.qty * price * (1 - FEE);
    const pnl = proceeds - this.cost;
    this.trades.push({ pnl, ret: pnl / this.cost, bars: i - this.openedAt, exit: why, i });
    this.cash += proceeds;
    this.qty = 0;
    this.cost = 0;
    this.levels = [];
    this.tp = 0;
    this.stop = 0;
    this.circuitBreakerActive = false;
  }

  flatten(s: PriceSeries, i: number) {
    if (this.inPos) this._close(s.close[i], i, "EOD");
  }

  metrics(): BotMetrics {
    const t = this.trades;
    const wins = t.filter((x) => x.pnl > 0);
    const losses = t.filter((x) => x.pnl <= 0);
    const avgWin = wins.length ? wins.reduce((a, x) => a + x.ret, 0) / wins.length : 0;
    const avgLoss = losses.length ? -losses.reduce((a, x) => a + x.ret, 0) / losses.length : 0;
    return {
      ret: this.cash / this.start - 1,
      maxDD: this.maxDD,
      trades: t.length,
      winRate: t.length ? wins.length / t.length : 0,
      payoff: avgLoss > 0 ? avgWin / avgLoss : wins.length ? 9.99 : 0,
      exposure: this.bars ? this.exposed / this.bars : 0,
    };
  }

  getTradeReturns(): number[] {
    return this.trades.map((t) => t.ret);
  }
}

export function backtest(
  genome: Genome,
  s: PriceSeries,
  from: number,
  to: number
): { metrics: BotMetrics; tradeReturns: number[] } {
  const bot = new GridBot(genome);
  for (let i = from; i < to; i++) bot.step(s, i);
  bot.flatten(s, to - 1);
  return { metrics: bot.metrics(), tradeReturns: bot.getTradeReturns() };
}
