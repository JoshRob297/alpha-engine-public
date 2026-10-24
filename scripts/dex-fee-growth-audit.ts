#!/usr/bin/env bun
/**
 * Auditoria on-chain de fee growth por posicion de liquidez concentrada
 * (Aerodrome Slipstream / Uniswap v3 core) sobre Base L2.
 *
 * Objetivo: medir las fees REALIZADAS por una posicion en un intervalo de
 * bloques y compararlas con el fee APR modelado (el que hoy entra desde
 * DeFiLlama y nunca se valido contra el contrato). El motor DEX modelo 9-40%
 * de lo que despues rindio: este script cuantifica esa brecha con datos duros.
 *
 * Uso:
 *   bun run scripts/dex-fee-growth-audit.ts --pool 0x... --rpc https://mainnet.base.org \
 *     [--tick-lower N --tick-upper N] [--liquidity N] [--blocks A,B] \
 *     [--decimals0 18 --decimals1 6] [--price0-usd 2500 --price1-usd 1] \
 *     [--modeled-usd 123.45] [--lookback-blocks 43200] [--json]
 *
 * Lecturas (eth_call, selector encodeado a mano, sin viem):
 *   slot0()                  0x3850c7bd  -> sqrtPriceX96, tick
 *   feeGrowthGlobal0X128()   0xf3058399  -> uint256
 *   feeGrowthGlobal1X128()   0x46141319  -> uint256
 *   liquidity()              0x1a686502  -> uint128 (liquidez activa del pool)
 *   ticks(int24)             0xf30dba93  -> struct Tick.Info (usa feeGrowthOutside0/1X128)
 *
 * Metodologia: el snapshot del bloque A es el equivalente a
 * positions(tokenId).feeGrowthInside0/1LastX128 si la posicion se hubiera
 * sincronizado en A. Se calcula feeGrowthInside con getFeeGrowthInside (core v3)
 * en A y en B, se resta y se pondera por la liquidez de la posicion.
 * feeGrowthOutside se lee en AMBOS bloques: cambia cuando el precio cruza los ticks.
 *
 * Codigos de salida: 0 ok | 1 error de uso | 4 RPC inalcanzable o con error.
 * Sin margen para inventar: si el RPC falla, el script aborta con exit 4.
 */

import {
  computeFeeGrowthInside,
  computeFeesEarned,
  feesToUsd,
  realizedOverModeledPct,
} from "../src/dex/fee-growth.js";

const RPC_TIMEOUT_MS = 12_000;

// Selectores (Uniswap v3 core / Aerodrome Slipstream comparten interfaz de Pool).
const SEL_SLOT0 = "0x3850c7bd";
const SEL_FEE_GROWTH_GLOBAL0 = "0xf3058399";
const SEL_FEE_GROWTH_GLOBAL1 = "0x46141319";
const SEL_LIQUIDITY = "0x1a686502";
const SEL_TICKS = "0xf30dba93";

// Ticks de rango completo del core v3 (default cuando no se pasa un rango).
const FULL_RANGE_LOWER = -887272;
const FULL_RANGE_UPPER = 887272;

// Bloque por defecto: Base produce bloques de ~2s, 43200 bloques ~ 24h.
const DEFAULT_LOOKBACK_BLOCKS = 43_200;

/** Error de RPC: siempre corta la ejecucion con exit 4, nunca se rellena con supuestos. */
class RpcError extends Error {}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function argNum(name: string, def: number): number {
  const raw = process.argv.indexOf(`--${name}`) >= 0 ? arg(name, String(def)) : String(def);
  const val = Number(raw);
  if (!Number.isFinite(val)) {
    console.error(`Error de uso: --${name} debe ser numerico (recibido "${raw}")`);
    process.exit(1);
  }
  return val;
}

/** Rolado exacto del argumento int24/uint256 a 32 bytes. */
function encodeWord(value: bigint | number): string {
  return BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, "0");
}

