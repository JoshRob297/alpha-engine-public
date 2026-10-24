/**
 * Validacion estadistica del periodo Paper (Alpha Engine).
 *
 * Modulo puro y testeable: recibe estado persistido + series de klines y devuelve
 * las metricas con las que se juzga si la estrategia tiene o no ventaja real.
 *
 * Criterios (pre-registrados en docs/LIVE_PAPER_VALIDATION_2026-10.md):
 *   - Win rate requerido para no perder: avgLoss / (avgLoss + avgWin)
 *   - Expectancy por operacion cerrada con su t de Student
 *   - PF out-of-sample contra el PF in-sample declarado por los genomas
 *   - Atribucion Laya vs OFI en las salidas de microestructura
 */

export interface TradeLike {
  timestamp: string;
  mode?: string;
  venue: string;
  assetOrPool: string;
  action: string;
  price?: number;
  amount?: number;
  pnlNet?: number;
  pnlPct?: number;
  feePaidUsd?: number;
  liquidity?: string;
}

export interface Kline {
  openTimeMs: number;
  close: number;
}

export interface ClosedTradeStats {
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number;
  grossWinUsd: number;
  grossLossUsd: number;
  profitFactor: number;
  avgWinUsd: number;
  avgLossUsd: number;
  avgWinPct: number;
  avgLossPct: number;
  payoffRatio: number;
  expectancyUsd: number;
  sdUsd: number;
  tStat: number;
  ci95LowUsd: number;
  ci95HighUsd: number;
  statisticallySignificant: boolean;
  breakevenWinRatePct: number;
  deficitPp: number;
  targetClosedTrades: number;
  remainingClosedTrades: number;
}

// "TRADE_CLOSED" es la accion canonica neutra para datasets de terceros (audit kit):
// no conocemos el motivo de salida, pero el trade esta cerrado y tiene PnL.
const CLOSED_ACTIONS = ["TP_", "STOP", "EMERGENCY", "TAKE_PROFIT", "TRADE_CLOSED"];

export function isClosedTrade(t: TradeLike): boolean {
  if (t.venue !== "BINANCE_SPOT") return false;
  if (!CLOSED_ACTIONS.some((p) => t.action.includes(p))) return false;
  return Math.abs(t.pnlNet || 0) > 1e-9;
}

export function computeClosedTradeStats(trades: TradeLike[], targetClosedTrades = 191): ClosedTradeStats {
  const closed = trades.filter(isClosedTrade);
  const wins = closed.filter((t) => (t.pnlNet || 0) > 0);
  const losses = closed.filter((t) => (t.pnlNet || 0) < 0);

  const grossWinUsd = wins.reduce((a, t) => a + (t.pnlNet || 0), 0);
  const grossLossUsd = Math.abs(losses.reduce((a, t) => a + (t.pnlNet || 0), 0));
  const n = closed.length;
  const avgWinUsd = wins.length ? grossWinUsd / wins.length : 0;
  const avgLossUsd = losses.length ? grossLossUsd / losses.length : 0;
  const avgWinPct = wins.length ? wins.reduce((a, t) => a + (t.pnlPct || 0), 0) / wins.length : 0;
  const avgLossPct = losses.length ? losses.reduce((a, t) => a + (t.pnlPct || 0), 0) / losses.length : 0;

  const pnls = closed.map((t) => t.pnlNet || 0);
  const mean = n ? pnls.reduce((a, v) => a + v, 0) / n : 0;
  const variance = n > 1 ? pnls.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const se = n > 0 ? sd / Math.sqrt(n) : 0;
  const tStat = se > 0 ? mean / se : 0;

  const breakevenWinRatePct = avgWinUsd + avgLossUsd > 0 ? (avgLossUsd / (avgLossUsd + avgWinUsd)) * 100 : 0;
  const winRatePct = n ? (wins.length / n) * 100 : 0;

  return {
    closed: n,
    wins: wins.length,
    losses: losses.length,
    winRatePct: round(winRatePct, 2),
    grossWinUsd: round(grossWinUsd, 4),
    grossLossUsd: round(grossLossUsd, 4),
    profitFactor: grossLossUsd > 0 ? round(grossWinUsd / grossLossUsd, 4) : grossWinUsd > 0 ? 99.9 : 1,
    avgWinUsd: round(avgWinUsd, 5),
    avgLossUsd: round(avgLossUsd, 5),
    avgWinPct: round(avgWinPct, 3),
    avgLossPct: round(avgLossPct, 3),
    payoffRatio: avgWinUsd > 0 ? round(avgLossUsd / avgWinUsd, 3) : 0,
    expectancyUsd: round(mean, 5),
    sdUsd: round(sd, 5),
    tStat: round(tStat, 3),
    ci95LowUsd: round(mean - 1.96 * se, 5),
    ci95HighUsd: round(mean + 1.96 * se, 5),
    statisticallySignificant: Math.abs(tStat) >= 2,
    breakevenWinRatePct: round(breakevenWinRatePct, 2),
    deficitPp: round(breakevenWinRatePct - winRatePct, 2),
    targetClosedTrades,
    remainingClosedTrades: Math.max(0, targetClosedTrades - n),
  };
}

