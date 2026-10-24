/**
 * Tests de la matematica de fee growth por posicion concentrada.
 * Fuente de verdad: UniswapV3Pool.getFeeGrowthInside / positions(...).
 * Todos los casos son deterministicos y sin red.
 */

import { describe, expect, test } from "bun:test";
import {
  MAX_TICK,
  Q96,
  Q128,
  computeFeeGrowthInside,
  computeFeesEarned,
  feesToUsd,
  realizedOverModeledPct,
  sqrtPriceX96ToPrice,
  subIn256,
  tickToSqrtPriceX96,
} from "./fee-growth.js";

/** SqrtRatioX96 en el tick maximo segun TickMath del core v3 (referencia canonica). */
const MAX_SQRT_RATIO_X96 = 1461446703485210103287273052203988822378723970342n;

describe("subIn256 (aritmetica modular uint256)", () => {
  test("resta normal sin wrap", () => {
    expect(subIn256(5n, 3n)).toBe(2n);
    expect(subIn256(1000n, 1000n)).toBe(0n);
    expect(subIn256(2n ** 200n, 1n)).toBe(2n ** 200n - 1n);
  });

  test("underflow hace wrap a 2^256 como Solidity unchecked", () => {
    expect(subIn256(0n, 1n)).toBe(2n ** 256n - 1n);
    expect(subIn256(1n, 1n)).toBe(0n);
    expect(subIn256(3n, 10n)).toBe(2n ** 256n - 7n);
  });
});

