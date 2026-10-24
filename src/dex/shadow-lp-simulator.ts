/**
 * Shadow LP Simulator (Motor Sombra de Provision de Liquidez Concentrada)
 * Simula una posicion LP en Base (Aerodrome Slipstream o Uniswap v3)
 * incorporando evaluaciones de Laya (System 1) para:
 * 1. Deteccion de flujo toxico / breakout (retirada preventiva de liquidez).
 * 2. Rebalanceo de rango cuando el mercado regresa a la media.
 * 3. Contabilidad continua: Fees Ganadas vs Impermanent Loss vs Costo de Gas.
 */

import { calculateCausalConcentratedRange } from "../guardrails/causal-range-allocator.js";
import { evaluateMarketStateLocal as evaluateMarketState, type LayaJudgments } from "../guardrails/laya-client-local.js";
import { BASE_RPC_URL, AerodromeSlipstreamDriver } from "./aerodrome-contract.js";

// Cache de precio de gas en Base L2 (actualizado cada 60s)
let cachedGasPriceGwei = 0.05; // Base L2 tpicamente opera entre 0.005 y 0.1 Gwei
let lastGasFetchTs = 0;

/**
 * Coste real de gas por operacion on-chain (unidades).
 * Un rebalanceo de liquidez concentrada en Slipstream no es una sola llamada:
 * decreaseLiquidity + collect + mint. Modelar 240k subestimaba el coste real.
 */
export const GAS_UNITS = {
  FEE_COLLECT: 120_000,
  REPOSITION: 420_000,
} as const;

/**
 * Suelo de precio de gas: en la practica Base L2 no baja de este valor, y sin
 * el suelo el modelo devolvia costes de gas de $0.0004 por rebalanceo (irreal).
 */
export const GAS_PRICE_FLOOR_GWEI = 0.005;

/** Fallback de precio de ETH si no hay feed disponible. */
export const ETH_PRICE_FALLBACK_USD = 2600;

/** Coste minimo razonable de una transaccion en Base L2 (USD). */
export const MIN_TX_COST_USD = 0.005;

async function fetchLiveBaseGasPriceGwei(): Promise<number> {
  const now = Date.now();
  if (now - lastGasFetchTs < 60_000) return cachedGasPriceGwei;
  try {
    const res = await fetch(BASE_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      const wei = BigInt(data.result || "0x1dcd6500");
      cachedGasPriceGwei = Number(wei) / 1e9;
      lastGasFetchTs = now;
    }
  } catch {}
  return cachedGasPriceGwei;
}

// Gas estimado dinámico en USD basado en el gasPrice real de Base L2 y ETH
// Consulta eth_estimateGas real si se pasa la llamada calldata, con fallback a unidades típicas
async function estimateGasCostUsd(gasUnitsOrData: number | { from: string; data: string }, ethPriceUsd = ETH_PRICE_FALLBACK_USD): Promise<number> {
  const gasPriceGwei = Math.max(await fetchLiveBaseGasPriceGwei(), GAS_PRICE_FLOOR_GWEI);
  let gasUnits = typeof gasUnitsOrData === "number" ? gasUnitsOrData : GAS_UNITS.REPOSITION;

  if (typeof gasUnitsOrData === "object") {
    try {
      const driver = new AerodromeSlipstreamDriver();
      gasUnits = await driver.estimateGas(gasUnitsOrData.from, gasUnitsOrData.data);
    } catch {}
  }

  const ethCost = (gasUnits * gasPriceGwei) / 1e9;
  const usd = ethCost * ethPriceUsd;
  // Piso de coste por transaccion: evita modelar gas gratuito por redondeo.
  return parseFloat(Math.max(usd, MIN_TX_COST_USD).toFixed(5));
}

export interface PoolState {
  symbol: string;
  chain: string;
  protocol: string;
  price: number;
  feeAprPct: number;
  volume24hUsd: number;
  tvlUsd: number;
}