export interface ExitCounterfactual {
  action: string;
  n: number;
  realizedUsd: number;
  valueAddedUsdByHorizon: Record<string, number>;
  hitRateByHorizon: Record<string, number>;
}

/**
 * Contrafactual de cada salida: que habria pasado si en vez de salir se mantenía
 * la posicion. valueAdded > 0 significa que la salida acerto (el precio cayo despues).
 */
export function computeExitCounterfactuals(
  trades: TradeLike[],
  klinesBySymbol: Record<string, Kline[]>,
  horizonsHours: number[] = [1, 4, 24]
): ExitCounterfactual[] {
  const groups = new Map<string, TradeLike[]>();
  for (const t of trades) {
    if (t.venue !== "BINANCE_SPOT") continue;
    if (!(t.action.startsWith("TP_") || t.action.startsWith("EMERGENCY"))) continue;
    const arr = groups.get(t.action) || [];
    arr.push(t);
    groups.set(t.action, arr);
  }

  const out: ExitCounterfactual[] = [];
  for (const [action, list] of groups) {
    const valueAddedUsdByHorizon: Record<string, number> = {};
    const hitRateByHorizon: Record<string, number> = {};
    for (const h of horizonsHours) {
      let total = 0;
      let hits = 0;
      let counted = 0;
      for (const t of list) {
        const px = priceAt(klinesBySymbol[t.assetOrPool], t.timestamp, h);
        if (px === null) continue;
        const qty = Math.abs(t.amount || 0);
        const va = ((t.price || 0) - px) * qty;
        total += va;
        if (va > 0) hits++;
        counted++;
      }
      valueAddedUsdByHorizon[`h${h}`] = round(total, 4);
      hitRateByHorizon[`h${h}`] = counted ? round((hits / counted) * 100, 1) : 0;
    }
    out.push({
      action,
      n: list.length,
      realizedUsd: round(list.reduce((a, t) => a + (t.pnlNet || 0), 0), 4),
      valueAddedUsdByHorizon,
      hitRateByHorizon,
    });
  }
  return out.sort((a, b) => b.realizedUsd - a.realizedUsd);
}

function priceAt(klines: Kline[] | undefined, isoTs: string, hoursAhead: number): number | null {
  if (!klines || klines.length === 0) return null;
  const t = new Date(isoTs).getTime();
  const target = t + hoursAhead * 3_600_000;
  let chosen: Kline | null = null;
  for (const k of klines) {
    if (k.openTimeMs >= target) {
      chosen = k;
      break;
    }
  }
  if (!chosen) return null;
  return chosen.close;
}

