#!/usr/bin/env bun
/**
 * Puente estado -> on-chain para auditar un slot DEX con `dex-fee-growth-audit.ts`.
 *
 * Problema que resuelve: el estado del motor guarda el slot en terminos de capital USD y
 * un rango en "precio humano" (que ademas no es homogeneo entre pares), pero el audit
 * on-chain necesita ticks y liquidez (L) en unidades del pool. Este script lee el pool
 * real por RPC (token0/token1/decimals/slot0) y deriva:
 *   - el ancho relativo del rango del slot (porcentaje arriba/abajo del entry),
 *   - los ticks equivalentes alrededor del tick ACTUAL del pool (misma amplitud relativa),
 *   - la liquidez L que hace que la posicion valga el capital del slot,
 *   - las fees modeladas para la misma ventana (capital * APR / 365 * dias).
 *
 * Supuesto declarado: se conserva la AMPLITUD RELATIVA del rango del slot, no los precios
 * absolutos (el estado no guarda la convencion de precio por par de forma consistente).
 * La amplitud es el parametro que determina la concentracion y por tanto las fees.
 *
 * Uso:
 *   bun run scripts/dex-slot-audit-inputs.ts --state ./data/engine_state.json \
 *     --slot WETH-CBBTC --pool 0x... --rpc https://mainnet.base.org \
 *     [--price0-usd 2500 --price1-usd 111000] [--lookback-blocks 43200] [--json]
 */

import { existsSync, readFileSync } from "node:fs";

const get = (flag: string, def?: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const statePath = get("--state", "./data/engine_state.json")!;
const slotKey = get("--slot")!;
const pool = get("--pool")!;
const rpc = get("--rpc", "https://mainnet.base.org")!;
const lookbackBlocks = parseInt(get("--lookback-blocks", "43200")!, 10);
const jsonOut = process.argv.includes("--json");
const price0Usd = parseFloat(get("--price0-usd", "0")!);
const price1Usd = parseFloat(get("--price1-usd", "0")!);
// Precios USD por simbolo conocido (Base). Si se pasan, se resuelven por direccion.
const btcUsd = parseFloat(get("--btc-usd", "0")!);
const ethUsd = parseFloat(get("--eth-usd", "0")!);
const usdcUsd = parseFloat(get("--usdc-usd", "1")!);

if (!slotKey || !pool) {
  console.error("Uso: --slot <WETH-CBBTC|...> --pool 0x... [--state ...] [--rpc ...]");
  process.exit(1);
}
if (!existsSync(statePath)) {
  console.error(`[BRIDGE] Estado no encontrado: ${statePath}`);
  process.exit(2);
}

const state = JSON.parse(readFileSync(statePath, "utf-8"));
const slot = state.dexPositions?.[slotKey];
if (!slot) {
  console.error(`[BRIDGE] El slot ${slotKey} no existe en el estado.`);
  process.exit(2);
}

const SEL_TOKEN0 = "0x0dfe1681";
const SEL_TOKEN1 = "0xd21220a7";
const SEL_DECIMALS = "0x313ce567";
const SEL_SLOT0 = "0x3850c7bd";

async function ethCall(to: string, data: string): Promise<string> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: any = await res.json();
  if (body.error || typeof body.result !== "string") {
    throw new Error(`RPC error: ${body.error?.message || "sin result"}`);
  }
  return body.result;
}

const asAddress = (hex: string) => "0x" + hex.slice(-40);
const asNumber = (hex: string) => parseInt(hex, 16);

const [token0Hex, token1Hex, slot0Hex] = await Promise.all([
  ethCall(pool, SEL_TOKEN0),
  ethCall(pool, SEL_TOKEN1),
  ethCall(pool, SEL_SLOT0),
]);

// decimals de cada token (token0 y token1)
const d0 = asNumber(await ethCall(asAddress(token0Hex), SEL_DECIMALS));
const d1 = asNumber(await ethCall(asAddress(token1Hex), SEL_DECIMALS));

const slot0 = slot0Hex.replace(/^0x/, "");
const sqrtPriceX96 = BigInt("0x" + slot0.slice(0, 64));
const currentTick = Number(BigInt.asIntN(24, BigInt("0x" + slot0.slice(64, 128))));

// Precio humano: unidades de token1 por 1 unidad de token0.
// sqrtPriceX96^2 / 2^192 en punto flotante (error relativo ~1e-15, suficiente para ticks).
const sp = Number(sqrtPriceX96);
const priceRaw = (sp * sp) / Math.pow(2, 192);
const humanPrice = priceRaw * Math.pow(10, d0 - d1);