export interface ShadowPosition {
  initialCapitalUsd: number;
  currentCapitalUsd: number;
  lowerRangePrice: number;
  upperRangePrice: number;
  entryPrice: number;
  accumulatedFeesUsd: number;
  impermanentLossUsd: number;
  /** IL con la formula de rango completo (comparabilidad historica). */
  impermanentLossFullRangeUsd?: number;
  gasSpentUsd: number;
  status: "ACTIVE" | "PAUSED_DEFENSIVE" | "OUT_OF_RANGE";
  totalRebalances: number;
  defensivePauses: number;
}

/**
 * Calculo matematico de Impermanent Loss para liquidez concentrada simplificada
 *
 * ATENCION (verificado el 2026-10-16): esta funcion recibe los limites del rango
 * pero los IGNORA; su resultado es el de un rango completo (v2). En un LP
 * concentrado el IL es amplificado. Se mantiene por compatibilidad con la
 * comparabilidad historica de la corrida; el valor correcto esta en
 * `calculateConcentratedIlRatio` y la verificacion en
 * `scripts/verify-open-items.ts`.
 */
function calculateImpermanentLoss(entryPrice: number, currentPrice: number, lowerPrice: number, upperPrice: number): number {
  if (entryPrice <= 0 || currentPrice <= 0) return 0;
  const k = currentPrice / entryPrice;
  // Formula estandar Uniswap V3 IL relativo dentro del rango
  const sqrtK = Math.sqrt(k);
  const ilFraction = (2 * sqrtK) / (1 + k) - 1;
  return Math.abs(ilFraction);
}

/**
 * IL de rango completo (limite de la posicion concentrada cuando el rango tiende
 * a infinito). Es la forma cerrada que usa `calculateImpermanentLoss`.
 * Devuelve la perdida como fraccion positiva (0.01 = 1%).
 */
export function calculateFullRangeIlFraction(entryPrice: number, currentPrice: number): number {
  if (entryPrice <= 0 || currentPrice <= 0) return 0;
  const k = currentPrice / entryPrice;
  const sqrtK = Math.sqrt(k);
  return Math.abs((2 * sqrtK) / (1 + k) - 1);
}

/**
 * IL correcto para liquidez concentrada (Uniswap v3 / Slipstream) sobre [lower, upper].
 *
 * Definicion: el IL es la perdida de valor de la posicion LP frente a mantener la
 * MISMA mezcla inicial de tokens. Con L normalizado a 1:
 *   x(p) = 1/sqrt(p) - 1/sqrt(upper)   (token base)
 *   y(p) = sqrt(p) - sqrt(lower)       (token cotizacion)
 *   V_lp(p)   = x(p)*p + y(p)   (con p acotado al rango: fuera de rango la posicion
 *                                queda de un solo lado y deja de seguir el precio)
 *   V_hold(p) = x(entry)*p + y(entry)
 *   IL(p) = 1 - V_lp(p)/V_hold(p)   (positivo = perdida)
 *
 * Cuando lower -> 0 y upper -> infinito converge a `calculateFullRangeIlFraction`.
 */
export function calculateConcentratedIlFraction(
  entryPrice: number,
  currentPrice: number,
  lowerPrice: number,
  upperPrice: number
): number {
  if (entryPrice <= 0 || currentPrice <= 0 || lowerPrice <= 0 || upperPrice <= lowerPrice) return 0;
  const entry = Math.min(Math.max(entryPrice, lowerPrice), upperPrice);

  const sqrt = Math.sqrt;
  const lower = Math.max(lowerPrice, Number.MIN_VALUE);
  const upper = upperPrice;

  const xOf = (p: number) => 1 / sqrt(p) - 1 / sqrt(upper);
  const yOf = (p: number) => sqrt(p) - sqrt(lower);

  // Cantidad de tokens de la posicion: dentro del rango depende del precio; fuera
  // del rango la posicion queda de un solo lado (los montos se congelan en el borde)
  // pero se valoran al precio REAL de mercado.
  const pForAmounts = Math.min(Math.max(currentPrice, lower), upper);
  const valueLp = xOf(pForAmounts) * currentPrice + yOf(pForAmounts);

  // Valor de mantener la mezcla inicial, valuada al precio actual.
  const valueHold = xOf(entry) * currentPrice + yOf(entry);
  if (valueHold <= 0) return 0;

  const ratio = valueLp / valueHold;
  return Math.max(0, 1 - ratio);
}


