/**
 * Simulador de Economía DEX (Liquidez Concentrada v3 / Aerodrome Slipstream)
 *
 * Pregunta que responde: ¿la provisión de liquidez concentrada, gobernada por una
 * señal de riesgo, bate a (a) la versión pasiva y (b) simplemente mantener (hold)?
 *
 * Modelo riguroso:
 *  - Valor exacto de una posición concentrada v3 (amount0/amount1 según el precio).
 *  - Impermanent Loss real vs hold, que CRECE con la concentración y se CAPEA al salir del rango.
 *  - Fees proporcionales a la concentración (rango más estrecho = mayor cuota de fees, más IL).
 *  - Gas por rebalanceo/pausa (Base L2).
 *
 * Señal (para DEX el régimen relevante es de minutos-horas, NO la toxicidad en ms de Laya):
 *  - none (pasiva) | vol (pausa ante picos de volatilidad) | trend (pausa ante tendencia)
 *  La señal es pluggable: si en el futuro Laya/Jev demuestran poder predictivo, se inyectan aquí.
 */

import { writeFileSync } from "node:fs";

export interface DexSimConfig {
  rangeHalfWidthPct: number;   // semiancho del rango (ej. 0.065 = ±6.5%)
  feeAprAtWidthPct: number;    // APR de fees a ese ancho (ej. 0.69)
  referenceWidthPct: number;   // ancho de referencia para escalar fees por concentración
  gasPerActionUsd: number;     // gas por rebalanceo/pausa
  rebalanceCooldownBars: number;
  maxFeeAprPct: number;        // tope de APR por concentración extrema
}

export const DEFAULT_DEX_CONFIG: DexSimConfig = {
  rangeHalfWidthPct: 0.065,
  feeAprAtWidthPct: 0.69,
  referenceWidthPct: 0.065,
  gasPerActionUsd: 0.03,
  rebalanceCooldownBars: 6,
  maxFeeAprPct: 3.0,
};

/** Valor de una posición concentrada v3 dado el precio y la liquidez L. */
export function positionAmounts(P: number, L: number, pa: number, pb: number): { amount0: number; amount1: number } {
  const sqrtP = Math.sqrt(P);
  const sqrtA = Math.sqrt(pa);
  const sqrtB = Math.sqrt(pb);
  if (P <= pa) {
    // Todo en token0 (el activo volátil)
    return { amount0: (L * (sqrtB - sqrtA)) / (sqrtA * sqrtB), amount1: 0 };
  }
  if (P >= pb) {
    // Todo en token1 (quote/stable)
    return { amount0: 0, amount1: L * (sqrtB - sqrtA) };
  }
  return {
    amount0: (L * (sqrtB - sqrtP)) / (sqrtP * sqrtB),
    amount1: L * (sqrtP - sqrtA),
  };
}

export interface Position {
  L: number;
  pa: number;
  pb: number;
  segA0: number; // composición del segmento actual (para el hold espejo)
  segA1: number;
}

/** Inicializa una posición con valor V0 centrada en P0 con semiancho w. */
export function initPosition(V0: number, P0: number, w: number): Position {
  const pa = P0 * (1 - w);
  const pb = P0 * (1 + w);
  const probe = positionAmounts(P0, 1, pa, pb);
  const valuePerL = probe.amount0 * P0 + probe.amount1;
  const L = V0 / valuePerL;
  const { amount0, amount1 } = positionAmounts(P0, L, pa, pb);
  return { L, pa, pb, segA0: amount0, segA1: amount1 };
}

export function lpValue(P: number, pos: Position): number {
  const { amount0, amount1 } = positionAmounts(P, pos.L, pos.pa, pos.pb);
  return amount0 * P + amount1;
}

/** Valor del hold espejo de la composición de entrada del segmento actual. */
export function segmentHoldValue(P: number, pos: Position): number {
  return pos.segA0 * P + pos.segA1;
}

export interface DexStrategyResult {
  name: string;
  retPct: number;
  feesUsd: number;
  ilUsd: number;
  gasUsd: number;
  rebalances: number;
  pauses: number;
  inRangePct: number;
  finalNav: number;
}

export interface DexSeries { close: number[]; n: number; }

function realizedVol(s: DexSeries, i: number, lookback = 24): number {
  if (i < lookback) return 0;
  const rets: number[] = [];
  for (let j = i - lookback + 1; j <= i; j++) rets.push(Math.log(s.close[j] / s.close[j - 1]));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length;
  return Math.sqrt(v * 24) * 100; // % diario anualizado-ish
}