export interface DexSlotAnalytics {
  slot: string;
  feesUsd: number;
  impermanentLossUsd: number;
  gasUsd: number;
  netPnlUsd: number;
  currentCapitalUsd: number;
  initialCapitalUsd: number;
  feeAprPct: number;
  modeledFeeUsdInWindow: number;
  realizedOverModeledPct: number;
  gasOverFees: number;
}

export function computeDexAnalytics(
  dexPositions: Record<string, any>,
  daysElapsed: number
): { slots: DexSlotAnalytics[]; totals: { feesUsd: number; gasUsd: number; ilUsd: number; netPnlUsd: number; gasOverFees: number } } {
  const slots: DexSlotAnalytics[] = [];
  for (const [slot, p] of Object.entries(dexPositions || {})) {
    const fees = num(p.accumulatedFeesUsd);
    const il = num(p.impermanentLossUsd);
    const gas = num(p.gasSpentUsd);
    const capital = num(p.currentCapitalUsd);
    const modeled = capital * (num(p.feeAprPct) / 100) * (daysElapsed / 365);
    slots.push({
      slot,
      feesUsd: round(fees, 4),
      impermanentLossUsd: round(il, 4),
      gasUsd: round(gas, 4),
      netPnlUsd: round(fees - il - gas, 4),
      currentCapitalUsd: round(capital, 4),
      initialCapitalUsd: round(num(p.initialCapitalUsd), 4),
      feeAprPct: round(num(p.feeAprPct), 2),
      modeledFeeUsdInWindow: round(modeled, 4),
      realizedOverModeledPct: modeled > 0 ? round((fees / modeled) * 100, 1) : 0,
      gasOverFees: fees > 0 ? round(gas / fees, 2) : 0,
    });
  }
  const feesUsd = slots.reduce((a, s) => a + s.feesUsd, 0);
  const gasUsd = slots.reduce((a, s) => a + s.gasUsd, 0);
  const ilUsd = slots.reduce((a, s) => a + s.impermanentLossUsd, 0);
  return {
    slots,
    totals: {
      feesUsd: round(feesUsd, 4),
      gasUsd: round(gasUsd, 4),
      ilUsd: round(ilUsd, 4),
      netPnlUsd: round(feesUsd - ilUsd - gasUsd, 4),
      gasOverFees: feesUsd > 0 ? round(gasUsd / feesUsd, 2) : 0,
    },
  };
}

export interface EquityReconciliation {
  cexNavUsd: number;
  dexCapitalUsd: number;
  reconciledUsd: number;
  deployedValueUsd: number | null;
  untradedReserveUsd: number | null;
  unallocatedCashUsd: number | null;
  policyActiveTargetUsd: number | null;
  underDeploymentVsPolicyUsd: number | null;
  phantomCapitalUsd: number | null;
  legacyFormulaUsd: number | null;
  driftUsd: number | null;
  driftPct: number | null;
}

export function computeEquityReconciliation(state: any): EquityReconciliation {
  const cexNavUsd = Object.values((state?.cexPositions || {}) as Record<string, any>).reduce<number>(
    (a, c: any) => a + num(c?.realNavUsd),
    0
  );
  const dexCapitalUsd = Object.values((state?.dexPositions || {}) as Record<string, any>).reduce<number>(
    (a, d: any) => a + num(d?.currentCapitalUsd),
    0
  );
  const e = state?.equity || {};
  const pick = (v: any): number | null => (typeof v === "number" ? v : null);

  const deployedValueUsd = pick(e.deployedValueUsd) ?? round(cexNavUsd + dexCapitalUsd, 2);
  const untradedReserveUsd = pick(e.untradedReserveUsd);
  const unallocatedCashUsd = pick(e.unallocatedCashUsd);
  const legacyFormulaUsd = pick(e.legacyFormulaUsd);
  const capital = num(state?.totalCapitalUsd) || 1;

  // Equity del simulador = desplegado + reserva no operada + reserva capturada.
  const total =
    untradedReserveUsd === null
      ? deployedValueUsd
      : deployedValueUsd + untradedReserveUsd + (unallocatedCashUsd || 0);

  return {
    cexNavUsd: round(cexNavUsd, 2),
    dexCapitalUsd: round(dexCapitalUsd, 2),
    reconciledUsd: round(total, 2),
    deployedValueUsd: round(deployedValueUsd, 2),
    untradedReserveUsd: untradedReserveUsd === null ? null : round(untradedReserveUsd, 2),
    unallocatedCashUsd: unallocatedCashUsd === null ? null : round(unallocatedCashUsd, 2),
    policyActiveTargetUsd: pick(e.policyActiveTargetUsd),
    underDeploymentVsPolicyUsd: pick(e.underDeploymentVsPolicyUsd),
    phantomCapitalUsd: pick(e.phantomCapitalUsd),
    legacyFormulaUsd,
    driftUsd: legacyFormulaUsd === null ? null : round(total - legacyFormulaUsd, 2),
    driftPct: legacyFormulaUsd === null ? null : round(((total - legacyFormulaUsd) / capital) * 100, 3),
  };
}

