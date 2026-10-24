/**
 * Matematica pura de fee growth para posiciones de liquidez concentrada
 * (Uniswap v3 core / Aerodrome Slipstream sobre Base L2).
 *
 * Problema que resuelve: el motor toma el fee APR de una fuente externa
 * (DeFiLlama) y lo usa como parametro dominante del modelo DEX sin validarlo
 * on-chain. Las fees que EFECTIVAMENTE acumula una posicion concentrada no son
 * un APR declarado: son la integral del fee growth dentro del rango
 * [tickLower, tickUpper), ponderada por la liquidez de la posicion.
 *
 * Este modulo replica exactamente la contabilidad del contrato:
 *   - feeGrowthInside = global - below - above (con los 4 casos de getFeeGrowthInside)
 *   - fees = (feeGrowthInsideNow - feeGrowthInsideLast) * liquidity / 2^128
 * con aritmetica modular uint256 (subIn256) e division entera (truncado) igual
 * que Solidity. Cero red: todo es determinista y testeable.
 *
 * Referencias:
 *   UniswapV3Pool.getFeeGrowthInside / positions(...) / UniswapV3PoolState.slot0
 *   FixedPoint128.Q128 = 2^128, FixedPoint96.Q96 = 2^96
 */

/** 2^96, base de precios de Uniswap v3 (FixedPoint96.Q96). */
export const Q96 = 2n ** 96n;

/** 2^128, base de fee growth acumulado por unidad de liquidez (FixedPoint128.Q128). */
export const Q128 = 2n ** 128n;

/** 2^256 - 1, techo de un uint256. */
export const MAX_UINT256 = 2n ** 256n - 1n;

/** Tick minimo soportado por el core v3 (precio ~ 2^-128). */
export const MIN_TICK = -887272;

/** Tick maximo soportado por el core v3 (precio ~ 2^128). */
export const MAX_TICK = 887272;

/**
 * Resta con wrap a 2^256, equivalente a la aritmetica unchecked uint256 de
 * Solidity: si b > a, el resultado es (a - b) mod 2^256.
 *
 * Es obligatorio usarlo en toda resta de fee growth: el contrato lo hace asi y
 * un feeGrowthOutside puede superar al global en el instante de un swap.
 */
export function subIn256(a: bigint, b: bigint): bigint {
  return BigInt.asUintN(256, a - b);
}

/**
 * Convierte un tick a sqrtPriceX96 = sqrt(1.0001^tick) * 2^96.
 *
 * Implementacion en punto flotante (la unica disponible sin red ni tabla):
 *   sqrtPrice = Math.pow(1.0001, tick / 2)   via exp/log internamente
 *   resultado = round(sqrtPrice * 2^96)
 *
 * Error esperado:
 *   - 2^96 es exactamente representable en float64, pero el resultado crudo tiene
 *     ~49 digitos, o sea MAYOR que los ~15-16 digitos significativos de float64.
 *   - El error relativo dominante viene del argumento 0.5*tick*ln(1.0001):
 *     acotado a ~1e-13 en valor absoluto del exponente para |tick| <= 887272,
 *     lo que da un error relativo en el precio de ~1e-13 (y ~2e-13 en el precio,
 *     que es el cuadrado).
 *   - En valor absoluto el error crece con la magnitud: a tick 887272 el sqrtPriceX96
 *     vale ~1.46e48, asi que 1e-13 relativo son ~1e35 unidades crudas.
 *
 * Consecuencia practica: sirve para tests, sanity checks y analisis de rangos.
 * Para auditar una posicion real hay que usar el sqrtPriceX96/tick que devuelve
 * slot0() on-chain, NO este helper.
 */
export function tickToSqrtPriceX96(tick: number): bigint {
  if (!Number.isFinite(tick)) throw new Error(`tickToSqrtPriceX96: tick no finito (${tick})`);
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  const scaled = Math.round(sqrtPrice * Number(Q96));
  if (!Number.isFinite(scaled)) throw new Error(`tickToSqrtPriceX96: overflow para tick ${tick}`);
  return BigInt(scaled);
}