export class ShadowLPEngine {
  private position: ShadowPosition;
  private pool: PoolState;

  constructor(pool: PoolState, initialCapitalUsd = 1000, jevRegime = "BALANCED_RANGE") {
    this.pool = pool;
    const initialBounds = calculateCausalConcentratedRange(pool.price, jevRegime, 0.8);
    this.position = {
      initialCapitalUsd,
      currentCapitalUsd: initialCapitalUsd,
      entryPrice: pool.price,
      lowerRangePrice: initialBounds.lowerPrice,
      upperRangePrice: initialBounds.upperPrice,
      accumulatedFeesUsd: 0,
      impermanentLossUsd: 0,
      impermanentLossFullRangeUsd: 0,
      gasSpentUsd: 0,
      status: "ACTIVE",
      totalRebalances: 0,
      defensivePauses: 0,
    };
  }

  public restoreState(saved: Partial<ShadowPosition>) {
    if (!saved) return;
    // Restaurar TODO el estado contable. Sin initialCapitalUsd/IL/gas persistidos
    // el PnL del tramo DEX no era auditable: tras cada reinicio o rotacion el
    // coste base se reseteaba al monto reasignado y el IL/gas quedaban en cero.
    if (typeof saved.initialCapitalUsd === "number" && saved.initialCapitalUsd > 0)
      this.position.initialCapitalUsd = saved.initialCapitalUsd;
    if (typeof saved.currentCapitalUsd === "number") this.position.currentCapitalUsd = saved.currentCapitalUsd;
    if (typeof saved.entryPrice === "number" && saved.entryPrice > 0) this.position.entryPrice = saved.entryPrice;
    if (typeof saved.lowerRangePrice === "number" && saved.lowerRangePrice > 0) this.position.lowerRangePrice = saved.lowerRangePrice;
    if (typeof saved.upperRangePrice === "number" && saved.upperRangePrice > 0) this.position.upperRangePrice = saved.upperRangePrice;
    if (typeof saved.accumulatedFeesUsd === "number") this.position.accumulatedFeesUsd = saved.accumulatedFeesUsd;
    if (typeof saved.impermanentLossUsd === "number") this.position.impermanentLossUsd = saved.impermanentLossUsd;
    if (typeof saved.impermanentLossFullRangeUsd === "number")
      this.position.impermanentLossFullRangeUsd = saved.impermanentLossFullRangeUsd;
    if (typeof saved.gasSpentUsd === "number") this.position.gasSpentUsd = saved.gasSpentUsd;
    if (typeof saved.totalRebalances === "number") this.position.totalRebalances = saved.totalRebalances;
    if (typeof saved.defensivePauses === "number") this.position.defensivePauses = saved.defensivePauses;
    if (saved.status) this.position.status = saved.status;
  }

  /**
   * Pausa defensiva manual de la provisión de liquidez (endpoint /pause).
   */
  public pause(): void {
    if (this.position.status === "ACTIVE") {
      this.position.status = "PAUSED_DEFENSIVE";
    }
  }

  /**
   * Reanuda la provisión de liquidez tras una pausa manual (endpoint /resume).
   */
  public resume(): void {
    if (this.position.status === "PAUSED_DEFENSIVE") {
      this.position.status = "ACTIVE";
    }
  }

