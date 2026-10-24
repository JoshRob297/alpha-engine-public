#!/usr/bin/env bun
/**
 * Limpieza del almacen de genomas: aparta entradas contaminadas por tests o
 * degeneradas (winRate ~100% / profitFactor en el cap) a un archivo de cuarentena
 * auditable, dejando el store de produccion solo con genomas utilizables.
 *
 * Uso:
 *   bun run scripts/clean-genome-store.ts            # dry-run
 *   bun run scripts/clean-genome-store.ts --apply
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const apply = process.argv.includes("--apply");
const get = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const storePath = get("--store", "./data/evolved_atr_genomes.json");

if (!existsSync(storePath)) {
  console.error(`[GENOME CLEAN] No existe: ${storePath}`);
  process.exit(1);
}

const store = JSON.parse(readFileSync(storePath, "utf-8"));
const quarantinePath = join(dirname(storePath), "evolved_atr_genomes_rejected.jsonl");
const removed: Array<{ key: string; reason: string; entry: any }> = [];

for (const [key, value] of Object.entries(store)) {
  if (key === "updatedAt") continue;
  const v: any = value;
  if (!v || typeof v !== "object") continue;

  const reasons: string[] = [];
  if (/test/i.test(key) || /test/i.test(String(v.dataset || ""))) {
    reasons.push(`clave/dataset de prueba (${v.dataset || key})`);
  }
  const winRate = Number(v.winRate ?? 0);
  const pf = Number(v.profitFactor ?? 0);
  if (winRate >= 99.5) reasons.push(`winRate degenerado (${winRate}%)`);
  if (pf >= 9.98) reasons.push(`profitFactor en cap (${pf})`);
  const kTp = Number(v.k_tp ?? 0);
  const kStop = Number(v.k_stop ?? 0);
  if (kTp > 0 && kStop > 0 && kStop / kTp >= 10) {
    reasons.push(`risk/reward inservible 1:${(kStop / kTp).toFixed(1)} (breakeven WR ${((kStop / (kStop + kTp)) * 100).toFixed(1)}%)`);
  }

  if (reasons.length > 0) removed.push({ key, reason: reasons.join("; "), entry: v });
}

console.log(`[GENOME CLEAN] Store: ${storePath}`);
console.log(`[GENOME CLEAN] Claves presentes: ${Object.keys(store).filter((k) => k !== "updatedAt").join(", ")}`);
if (removed.length === 0) {
  console.log("[GENOME CLEAN] Nada que apartar: store limpio.");
  process.exit(0);
}
for (const r of removed) console.log(`  - APARTAR ${r.key}: ${r.reason}`);

if (!apply) {
  console.log("[GENOME CLEAN] Dry-run. Ejecutar con --apply para escribir cambios.");
  process.exit(0);
}

for (const r of removed) delete store[r.key];
store["updatedAt"] = new Date().toISOString();
store["cleanedAt"] = new Date().toISOString();

writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
for (const r of removed) {
  appendFileSync(
    quarantinePath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      reason: `Cuarentena manual: ${r.reason}`,
      key: r.key,
      ...r.entry,
    }) + "\n",
    "utf-8"
  );
}
console.log(`[GENOME CLEAN] Aplicado. ${removed.length} entrada(s) a ${quarantinePath}`);
console.log(`[GENOME CLEAN] Claves restantes: ${Object.keys(store).filter((k) => !k.toLowerCase().includes("at")).join(", ")}`);
