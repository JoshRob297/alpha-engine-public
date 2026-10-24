#!/usr/bin/env bun
/**
 * Fija el universo de medicion de la ventana OOS (activos CEX + pools DEX).
 *
 * Se ejecuta UNA vez al inicio de la ventana. Sin `--force` no sobreescribe un
 * universo existente: cambiarlo despues invalida la muestra pre-especificada.
 *
 * Uso:
 *   bun run scripts/init-measurement-universe.ts --state ./data/engine_state.json [--force] [--out data/measurement_universe.json]
 */

import { existsSync, readFileSync } from "node:fs";
import { freezeUniverse, loadUniverse } from "../src/guardrails/measurement-universe.js";

const get = (flag: string, fallback?: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const statePath = get("--state", "./data/engine_state.json");
const outPath = get("--out", "data/measurement_universe.json");
const force = process.argv.includes("--force");

if (!existsSync(statePath)) {
  console.error(`[UNIVERSE] Estado no encontrado: ${statePath}`);
  process.exit(2);
}

const state = JSON.parse(readFileSync(statePath, "utf-8"));
const assets: string[] = Object.keys(state.cexPositions || {});
const pools: string[] = Object.keys(state.dexPositions || {});
const windowStartedAt: string | null =
  process.env.MEASUREMENT_STARTED_AT || state.measurement?.startedAt || null;

const existing = loadUniverse(outPath);
if (existing && !force) {
  console.log(`[UNIVERSE] Ya existe universo congelado (${outPath}):`);
  console.log(`  createdAt=${existing.createdAt} | ventana=${existing.windowStartedAt}`);
  console.log(`  activos=${existing.assets.join(", ")}`);
  console.log(`  pools=${existing.pools.join(", ")}`);
  console.log("  No se modifica. Usar --force solo si se reinicia la ventana a proposito.");
  process.exit(0);
}

if (assets.length === 0 && pools.length === 0) {
  console.error("[UNIVERSE] El estado no tiene activos ni pools: nada que congelar.");
  process.exit(3);
}

const { universe, created } = freezeUniverse(assets, pools, windowStartedAt, { path: outPath, force });
console.log(`[UNIVERSE] ${created ? "Congelado" : "Re-fijado"} universo de medicion:`);
console.log(`  archivo=${outPath} | ventana=${universe.windowStartedAt ?? "n/d"} | creado=${universe.createdAt}`);
console.log(`  activos (${universe.assets.length}): ${universe.assets.join(", ")}`);
console.log(`  pools (${universe.pools.length}): ${universe.pools.join(", ")}`);
console.log(
  "[UNIVERSE] Durante la ventana solo se operan estos activos y pools. Cualquier admision se registra como UNIVERSE_ADMISSION y marca la muestra como no pre-especificada."
);