/**
 * Convierte sqrtPriceX96 al precio humano de token0 expresado en token1.
 *
 *   precio_crudo (token1/token0) = (sqrtPriceX96 / 2^96)^2
 *   precio_humano               = precio_crudo * 10^decimals0 / 10^decimals1
 *
 * Ejemplo: WETH (18 dec) / USDC (6 dec), precio 2000 USD por WETH ->
 * 1 WETH = 2000 * 10^6 unidades de USDC, el helper devuelve 2000.
 *
 * Precisión: conversion a float64 (error relativo ~1e-16) con la misma cota de
 * tickToSqrtPriceX96 si el sqrtPriceX96 viene de alli.
 */
export function sqrtPriceX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const ratio = Number(sqrtPriceX96) / Number(Q96);
  const rawPrice = ratio * ratio;
  return rawPrice * Math.pow(10, decimals0 - decimals1);
}

/** Entradas de getFeeGrowthInside del core v3 mas contexto de liquidez. */
export interface FeeGrowthInsideParams {
  /** feeGrowthGlobal0X128() del pool (uint256). */
  feeGrowthGlobal0X128: bigint;
  /** feeGrowthGlobal1X128() del pool (uint256). */
  feeGrowthGlobal1X128: bigint;
  /** feeGrowthOutside0X128 del tick inferior (ticks(tickLower)). */
  feeGrowthOutside0Lower: bigint;
  /** feeGrowthOutside1X128 del tick inferior. */
  feeGrowthOutside1Lower: bigint;
  /** feeGrowthOutside0X128 del tick superior (ticks(tickUpper)). */
  feeGrowthOutside0Upper: bigint;
  /** feeGrowthOutside1X128 del tick superior. */
  feeGrowthOutside1Upper: bigint;
  /** Tick inferior de la posicion (incluido en el rango). */
  tickLower: number;
  /** Tick superior de la posicion (excluido del rango). */
  tickUpper: number;
  /** Tick actual del pool (slot0.tick). */
  currentTick: number;
  /**
   * Liquidez total activa del pool en el tick actual (liquidity()).
   * getFeeGrowthInside de v3 core NO depende de la liquidez; se acepta por
   * paridad de firma y trazabilidad del snapshot, no entra en la formula.
   */
  liquidity?: bigint;
  /**
   * Liquidez de la posicion. Misma observacion que `liquidity`: no entra en
   * getFeeGrowthInside, se usa recien en computeFeesEarned.
   */
  positionLiquidity?: bigint;
}

/** Resultado de getFeeGrowthInside: fee growth acumulado dentro del rango. */
export interface FeeGrowthInside {
  feeGrowthInside0X128: bigint;
  feeGrowthInside1X128: bigint;
}

/**
 * Fee growth acumulado DENTRO de [tickLower, tickUpper), replicando
 * UniswapV3Pool.getFeeGrowthInside exactamente (4 casos + wrap uint256).
 *
 * Logica por token:
 *   feeGrowthBelow = currentTick >= tickLower ? outside(lower) : global - outside(lower)
 *   feeGrowthAbove = currentTick <  tickUpper ? outside(upper) : global - outside(upper)
 *   inside         = global - below - above
 *
 * Propiedad clave: si el precio esta FUERA del rango, `inside` deja de depender
 * del global (queda fijo en outside(lower) - outside(upper) o su espejo), por lo
 * que la posicion NO acumula fees. Eso es lo que el modelo APR externo ignora.
 */
export function computeFeeGrowthInside(p: FeeGrowthInsideParams): FeeGrowthInside {
  const {
    feeGrowthGlobal0X128,
    feeGrowthGlobal1X128,
    feeGrowthOutside0Lower,
    feeGrowthOutside1Lower,
    feeGrowthOutside0Upper,
    feeGrowthOutside1Upper,
    tickLower,
    tickUpper,
    currentTick,
  } = p;

  // currentTick >= tickLower: las fees "bajo" el rango son el outside del tick inferior.
  const belowLower = currentTick >= tickLower;
  // currentTick >= tickUpper: las fees "sobre" el rango ya cruzaron el tick superior.
  const aboveUpper = currentTick >= tickUpper;

  const feeGrowthBelow0X128 = belowLower
    ? feeGrowthOutside0Lower
    : subIn256(feeGrowthGlobal0X128, feeGrowthOutside0Lower);
  const feeGrowthBelow1X128 = belowLower
    ? feeGrowthOutside1Lower
    : subIn256(feeGrowthGlobal1X128, feeGrowthOutside1Lower);

  const feeGrowthAbove0X128 = aboveUpper
    ? subIn256(feeGrowthGlobal0X128, feeGrowthOutside0Upper)
    : feeGrowthOutside0Upper;
  const feeGrowthAbove1X128 = aboveUpper
    ? subIn256(feeGrowthGlobal1X128, feeGrowthOutside1Upper)
    : feeGrowthOutside1Upper;

  return {
    feeGrowthInside0X128: subIn256(
      subIn256(feeGrowthGlobal0X128, feeGrowthBelow0X128),
      feeGrowthAbove0X128,
    ),
    feeGrowthInside1X128: subIn256(
      subIn256(feeGrowthGlobal1X128, feeGrowthBelow1X128),
      feeGrowthAbove1X128,
    ),
  };
}