function trendStrength(s: DexSeries, i: number, lookback = 72): number {
  if (i < lookback) return 0;
  return Math.abs(s.close[i] / s.close[i - lookback] - 1) * 100;
}

export type SignalMode = "none" | "vol" | "trend";

function isRiskHigh(mode: SignalMode, s: DexSeries, i: number, cfg: DexSimConfig): boolean {
  if (mode === "none") return false;
  if (mode === "vol") return realizedVol(s, i) > 4.0; // >4% vol diaria
  return trendStrength(s, i) > 8.0; // tendencia >8%
}

/**
 * Simula una posición LP de capital V0 sobre la serie, con rebalanceo al salir de rango
 * y pausas gobernadas por la señal.
 */
export function simulateDex(
  name: string,
  s: DexSeries,
  mode: SignalMode,
  feeAprPct: number,
  cfg: DexSimConfig = DEFAULT_DEX_CONFIG
): DexStrategyResult {
  const V0 = 1000;
  const from = 80;
  const to = s.n;

  let feesUsd = 0;
  let gasUsd = 0;
  let rebalances = 0;
  let pauses = 0;
  let barsInRange = 0;
  let barsActive = 0;
  let totalIlUsd = 0;
  let prevIl = 0;

  let entryPrice = s.close[from];
  let pos = initPosition(V0, entryPrice, cfg.rangeHalfWidthPct);
  let paused = false;
  let lastActionBar = -999;

  const annualRate = feeAprPct / 100;
  const feePerBar = (V0 * annualRate) / (365 * 24);

  const reanchor = (i: number) => {
    const P = s.close[i];
    pos = initPosition(V0, P, cfg.rangeHalfWidthPct);
    prevIl = 0;
    lastActionBar = i;
    rebalances++;
    gasUsd += cfg.gasPerActionUsd;
  };

  for (let i = from + 1; i < to; i++) {
    const P = s.close[i];
    const lastP = s.close[i - 1];
    let rebalancedThisBar = false;
    const inRange = P >= pos.pa && P <= pos.pb;
    if (inRange && !paused) barsInRange++;

    const riskHigh = isRiskHigh(mode, s, i, cfg);

    if (mode !== "none") {
      if (riskHigh && !paused) {
        paused = true;
        pauses++;
        gasUsd += cfg.gasPerActionUsd;
      } else if (!riskHigh && paused) {
        paused = false;
        if (i - lastActionBar >= cfg.rebalanceCooldownBars) {
          reanchor(i);
          rebalancedThisBar = true;
        }
      }
    }

    if (!paused) {
      barsActive++;
      if (inRange) feesUsd += feePerBar;
    }

    if (!paused && !inRange && i - lastActionBar >= cfg.rebalanceCooldownBars) {
      reanchor(i);
      rebalancedThisBar = true;
    }

    // IL acumulada vs hold espejo del segmento (se reinicia en cada rebalanceo)
    if (!rebalancedThisBar) {
      const ilNow = lpValue(P, pos) - segmentHoldValue(P, pos);
      totalIlUsd += ilNow - prevIl;
      prevIl = ilNow;
    }
    void lastP;
  }

  const finalP = s.close[to - 1];
  const finalLpValue = paused ? segmentHoldValue(finalP, pos) : lpValue(finalP, pos);
  const netNav = finalLpValue + feesUsd - gasUsd;

  return {
    name,
    retPct: parseFloat(((netNav / V0 - 1) * 100).toFixed(2)),
    feesUsd: parseFloat(feesUsd.toFixed(2)),
    ilUsd: parseFloat(totalIlUsd.toFixed(2)),
    gasUsd: parseFloat(gasUsd.toFixed(2)),
    rebalances,
    pauses,
    inRangePct: barsActive ? parseFloat(((barsInRange / barsActive) * 100).toFixed(1)) : 0,
    finalNav: parseFloat(netNav.toFixed(2)),
  };
}

/** Benchmark: mantener la composición inicial (hold). */
export function simulateHold(s: DexSeries): DexStrategyResult {
  const V0 = 1000;
  const from = 80;
  const to = s.n;
  const pos = initPosition(V0, s.close[from], DEFAULT_DEX_CONFIG.rangeHalfWidthPct);
  const finalP = s.close[to - 1];
  const nav = segmentHoldValue(finalP, pos);
  return {
    name: "Hold",
    retPct: parseFloat(((nav / V0 - 1) * 100).toFixed(2)),
    feesUsd: 0,
    ilUsd: 0,
    gasUsd: 0,
    rebalances: 0,
    pauses: 0,
    inRangePct: 100,
    finalNav: parseFloat(nav.toFixed(2)),
  };
}
