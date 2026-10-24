/**
 * Adaptador de backtests de Freqtrade (formato `backtest-result-*.json`).
 *
 * Freqtrade exporta `strategy.<Nombre>.trades[]` con `amount`, `open_rate`, `close_rate`,
 * `fee_open`, `fee_close` y `profit_abs`. `profit_abs` es NETO, pero las fees quedan como
 * tasas: se derivan por trade para que el dataset canonico tenga costes explicitos y el
 * kit pueda verificarlos contra precios.
 *
 * Advertencia: un backtest es IN-SAMPLE. El veredicto mide robustez interna, no evidencia
 * out-of-sample.
 */

import { buildDataset, type CanonicalDataset } from "../canonical.js";

export interface FreqtradeTrade {
  pair?: string;
  amount?: number;
  open_rate?: number;
  close_rate?: number;
  fee_open?: number;
  fee_close?: number;
  profit_abs?: number;
  open_timestamp?: number;
  close_timestamp?: number;
  is_open?: boolean;
  exit_reason?: string;
  is_short?: boolean;
}

export interface FreqtradeStrategyResult {
  trades?: FreqtradeTrade[];
  starting_balance?: number;
  stake_currency?: string;
  backtest_start_ts?: number;
  backtest_end_ts?: number;
  total_trades?: number;
  profit_total_abs?: number;
  profit_total?: number;
  profit_factor?: number;
  winrate?: number;
  max_drawdown_account?: number;
}

export interface FreqtradeBacktest {
  strategy?: Record<string, FreqtradeStrategyResult>;
  [k: string]: unknown;
}

export interface FreqtradeAdaptResult {
  dataset: CanonicalDataset;
  strategy: string;
  strategies: string[];
  meta: {
    startingBalance?: number;
    currency?: string;
    from?: string | null;
    to?: string | null;
    reportedProfitAbs?: number;
    reportedProfitFactor?: number;
    reportedWinrate?: number;
    reportedMaxDrawdown?: number;
    grossUsd: number;
    feesUsd: number;
    netUsd: number;
    wins: number;
    losses: number;
  };
}

const round = (v: number, d = 6) => {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
};

/**
 * @param raw JSON parseado del backtest
 * @param strategy nombre a usar; si se omite, la estrategia con mas trades
 */
export function adaptFreqtradeBacktest(raw: FreqtradeBacktest, strategy?: string, source = "backtest-result.json"): FreqtradeAdaptResult {
  const strategies = raw?.strategy && typeof raw.strategy === "object" ? Object.keys(raw.strategy) : [];
  if (strategies.length === 0) {
    throw new Error("No es un backtest-result de Freqtrade: falta la clave 'strategy'.");
  }
  const chosen =
    strategy && raw.strategy![strategy]
      ? strategy
      : strategies.reduce((best, name) => {
          const n = (raw.strategy![name]?.trades?.length ?? 0);
          const bestN = (raw.strategy![best]?.trades?.length ?? 0);
          return n > bestN ? name : best;
        }, strategies[0]);
  const result = raw.strategy![chosen];
  const allTrades = Array.isArray(result.trades) ? result.trades : [];
  const trades = allTrades.filter((t) => !t.is_open && t.close_timestamp);

  if (trades.length === 0) {
    throw new Error(`La estrategia ${chosen} no tiene trades cerrados exportados (¿se corrio con --export trades?).`);
  }

  let gross = 0;
  let fees = 0;
  let net = 0;
  let wins = 0;
  let losses = 0;

  const canonical = trades.map((t) => {
    const qty = Number(t.amount) || 0;
    const entry = Number(t.open_rate) || 0;
    const exit = Number(t.close_rate) || 0;
    const feeOpen = Number(t.fee_open) || 0;
    const feeClose = Number(t.fee_close) || 0;
    const feesUsd = round(qty * entry * feeOpen + qty * exit * feeClose);
    const grossUsd = round((exit - entry) * qty);
    const netUsd = Number.isFinite(Number(t.profit_abs)) ? round(Number(t.profit_abs)) : round(grossUsd - feesUsd);
    gross += grossUsd;
    fees += feesUsd;
    net += netUsd;
    if (netUsd > 0) wins++;
    else if (netUsd < 0) losses++;
    return {
      id: undefined,
      ts: new Date(Number(t.close_timestamp)).toISOString(),
      venue: "CEX" as const,
      symbol: String(t.pair ?? "UNKNOWN").replace("/", ""),
      qty,
      entryPrice: entry,
      exitPrice: exit,
      feesUsd,
      slippageUsd: 0,
      grossPnlUsd: grossUsd,
      netPnlUsd: netUsd,
      reportedNetPnlUsd: netUsd,
      pnlSource: "derived" as const,
    };
  });

  const dataset = buildDataset({
    source,
    adapter: "freqtrade",
    account: {
      capitalUsd: Number(result.starting_balance) || undefined,
      currency: result.stake_currency,
    },
    trades: canonical,
    issues: [],
  });

  const first = trades[0];
  const last = trades[trades.length - 1];
  return {
    dataset,
    strategy: chosen,
    strategies,
    meta: {
      startingBalance: Number(result.starting_balance) || undefined,
      currency: result.stake_currency,
      from: first?.open_timestamp ? new Date(Number(first.open_timestamp)).toISOString() : null,
      to: last?.close_timestamp ? new Date(Number(last.close_timestamp)).toISOString() : null,
      reportedProfitAbs: Number(result.profit_total_abs),
      reportedProfitFactor: Number(result.profit_factor),
      reportedWinrate: Number(result.winrate),
      reportedMaxDrawdown: Number(result.max_drawdown_account),
      grossUsd: round(gross, 2),
      feesUsd: round(fees, 2),
      netUsd: round(net, 2),
      wins,
      losses,
    },
  };
}