  /**
   * Ejecuta un ciclo de evaluacion del pool con Laya
   */
  public async step(
    currentPrice: number,
    priceChange1hPct: number,
    judgments?: LayaJudgments,
    jevRegime = "BALANCED_RANGE",
    riskWeight = 0.8,
    temperatureMultiplier = 1.0,
    stepDurationSeconds = 10
  ): Promise<{
    decision: string;
    position: ShadowPosition;
    netPnlUsd: number;
    netPnlPct: number;
  }> {
    this.pool.price = currentPrice;

    // Si no vienen juicios externos, se llama a Laya
    const state = {
      pool: this.pool.symbol,
      protocol: this.pool.protocol,
      current_price: currentPrice,
      price_change_1h_pct: priceChange1hPct,
      in_range: currentPrice >= this.position.lowerRangePrice && currentPrice <= this.position.upperRangePrice,
      range_lower: this.position.lowerRangePrice,
      range_upper: this.position.upperRangePrice,
      jev_regime: jevRegime
    };

    const laya = judgments ?? (await evaluateMarketState(state));

    let decision = "HOLD_ACTIVE";

    // 1. Regla de Proteccion: Flujo toxico o estres severo calibrado dinamicamente por Regimen Macro
    const baseToxic = 0.60;
    const baseStress = 0.65;
    // En regimenes de agresiva acumulacion permitimos mayor volatilidad normal antes de cortar liquidez
    const regimeMult =
      jevRegime === "AGGRESSIVE_ACCUMULATION" ? 1.25 : jevRegime === "DEFENSIVE_STRESS" ? 0.90 : 1.0;
    const toxicThreshold = baseToxic * regimeMult;
    const stressThreshold = baseStress * regimeMult;
    const isToxic = (laya.toxicFlow ?? 0) >= toxicThreshold || (laya.regimeStress ?? 0) >= stressThreshold;

    if (isToxic && this.position.status === "ACTIVE") {
      this.position.status = "PAUSED_DEFENSIVE";
      this.position.defensivePauses += 1;
      this.position.gasSpentUsd += await estimateGasCostUsd(GAS_UNITS.FEE_COLLECT);
      decision = "PAUSE_LIQUIDITY_DEFENSIVE";
    }
    // 2. Regla de Reincorporacion: Mercado calmado y retorno a la media
    else if (!isToxic && this.position.status === "PAUSED_DEFENSIVE") {
      this.position.status = "ACTIVE";
      // Reposicionar el rango centrado en el nuevo precio usando Paridad Causal (Jev + Sets + Temperatura Térmica)
      const newBounds = calculateCausalConcentratedRange(currentPrice, jevRegime, riskWeight, temperatureMultiplier);
      this.position.entryPrice = currentPrice;
      this.position.lowerRangePrice = newBounds.lowerPrice;
      this.position.upperRangePrice = newBounds.upperPrice;
      this.position.totalRebalances += 1;
      this.position.gasSpentUsd += await estimateGasCostUsd(GAS_UNITS.REPOSITION);
      decision = `REPOSITION_CAUSAL_RANGE (${newBounds.description})`;
    }
    // 3. Regla Out of Range (Ruptura del rango)
    else if (
      this.position.status === "ACTIVE" &&
      (currentPrice < this.position.lowerRangePrice || currentPrice > this.position.upperRangePrice)
    ) {
      this.position.status = "OUT_OF_RANGE";
      // Rebalancear solo si Laya confirma que no hay estres tóxico (evitar mechazos falsos)
      if (!isToxic) {
        const newBounds = calculateCausalConcentratedRange(currentPrice, jevRegime, riskWeight, temperatureMultiplier);
        this.position.entryPrice = currentPrice;
        this.position.lowerRangePrice = newBounds.lowerPrice;
        this.position.upperRangePrice = newBounds.upperPrice;
        this.position.status = "ACTIVE";
        this.position.totalRebalances += 1;
        this.position.gasSpentUsd += await estimateGasCostUsd(GAS_UNITS.REPOSITION);
        decision = `REBALANCE_BACK_TO_RANGE (${newBounds.description})`;
      } else {
        decision = "OUT_OF_RANGE_AWAITING_CALM";
      }
    }

    // Acumulacion de Fees simuladas calibrada a la duración real del paso
    if (this.position.status === "ACTIVE") {
      const annualRate = this.pool.feeAprPct / 100;
      // Segundos por año: 365 * 24 * 3600 = 31,536,000 segundos
      const stepRate = annualRate * (stepDurationSeconds / 31536000);
      const earnedStep = this.position.currentCapitalUsd * stepRate;
      this.position.accumulatedFeesUsd += earnedStep;
    }

    // Calculo de Impermanent Loss.
    // Modelo activo: concentrado (v3 real: cantidades por unidad de L, single-sided
    // fuera del rango valuado a precio de mercado). La formula de rango completo
    // subestimaba el IL 29-47x con los rangos vivos; se conserva como valor de
    // comparabilidad para no romper el analisis historico.
    const ilConcentrated = calculateConcentratedIlFraction(
      this.position.entryPrice,
      currentPrice,
      this.position.lowerRangePrice,
      this.position.upperRangePrice
    );
    const ilFullRange = calculateFullRangeIlFraction(this.position.entryPrice, currentPrice);
    const ilModel = process.env.DEX_IL_MODEL === "full_range" ? "full_range" : "concentrated";
    const ilRatio = ilModel === "concentrated" ? ilConcentrated : ilFullRange;
    this.position.impermanentLossFullRangeUsd = this.position.initialCapitalUsd * ilFullRange;
    this.position.impermanentLossUsd = this.position.initialCapitalUsd * ilRatio;

    // PnL Neto
    const netPnlUsd = this.position.accumulatedFeesUsd - this.position.impermanentLossUsd - this.position.gasSpentUsd;
    const netPnlPct = (netPnlUsd / this.position.initialCapitalUsd) * 100;
    this.position.currentCapitalUsd = this.position.initialCapitalUsd + netPnlUsd;

    return {
      decision,
      position: this.position,
      netPnlUsd,
      netPnlPct,
    };
  }