export interface LayaAttribution {
  total: number;
  ofi: number;
  laya: number;
  both: number;
  other: number;
  layaOnlySharePct: number;
}

/**
 * Atribucion del gatillo de salida. Si triggerSource no esta instrumentado
 * (muestras historicas), se infiere de ofiScore/toxicFlow con los umbrales dados.
 */
export function computeLayaAttribution(
  records: any[],
  ofiThreshold = -0.5,
  toxicThreshold = 0.5
): LayaAttribution {
  let ofi = 0;
  let laya = 0;
  let both = 0;
  let other = 0;
  for (const r of records) {
    let src = r?.triggerSource as string | undefined;
    if (!src) {
      const o = num(r?.metrics?.ofiScore) <= ofiThreshold;
      const l = num(r?.layaJudgment?.toxicFlow) >= toxicThreshold;
      src = o && l ? "BOTH" : o ? "OFI" : l ? "LAYA" : "OTHER";
    }
    if (src === "OFI") ofi++;
    else if (src === "LAYA") laya++;
    else if (src === "BOTH") both++;
    else other++;
  }
  const total = ofi + laya + both + other;
  return {
    total,
    ofi,
    laya,
    both,
    other,
    layaOnlySharePct: total ? round((laya / total) * 100, 1) : 0,
  };
}

export interface BuyHoldRow {
  asset: string;
  startPrice: number;
  endPrice: number;
  buyHoldPct: number;
  realizedNetUsd: number;
  deployedUsd: number;
  strategyPct: number;
  deltaPp: number;
}

export function computeBuyHoldComparison(
  trades: TradeLike[],
  prices: Record<string, { start: number; end: number }>,
  allocatedByAsset: Record<string, number>
): BuyHoldRow[] {
  const rows: BuyHoldRow[] = [];
  for (const [asset, p] of Object.entries(prices)) {
    const symbol = `${asset}USDT`;
    const list = trades.filter((t) => t.venue === "BINANCE_SPOT" && t.assetOrPool === symbol);
    const realizedNetUsd = list.reduce((a, t) => a + (t.pnlNet || 0) - (t.feePaidUsd || 0), 0);
    const deployedUsd = num(allocatedByAsset[asset]);
    const strategyPct = deployedUsd > 0 ? (realizedNetUsd / deployedUsd) * 100 : 0;
    const buyHoldPct = p.start > 0 ? ((p.end - p.start) / p.start) * 100 : 0;
    rows.push({
      asset,
      startPrice: p.start,
      endPrice: p.end,
      buyHoldPct: round(buyHoldPct, 2),
      realizedNetUsd: round(realizedNetUsd, 4),
      deployedUsd: round(deployedUsd, 2),
      strategyPct: round(strategyPct, 2),
      deltaPp: round(strategyPct - buyHoldPct, 2),
    });
  }
  return rows;
}

function num(v: any): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function round(v: number, d: number): number {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