/** Entradas de la contabilidad de fees de una posicion concreta. */
export interface FeesEarnedParams {
  /** feeGrowthInside0X128 al ultimo snapshot de la posicion (positions().feeGrowthInside0LastX128). */
  feeGrowthInside0LastX128: bigint;
  /** feeGrowthInside1X128 al ultimo snapshot. */
  feeGrowthInside1LastX128: bigint;
  /** feeGrowthInside0X128 actual del rango. */
  feeGrowthInside0NowX128: bigint;
  /** feeGrowthInside1X128 actual del rango. */
  feeGrowthInside1NowX128: bigint;
  /** Liquidez de la posicion (positions().liquidity). */
  liquidity: bigint;
}

/** Fees crudas acumuladas por la posicion (en unidades base de cada token). */
export interface FeesEarned {
  fees0: bigint;
  fees1: bigint;
}

/**
 * Fees acumuladas por la posicion entre dos snapshots, identico al contrato:
 *
 *   delta = feeGrowthInsideNow - feeGrowthInsideLast   (subIn256, uint256)
 *   fees  = delta * liquidity / 2^128                  (division entera, truncada)
 *
 * La division trunca como Solidity: se pierde siempre la fraccion menor a una
 * unidad base del token. En posiciones con liquidez pequena y rangos amplios la
 * truncacion acumulada es despreciable; el resto del error del modelo viene de
 * la fuente del fee APR, no de aqui.
 *
 * Nota: si `Now < Last` (posicion no sincronizada o snapshot invertido), delta
 * hace wrap a un uint256 enorme y las fees salen absurdas. Es el mismo
 * comportamiento del contrato (`positions()` no permite ese estado), pero aca se
 * acepta para no ocultar un error de datos: el script de auditoria valida el
 * orden de bloques antes de llamar.
 */
export function computeFeesEarned(p: FeesEarnedParams): FeesEarned {
  const delta0 = subIn256(p.feeGrowthInside0NowX128, p.feeGrowthInside0LastX128);
  const delta1 = subIn256(p.feeGrowthInside1NowX128, p.feeGrowthInside1LastX128);
  return {
    fees0: (delta0 * p.liquidity) / Q128,
    fees1: (delta1 * p.liquidity) / Q128,
  };
}

/** Entradas de la conversion a USD de las fees crudas. */
export interface FeesToUsdParams {
  fees0: bigint;
  fees1: bigint;
  /** Decimales de token0 (ERC20 decimals). */
  decimals0: number;
  /** Decimales de token1. */
  decimals1: number;
  /** Precio USD de token0 (por unidad humana). */
  price0Usd: number;
  /** Precio USD de token1. */
  price1Usd: number;
}

/** Valor USD de las fees crudas de una posicion. */
export function feesToUsd(p: FeesToUsdParams): number {
  const amount0 = Number(p.fees0) / Math.pow(10, p.decimals0);
  const amount1 = Number(p.fees1) / Math.pow(10, p.decimals1);
  return amount0 * p.price0Usd + amount1 * p.price1Usd;
}

/**
 * Porcentaje de lo modelado que se realizo efectivamente:
 *   realized / modeled * 100
 *
 * Devuelve null si el modelado no es un numero positivo util (division por cero
 * o parametro invalido): preferimos "sin dato" antes que un porcentaje inventado.
 */
export function realizedOverModeledPct(realizedUsd: number, modeledUsd: number): number | null {
  if (!Number.isFinite(realizedUsd) || !Number.isFinite(modeledUsd)) return null;
  if (modeledUsd <= 0) return null;
  return (realizedUsd / modeledUsd) * 100;
}