const entry = Number(slot.entryPrice) || humanPrice;
const lower = Number(slot.lowerRangePrice) || entry * 0.95;
const upper = Number(slot.upperRangePrice) || entry * 1.05;
const lowerPct = lower / entry - 1;
const upperPct = upper / entry - 1;
const tickLower = currentTick + Math.round(Math.log(1 + lowerPct) / Math.log(1.0001));
const tickUpper = currentTick + Math.round(Math.log(1 + upperPct) / Math.log(1.0001));

// Liquidez L que hace que la posicion (valuada en token1) iguale el capital del slot.
const capitalUsd = Number(slot.currentCapitalUsd) || 0;
const KNOWN: Record<string, number> = {
  "0x4200000000000000000000000000000000000006": ethUsd, // WETH
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": btcUsd, // cbBTC
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": usdcUsd, // USDC
};
const usd0 = price0Usd > 0 ? price0Usd : KNOWN[asAddress(token0Hex).toLowerCase()] || 1;
const usd1 = price1Usd > 0 ? price1Usd : KNOWN[asAddress(token1Hex).toLowerCase()] || 1;
if (usd0 <= 1.01 && usd0 < 1.01 && btcUsd > 0 && ethUsd > 0) {
  // aviso: si no se pudo resolver algun token, el resultado en USD no es confiable
}
const p1 = usd1;
const p0 = usd0;
const Pa = Math.pow(1.0001, tickLower);
const Pb = Math.pow(1.0001, tickUpper);
const P = priceRaw;
const denom = 2 * Math.sqrt(P) - P / Math.sqrt(Pb) - Math.sqrt(Pa);
const valueToken1Human = capitalUsd / p1;
const L = denom > 0 ? (valueToken1Human * Math.pow(10, d1)) / denom : 0;

const days = lookbackBlocks / 43200; // 43200 bloques ~ 24 h en Base
const modeledUsd = (capitalUsd * (Number(slot.feeAprPct) || 0)) / 100 / 365 * days;

const out = {
  slot: slotKey,
  pool,
  token0: asAddress(token0Hex),
  token1: asAddress(token1Hex),
  decimals0: d0,
  decimals1: d1,
  currentTick,
  humanPrice: Number(humanPrice.toPrecision(8)),
  engineEntry: entry,
  rangePct: { lower: Number((lowerPct * 100).toFixed(3)), upper: Number((upperPct * 100).toFixed(3)) },
  tickLower,
  tickUpper,
  tickSpacingApprox: tickUpper - tickLower,
  liquidity: Math.round(L),
  capitalUsd,
  feeAprPct: Number(slot.feeAprPct) || 0,
  lookbackBlocks,
  modeledUsdForWindow: Number(modeledUsd.toFixed(4)),
  price0Usd: p0,
  price1Usd: p1,
};

if (jsonOut) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`=== BRIDGE ${slotKey} ===`);
  console.log(`Pool: ${pool}`);
  console.log(`Tokens: ${out.token0} (dec ${d0}) / ${out.token1} (dec ${d1})`);
  console.log(`Tick actual: ${currentTick} | Precio humano (t1/t0): ${out.humanPrice} | Entry del motor: ${entry}`);
  console.log(
    `Rango del slot: ${(lowerPct * 100).toFixed(2)}% / +${(upperPct * 100).toFixed(2)}% -> ticks [${tickLower}, ${tickUpper}]`
  );
  console.log(`Precios USD: token0=$${p0} token1=$${p1}`);
  console.log(`Capital del slot: $${capitalUsd} | Liquidez L: ${Math.round(L)}`);
  console.log(`APR modelado: ${out.feeAprPct}% -> fees modeladas ${days.toFixed(2)} d: $${modeledUsd.toFixed(4)}`);
  console.log("");
  console.log("Comando de auditoria:");
  console.log(
    `bun run scripts/dex-fee-growth-audit.ts --pool ${pool} --rpc ${rpc} --tick-lower ${tickLower} --tick-upper ${tickUpper} --liquidity ${Math.round(L)} --decimals0 ${d0} --decimals1 ${d1} --lookback-blocks ${lookbackBlocks} --price0-usd ${p0} --price1-usd ${p1} --modeled-usd ${modeledUsd.toFixed(4)}`
  );
}