  public getSnapshot(): ShadowPosition {
    return this.position;
  }
}

// Demostracion / Test en vivo si se ejecuta directamente
if (import.meta.main) {
  console.log("=== EJECUTANDO PRUEBA DEL SHADOW LP ENGINE ===");

  const samplePool: PoolState = {
    symbol: "WETH-CBBTC",
    chain: "Base",
    protocol: "Aerodrome Slipstream",
    price: 0.0319, // Ratio WETH / BTC
    feeAprPct: 68.9, // 68.9% APR organico
    volume24hUsd: 38_000_000,
    tvlUsd: 1_730_000,
  };

  const engine = new ShadowLPEngine(samplePool, 1000);
  console.log(`Posicion inicial: $1,000 USD en ${samplePool.symbol} (${samplePool.protocol})`);
  console.log(`Rango inicial: [${engine.getSnapshot().lowerRangePrice.toFixed(4)} - ${engine.getSnapshot().upperRangePrice.toFixed(4)}]`);

  // Simulacion de 3 pasos:
  // Paso 1: Mercado en calma (acumula fees)
  console.log("\n[Paso 1: Mercado Normal]");
  const res1 = await engine.step(0.0320, 0.3, { toxicFlow: 0.15, regimeStress: 0.10, meanReversion: 0.85, ok: true, failure: null });
  console.log(`Decision: ${res1.decision} | Fees: +$${res1.position.accumulatedFeesUsd.toFixed(4)} | PnL Neto: +$${res1.netPnlUsd.toFixed(4)}`);

  // Paso 2: Breakout / Flujo toxico (Laya activa defensa)
  console.log("\n[Paso 2: Alerta de Volatilidad / Flujo Toxico detectado por Laya]");
  const res2 = await engine.step(0.0345, 7.8, { toxicFlow: 0.88, regimeStress: 0.82, meanReversion: 0.20, ok: true, failure: null });
  console.log(`Decision: ${res2.decision} | Estado: ${res2.position.status} | Pausas defensivas: ${res2.position.defensivePauses}`);

  // Paso 3: Retorno a la calma y reposicionamiento
  console.log("\n[Paso 3: Mercado se estabiliza]");
  const res3 = await engine.step(0.0342, -0.5, { toxicFlow: 0.20, regimeStress: 0.15, meanReversion: 0.78, ok: true, failure: null });
  console.log(`Decision: ${res3.decision} | Rebalanceos: ${res3.position.totalRebalances} | PnL Final: $${res3.netPnlUsd.toFixed(4)} (${res3.netPnlPct.toFixed(2)}%)`);
}