async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RpcError(`RPC inalcanzable en ${rpcUrl}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new RpcError(`RPC respondio HTTP ${res.status} en ${rpcUrl}`);
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new RpcError(`RPC devolvio una respuesta no JSON en ${rpcUrl}`);
  }
  if (data && data.error) throw new RpcError(`RPC error en ${method}: ${JSON.stringify(data.error)}`);
  if (!data || typeof data.result !== "string") {
    throw new RpcError(`RPC sin campo result para ${method} en ${rpcUrl}`);
  }
  return data.result;
}

function blockTag(block: number | "latest"): string {
  return block === "latest" ? "latest" : `0x${block.toString(16)}`;
}

async function ethCall(
  rpcUrl: string,
  to: string,
  data: string,
  block: number | "latest",
): Promise<string> {
  return rpc(rpcUrl, "eth_call", [{ to, data }, blockTag(block)]);
}

/** Palabra i-esima (32 bytes) de un retorno ABI como bigint unsigned. */
function wordAsUint(hex: string, i: number): bigint {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const w = body.slice(i * 64, (i + 1) * 64);
  if (w.length === 0) return 0n;
  return BigInt(`0x${w}`);
}

/** Palabra i-esima interpretada como int256 (ABI sign-extiende los int24/int128). */
function wordAsInt(hex: string, i: number): bigint {
  return BigInt.asIntN(256, wordAsUint(hex, i));
}

interface PoolSnapshot {
  block: number;
  sqrtPriceX96: bigint;
  tick: number;
  feeGrowthGlobal0X128: bigint;
  feeGrowthGlobal1X128: bigint;
  liquidity: bigint;
  feeGrowthOutside0Lower: bigint;
  feeGrowthOutside1Lower: bigint;
  feeGrowthOutside0Upper: bigint;
  feeGrowthOutside1Upper: bigint;
}

async function readSnapshot(
  rpcUrl: string,
  pool: string,
  block: number | "latest",
  tickLower: number,
  tickUpper: number,
): Promise<PoolSnapshot> {
  const [slot0, g0, g1, liq, lowerTick, upperTick] = await Promise.all([
    ethCall(rpcUrl, pool, SEL_SLOT0, block),
    ethCall(rpcUrl, pool, SEL_FEE_GROWTH_GLOBAL0, block),
    ethCall(rpcUrl, pool, SEL_FEE_GROWTH_GLOBAL1, block),
    ethCall(rpcUrl, pool, SEL_LIQUIDITY, block),
    ethCall(rpcUrl, pool, `${SEL_TICKS}${encodeWord(tickLower)}`, block),
    ethCall(rpcUrl, pool, `${SEL_TICKS}${encodeWord(tickUpper)}`, block),
  ]);

  // ticks(int24) es un mapping publico: un tick no inicializado devuelve 8 words en cero.
  return {
    block: block === "latest" ? -1 : block,
    sqrtPriceX96: wordAsUint(slot0, 0),
    tick: Number(wordAsInt(slot0, 1)),
    feeGrowthGlobal0X128: wordAsUint(g0, 0),
    feeGrowthGlobal1X128: wordAsUint(g1, 0),
    liquidity: wordAsUint(liq, 0),
    feeGrowthOutside0Lower: wordAsUint(lowerTick, 2),
    feeGrowthOutside1Lower: wordAsUint(lowerTick, 3),
    feeGrowthOutside0Upper: wordAsUint(upperTick, 2),
    feeGrowthOutside1Upper: wordAsUint(upperTick, 3),
  };
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 })}`;
}