describe("tickToSqrtPriceX96", () => {
  test("tick 0 devuelve 2^96 exacto", () => {
    expect(tickToSqrtPriceX96(0)).toBe(Q96);
    expect(tickToSqrtPriceX96(0)).toBe(79228162514264337593543950336n);
  });

  test("monotonia estricta respecto al tick", () => {
    const muy_bajo = tickToSqrtPriceX96(-60000);
    const bajo = tickToSqrtPriceX96(-100);
    const cero = tickToSqrtPriceX96(0);
    const alto = tickToSqrtPriceX96(100);
    const muy_alto = tickToSqrtPriceX96(60000);
    expect(muy_bajo).toBeLessThan(bajo);
    expect(bajo).toBeLessThan(cero);
    expect(cero).toBeLessThan(alto);
    expect(alto).toBeLessThan(muy_alto);
  });

  test(`tick ${MAX_TICK} aproxima el sqrtPrice maximo del core (error relativo < 1e-6)`, () => {
    const obtenido = Number(tickToSqrtPriceX96(MAX_TICK));
    const referencia = Number(MAX_SQRT_RATIO_X96);
    // El error relativo lo domina la representacion float64 de 1.0001 (bias ~4e-11);
    // se exige 1e-6, muy por encima del error real y muy por debajo de un error util.
    const errorRelativo = Math.abs(obtenido - referencia) / referencia;
    expect(errorRelativo).toBeLessThan(1e-6);
  });

  test("tick no finito lanza error", () => {
    expect(() => tickToSqrtPriceX96(Number.NaN)).toThrow();
    expect(() => tickToSqrtPriceX96(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("sqrtPriceX96ToPrice", () => {
  test("mismo decimals con sqrtPrice = 2^96 devuelve 1", () => {
    expect(sqrtPriceX96ToPrice(Q96, 18, 18)).toBe(1);
  });

  test("tick 23027 => precio ~10 (1.0001^23027)", () => {
    const precio = sqrtPriceX96ToPrice(tickToSqrtPriceX96(23027), 18, 18);
    expect(Math.abs(precio - 10) / 10).toBeLessThan(1e-6);
  });

  test("ajusta por diferencia de decimales (WETH 18 / USDC 6)", () => {
    // ratio = 2 => precio crudo = 4; humano = 4 * 10^(18-6) = 4e12
    expect(sqrtPriceX96ToPrice(2n * Q96, 18, 6)).toBe(4e12);
  });
});

describe("computeFeeGrowthInside (getFeeGrowthInside v3 core)", () => {
  const base = {
    feeGrowthGlobal0X128: 1000n,
    feeGrowthGlobal1X128: 777n,
    feeGrowthOutside0Lower: 200n,
    feeGrowthOutside1Lower: 600n,
    feeGrowthOutside0Upper: 300n,
    feeGrowthOutside1Upper: 100n,
  };

  test("tick dentro del rango: inside = global - below - above", () => {
    const r = computeFeeGrowthInside({ ...base, tickLower: -100, tickUpper: 100, currentTick: 0 });
    expect(r.feeGrowthInside0X128).toBe(1000n - 200n - 300n);
    expect(r.feeGrowthInside1X128).toBe(777n - 600n - 100n);
  });

  test("tick en el limite inferior (currentTick === tickLower) se cuenta como dentro", () => {
    const r = computeFeeGrowthInside({ ...base, tickLower: 0, tickUpper: 100, currentTick: 0 });
    expect(r.feeGrowthInside0X128).toBe(500n);
  });

  test("tick en el limite superior (currentTick === tickUpper) ya cuenta como fuera", () => {
    const r = computeFeeGrowthInside({ ...base, tickLower: -100, tickUpper: 100, currentTick: 100 });
    // inside = outside(upper) - outside(lower) en valor absoluto
    expect(r.feeGrowthInside0X128).toBe(300n - 200n);
  });

  test("posicion fuera de rango por abajo: inside es constante e independiente del global", () => {
    const parado = { ...base, tickLower: 100, tickUpper: 200, currentTick: 50 };
    const r1 = computeFeeGrowthInside(parado);
    // inside = outside(lower) - outside(upper), con wrap uint256 si es negativo
    expect(r1.feeGrowthInside0X128).toBe(subIn256(200n, 300n));
    expect(r1.feeGrowthInside0X128).toBe(2n ** 256n - 100n);
    expect(r1.feeGrowthInside1X128).toBe(subIn256(600n, 100n));

    // El global crece por swaps, pero la posicion fuera de rango no acumula nada.
    const r2 = computeFeeGrowthInside({
      ...parado,
      feeGrowthGlobal0X128: 9_999_999n,
      feeGrowthGlobal1X128: 8_888_888n,
    });
    expect(r2.feeGrowthInside0X128).toBe(r1.feeGrowthInside0X128);
    expect(r2.feeGrowthInside1X128).toBe(r1.feeGrowthInside1X128);
  });

  test("posicion fuera de rango por arriba: inside tambien queda congelado", () => {
    const parado = { ...base, tickLower: -200, tickUpper: -100, currentTick: 0 };
    const r1 = computeFeeGrowthInside(parado);
    const r2 = computeFeeGrowthInside({ ...parado, feeGrowthGlobal0X128: 5_000_000n });
    expect(r1.feeGrowthInside0X128).toBe(subIn256(300n, 200n));
    expect(r2.feeGrowthInside0X128).toBe(r1.feeGrowthInside0X128);
  });

  test("maneja wrap uint256 cuando el outside supera al global", () => {
    const r = computeFeeGrowthInside({
      feeGrowthGlobal0X128: 5n,
      feeGrowthGlobal1X128: 7n,
      feeGrowthOutside0Lower: 0n,
      feeGrowthOutside1Lower: 0n,
      feeGrowthOutside0Upper: 10n,
      feeGrowthOutside1Upper: 100n,
      tickLower: -100,
      tickUpper: 100,
      currentTick: 100,
    });
    // above = 5 - 10 mod 2^256; inside = 5 - 0 - above = 10
    expect(r.feeGrowthInside0X128).toBe(10n);
    expect(r.feeGrowthInside1X128).toBe(100n);
  });

  test("liquidez no altera getFeeGrowthInside (paridad de firma)", () => {
    const sinLiq = computeFeeGrowthInside({ ...base, tickLower: -100, tickUpper: 100, currentTick: 0 });
    const conLiq = computeFeeGrowthInside({
      ...base,
      tickLower: -100,
      tickUpper: 100,
      currentTick: 0,
      liquidity: 123_456_789n,
      positionLiquidity: 42n,
    });
    expect(conLiq).toEqual(sinLiq);
  });
});

describe("computeFeesEarned (delta / 2^128 * liquidity)", () => {
  test("delta cero produce cero fees", () => {
    const r = computeFeesEarned({
      feeGrowthInside0LastX128: 12345n,
      feeGrowthInside1LastX128: 777n,
      feeGrowthInside0NowX128: 12345n,
      feeGrowthInside1NowX128: 777n,
      liquidity: 10n ** 18n,
    });
    expect(r.fees0).toBe(0n);
    expect(r.fees1).toBe(0n);
  });

  test("delta de 2^128 con liquidez L devuelve exactamente L", () => {
    const L = 999_999_999n;
    const r = computeFeesEarned({
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      feeGrowthInside0NowX128: Q128,
      feeGrowthInside1NowX128: Q128,
      liquidity: L,
    });
    expect(r.fees0).toBe(L);
    expect(r.fees1).toBe(L);
  });

  test("trunca hacia abajo como la division entera del contrato", () => {
    const r = computeFeesEarned({
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      feeGrowthInside0NowX128: 1n,
      feeGrowthInside1NowX128: Q128 - 1n,
      liquidity: Q128 - 1n,
    });
    expect(r.fees0).toBe(0n); // (2^128 - 1) / 2^128 = 0
    expect(r.fees1).toBe(Q128 - 2n); // ((2^128-1)^2 - (2^128-1))/2^128
  });

  test("monotonia: mas liquidez o mas delta => mas fees", () => {
    const L = 10n ** 15n;
    const chico = computeFeesEarned({
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      feeGrowthInside0NowX128: 10n * Q128,
      feeGrowthInside1NowX128: 10n * Q128,
      liquidity: L,
    });
    const masLiq = computeFeesEarned({
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      feeGrowthInside0NowX128: 10n * Q128,
      feeGrowthInside1NowX128: 10n * Q128,
      liquidity: 2n * L,
    });
    const masDelta = computeFeesEarned({
      feeGrowthInside0LastX128: 0n,
      feeGrowthInside1LastX128: 0n,
      feeGrowthInside0NowX128: 20n * Q128,
      feeGrowthInside1NowX128: 20n * Q128,
      liquidity: L,
    });
    expect(masLiq.fees0).toBeGreaterThan(chico.fees0);
    expect(masLiq.fees0).toBe(2n * chico.fees0);
    expect(masDelta.fees0).toBeGreaterThan(chico.fees0);
  });

  test("delta con wrap (Now < Last) reproduce el uint256 del contrato", () => {
    const L = 10n ** 12n;
    const r = computeFeesEarned({
      feeGrowthInside0LastX128: 10n,
      feeGrowthInside1LastX128: 0n,
      feeGrowthInside0NowX128: 5n,
      feeGrowthInside1NowX128: 0n,
      liquidity: L,
    });
    expect(r.fees0).toBe(((2n ** 256n - 5n) * L) / Q128);
    expect(r.fees0).toBeGreaterThan(10n ** 20n);
  });
});

describe("pipeline: posicion fuera de rango no acumula fees", () => {
  test("si el tick sigue fuera del rango, el fee growth global crece pero las fees son cero", () => {
    const rango = { tickLower: 100, tickUpper: 200 };
    const liquidezPosicion = 5n * 10n ** 17n;

    // Snapshot inicial (bloque A): posicion por debajo del rango.
    const a = computeFeeGrowthInside({
      feeGrowthGlobal0X128: 500_000n,
      feeGrowthGlobal1X128: 800_000n,
      feeGrowthOutside0Lower: 700_000n,
      feeGrowthOutside1Lower: 900_000n,
      feeGrowthOutside0Upper: 200_000n,
      feeGrowthOutside1Upper: 100_000n,
      currentTick: 50,
      ...rango,
    });

    // Snapshot posterior (bloque B): el pool cobro fees, el precio sigue abajo.
    const b = computeFeeGrowthInside({
      feeGrowthGlobal0X128: 9_000_000n,
      feeGrowthGlobal1X128: 8_000_000n,
      feeGrowthOutside0Lower: 700_000n,
      feeGrowthOutside1Lower: 900_000n,
      feeGrowthOutside0Upper: 200_000n,
      feeGrowthOutside1Upper: 100_000n,
      currentTick: 60,
      ...rango,
    });

    const feesFuera = computeFeesEarned({
      feeGrowthInside0LastX128: a.feeGrowthInside0X128,
      feeGrowthInside1LastX128: a.feeGrowthInside1X128,
      feeGrowthInside0NowX128: b.feeGrowthInside0X128,
      feeGrowthInside1NowX128: b.feeGrowthInside1X128,
      liquidity: liquidezPosicion,
    });
    expect(feesFuera.fees0).toBe(0n);
    expect(feesFuera.fees1).toBe(0n);
  });

  test("con el precio dentro del rango la posicion si acumula fees", () => {
    const liquidezPosicion = 5n * 10n ** 17n;
    // feeGrowthInside crece en ~1e-6 de Q128, magnitud tipica de una jornada real.
    const deltaGlobal = Q128 / 1_000_000n;
    const a = computeFeeGrowthInside({
      feeGrowthGlobal0X128: 1_000_000n,
      feeGrowthGlobal1X128: 1_000_000n,
      feeGrowthOutside0Lower: 200_000n,
      feeGrowthOutside1Lower: 200_000n,
      feeGrowthOutside0Upper: 300_000n,
      feeGrowthOutside1Upper: 300_000n,
      tickLower: -100,
      tickUpper: 100,
      currentTick: 0,
    });
    const b = computeFeeGrowthInside({
      feeGrowthGlobal0X128: 1_000_000n + deltaGlobal,
      feeGrowthGlobal1X128: 1_000_000n + deltaGlobal,
      feeGrowthOutside0Lower: 200_000n,
      feeGrowthOutside1Lower: 200_000n,
      feeGrowthOutside0Upper: 300_000n,
      feeGrowthOutside1Upper: 300_000n,
      tickLower: -100,
      tickUpper: 100,
      currentTick: 5,
    });
    const fees = computeFeesEarned({
      feeGrowthInside0LastX128: a.feeGrowthInside0X128,
      feeGrowthInside1LastX128: a.feeGrowthInside1X128,
      feeGrowthInside0NowX128: b.feeGrowthInside0X128,
      feeGrowthInside1NowX128: b.feeGrowthInside1X128,
      liquidity: liquidezPosicion,
    });
    expect(fees.fees0).toBeGreaterThan(0n);
    expect(fees.fees1).toBeGreaterThan(0n);
    expect(fees.fees0).toBe(fees.fees1);
  });
});

describe("feesToUsd y realizedOverModeledPct", () => {
  test("convierte fees crudas a USD con decimales y precios", () => {
    const usd = feesToUsd({
      fees0: 1_500_000_000_000_000_000n, // 1.5 WETH (18 dec)
      fees1: 2_500_000n, // 2.5 USDC (6 dec)
      decimals0: 18,
      decimals1: 6,
      price0Usd: 2000,
      price1Usd: 1,
    });
    expect(usd).toBeCloseTo(3002.5, 6);
  });

  test("realizedOverModeledPct calcula el porcentaje de lo modelado", () => {
    expect(realizedOverModeledPct(320, 1000)).toBeCloseTo(32, 10);
    expect(realizedOverModeledPct(0, 1000)).toBe(0);
    expect(realizedOverModeledPct(1200, 1000)).toBeCloseTo(120, 10);
  });

  test("realizedOverModeledPct devuelve null sin modelado valido", () => {
    expect(realizedOverModeledPct(100, 0)).toBeNull();
    expect(realizedOverModeledPct(100, -5)).toBeNull();
    expect(realizedOverModeledPct(Number.NaN, 100)).toBeNull();
    expect(realizedOverModeledPct(100, Number.NaN)).toBeNull();
  });
});