async function main(): Promise<void> {
  const pool = arg("pool", "");
  const rpcUrl = arg("rpc", "");
  if (!pool || !/^0x[0-9a-fA-F]{40}$/.test(pool)) {
    console.error("Error de uso: --pool requiere una direccion de contrato 0x de 40 hex.");
    process.exit(1);
  }
  if (!rpcUrl) {
    console.error("Error de uso: --rpc requiere una URL JSON-RPC (ej. https://mainnet.base.org).");
    process.exit(1);
  }

  const tickLower = argNum("tick-lower", FULL_RANGE_LOWER);
  const tickUpper = argNum("tick-upper", FULL_RANGE_UPPER);
  if (tickLower >= tickUpper) {
    console.error(`Error de uso: --tick-lower (${tickLower}) debe ser menor que --tick-upper (${tickUpper}).`);
    process.exit(1);
  }

  const decimals0 = argNum("decimals0", 18);
  const decimals1 = argNum("decimals1", 18);
  const price0Usd = argNum("price0-usd", 1);
  const price1Usd = argNum("price1-usd", 1);
  const modeledUsd = hasFlag("modeled-usd") ? argNum("modeled-usd", 0) : Number.NaN;
  const asJson = hasFlag("json");

  // Resolucion de bloques: --blocks A,B o (B = latest, A = B - lookback).
  const latestHex = await rpc(rpcUrl, "eth_blockNumber", []);
  const latestBlock = Number(BigInt(latestHex));
  const blocksArg = arg("blocks", "");
  let blockA: number;
  let blockB: number;
  if (blocksArg) {
    const parts = blocksArg.split(",");
    if (parts.length !== 2) {
      console.error("Error de uso: --blocks espera el formato A,B (ej. 24000000,24043200).");
      process.exit(1);
    }
    blockA = Number(parts[0]);
    blockB = parts[1] === "latest" ? latestBlock : Number(parts[1]);
    if (!Number.isInteger(blockA) || !Number.isInteger(blockB)) {
      console.error("Error de uso: --blocks A,B debe contener enteros (o 'latest' en B).");
      process.exit(1);
    }
  } else {
    const lookback = argNum("lookback-blocks", DEFAULT_LOOKBACK_BLOCKS);
    blockB = latestBlock;
    blockA = blockB - lookback;
    if (blockA < 0) blockA = 0;
  }
  if (blockA >= blockB) {
    console.error(`Error de uso: el bloque de entrada (${blockA}) debe ser anterior al actual (${blockB}).`);
    process.exit(1);
  }

  const snapA = await readSnapshot(rpcUrl, pool, blockA, tickLower, tickUpper);
  const snapB = await readSnapshot(rpcUrl, pool, blockB, tickLower, tickUpper);

  // Liquidez de la posicion: explicita, o el total del pool como cota superior documentada.
  const liquidityArg = process.argv.indexOf("--liquidity") >= 0 ? arg("liquidity", "0") : "";
  let positionLiquidity: bigint;
  let liquiditySource: string;
  if (liquidityArg !== "") {
    try {
      positionLiquidity = BigInt(liquidityArg);
    } catch {
      console.error(`Error de uso: --liquidity debe ser un entero (recibido "${liquidityArg}").`);
      process.exit(1);
    }
    liquiditySource = "--liquidity";
  } else {
    positionLiquidity = snapB.liquidity;
    liquiditySource = "liquidity() del pool en el bloque B (cota superior: no es la liquidez de una posicion concreta)";
  }

  const insideA = computeFeeGrowthInside({
    feeGrowthGlobal0X128: snapA.feeGrowthGlobal0X128,
    feeGrowthGlobal1X128: snapA.feeGrowthGlobal1X128,
    feeGrowthOutside0Lower: snapA.feeGrowthOutside0Lower,
    feeGrowthOutside1Lower: snapA.feeGrowthOutside1Lower,
    feeGrowthOutside0Upper: snapA.feeGrowthOutside0Upper,
    feeGrowthOutside1Upper: snapA.feeGrowthOutside1Upper,
    tickLower,
    tickUpper,
    currentTick: snapA.tick,
    liquidity: snapA.liquidity,
    positionLiquidity,
  });
  const insideB = computeFeeGrowthInside({
    feeGrowthGlobal0X128: snapB.feeGrowthGlobal0X128,
    feeGrowthGlobal1X128: snapB.feeGrowthGlobal1X128,
    feeGrowthOutside0Lower: snapB.feeGrowthOutside0Lower,
    feeGrowthOutside1Lower: snapB.feeGrowthOutside1Lower,
    feeGrowthOutside0Upper: snapB.feeGrowthOutside0Upper,
    feeGrowthOutside1Upper: snapB.feeGrowthOutside1Upper,
    tickLower,
    tickUpper,
    currentTick: snapB.tick,
    liquidity: snapB.liquidity,
    positionLiquidity,
  });

  const fees = computeFeesEarned({
    feeGrowthInside0LastX128: insideA.feeGrowthInside0X128,
    feeGrowthInside1LastX128: insideA.feeGrowthInside1X128,
    feeGrowthInside0NowX128: insideB.feeGrowthInside0X128,
    feeGrowthInside1NowX128: insideB.feeGrowthInside1X128,
    liquidity: positionLiquidity,
  });

  const realizedUsd = feesToUsd({
    fees0: fees.fees0,
    fees1: fees.fees1,
    decimals0,
    decimals1,
    price0Usd,
    price1Usd,
  });
  const ratioPct = realizedOverModeledPct(realizedUsd, modeledUsd);

  const report = {
    pool,
    rpc: rpcUrl,
    tickLower,
    tickUpper,
    positionLiquidity: positionLiquidity.toString(),
    liquiditySource,
    decimals: { token0: decimals0, token1: decimals1 },
    pricesUsd: { token0: price0Usd, token1: price1Usd },
    blocks: { entrada: blockA, ahora: blockB, latest: latestBlock },
    snapshotA: {
      tick: snapA.tick,
      sqrtPriceX96: snapA.sqrtPriceX96.toString(),
      liquidity: snapA.liquidity.toString(),
      feeGrowthGlobal0X128: snapA.feeGrowthGlobal0X128.toString(),
      feeGrowthGlobal1X128: snapA.feeGrowthGlobal1X128.toString(),
      feeGrowthOutside0Lower: snapA.feeGrowthOutside0Lower.toString(),
      feeGrowthOutside1Lower: snapA.feeGrowthOutside1Lower.toString(),
      feeGrowthOutside0Upper: snapA.feeGrowthOutside0Upper.toString(),
      feeGrowthOutside1Upper: snapA.feeGrowthOutside1Upper.toString(),
    },
    snapshotB: {
      tick: snapB.tick,
      sqrtPriceX96: snapB.sqrtPriceX96.toString(),
      liquidity: snapB.liquidity.toString(),
      feeGrowthGlobal0X128: snapB.feeGrowthGlobal0X128.toString(),
      feeGrowthGlobal1X128: snapB.feeGrowthGlobal1X128.toString(),
      feeGrowthOutside0Lower: snapB.feeGrowthOutside0Lower.toString(),
      feeGrowthOutside1Lower: snapB.feeGrowthOutside1Lower.toString(),
      feeGrowthOutside0Upper: snapB.feeGrowthOutside0Upper.toString(),
      feeGrowthOutside1Upper: snapB.feeGrowthOutside1Upper.toString(),
    },
    feeGrowthInside: {
      entrada: {
        token0: insideA.feeGrowthInside0X128.toString(),
        token1: insideA.feeGrowthInside1X128.toString(),
      },
      ahora: {
        token0: insideB.feeGrowthInside0X128.toString(),
        token1: insideB.feeGrowthInside1X128.toString(),
      },
    },
    fees: {
      raw0: fees.fees0.toString(),
      raw1: fees.fees1.toString(),
      token0: Number(fees.fees0) / Math.pow(10, decimals0),
      token1: Number(fees.fees1) / Math.pow(10, decimals1),
    },
    realizedUsd,
    modeledUsd: Number.isFinite(modeledUsd) ? modeledUsd : null,
    realizedOverModeledPct: ratioPct,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const posEnRango =
    snapB.tick >= tickLower && snapB.tick < tickUpper
      ? "DENTRO del rango"
      : "FUERA del rango (las fees se congelan con el precio afuera)";
  console.log("Auditoria de fee growth por posicion concentrada (Slipstream / v3 core)");
  console.log(`Pool: ${pool}`);
  console.log(`RPC:  ${rpcUrl}`);
  console.log(`Rango: [${tickLower}, ${tickUpper})  |  tick actual (B): ${snapB.tick} -> ${posEnRango}`);
  console.log(`Liquidez posicion: ${positionLiquidity.toString()}  (fuente: ${liquiditySource})`);
  console.log("");
  console.log(`Bloque A (entrada ${blockA}): tick=${snapA.tick} sqrtPriceX96=${snapA.sqrtPriceX96}`);
  console.log(`  feeGrowthGlobal0X128=${snapA.feeGrowthGlobal0X128}`);
  console.log(`  feeGrowthGlobal1X128=${snapA.feeGrowthGlobal1X128}`);
  console.log(`  outside0/1 lower=${snapA.feeGrowthOutside0Lower}/${snapA.feeGrowthOutside1Lower}`);
  console.log(`  outside0/1 upper=${snapA.feeGrowthOutside0Upper}/${snapA.feeGrowthOutside1Upper}`);
  console.log(`Bloque B (ahora ${blockB}): tick=${snapB.tick} sqrtPriceX96=${snapB.sqrtPriceX96}`);
  console.log(`  feeGrowthGlobal0X128=${snapB.feeGrowthGlobal0X128}`);
  console.log(`  feeGrowthGlobal1X128=${snapB.feeGrowthGlobal1X128}`);
  console.log(`  outside0/1 lower=${snapB.feeGrowthOutside0Lower}/${snapB.feeGrowthOutside1Lower}`);
  console.log(`  outside0/1 upper=${snapB.feeGrowthOutside0Upper}/${snapB.feeGrowthOutside1Upper}`);
  console.log("");
  console.log(`feeGrowthInside (A): 0=${insideA.feeGrowthInside0X128} 1=${insideA.feeGrowthInside1X128}`);
  console.log(`feeGrowthInside (B): 0=${insideB.feeGrowthInside0X128} 1=${insideB.feeGrowthInside1X128}`);
  console.log("");
  console.log(`Fees crudas: token0=${fees.fees0} (${report.fees.token0}) token1=${fees.fees1} (${report.fees.token1})`);
  console.log(
    `Precios USD usados: token0=$${price0Usd} token1=$${price1Usd} (default 1 si no se pasan --price0-usd/--price1-usd)`,
  );
  console.log(`Fee REALIZADO en el intervalo: ${fmtUsd(realizedUsd)}`);
  if (Number.isFinite(modeledUsd)) {
    console.log(`Fee MODELADO (fuente externa, ej. DeFiLlama): ${fmtUsd(modeledUsd)}`);
    console.log(
      ratioPct === null
        ? "Realizado/Modelado: sin dato (modelado no positivo o invalido)"
        : `Realizado/Modelado: ${ratioPct.toFixed(2)} %`,
    );
  } else {
    console.log("Fee MODELADO: no informado (usar --modeled-usd N para ver el % de lo modelado).");
  }
}

main().catch((err) => {
  if (err instanceof RpcError) {
    console.error(`Error RPC: ${err.message}`);
    console.error("Se aborta sin estimar nada: revisar la URL del RPC o el pool solicitado.");
    process.exit(4);
  }
  console.error(`Error inesperado: ${(err as Error).message}`);
  process.exit(4);
});
