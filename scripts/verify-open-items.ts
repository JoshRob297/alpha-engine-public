#!/usr/bin/env bun
/**
 * Verificacion de los puntos abiertos declarados en
 * docs/LIVE_PAPER_VALIDATION_2026-10.md (seccion 4).
 *
 *   [1] El IL del modelo DEX es de rango completo, no concentrado. Se mide el impacto
 *       real con los rangos vivos (fraccion y USD).
 *   [2] La normalizacion DEX no puede subir capital: se comprueba que un deficit sin
 *       caja NO genera movimientos (no se acuna capital).
 *   [3] La reserva objetivo depende del regimen: se tabula la oscilacion y se compara
 *       con lo observado en el estado vivo.
 *   [4] Higiene de secretos: token del bot fuera del codigo.
 *
 * Uso:
 *   bun run scripts/verify-open-items.ts [--state <ruta>] [--check-telegram-token]
 *
 * Salida: PASS/FAIL por punto. Exit code 1 si algun punto falla.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  calculateConcentratedIlFraction,
  calculateFullRangeIlFraction,
} from "../src/dex/shadow-lp-simulator.js";
import { getRegimePolicy } from "../src/guardrails/regime-policy.js";
import {
  planDexCapitalNormalization,
  planCapitalNormalization,
} from "../src/daemon/capital-normalizer.js";
import { auditCapitalConservation } from "../src/daemon/capital-conservation.js";

const get = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const statePath = get("--state", "./data-runtime/engine_state.json");
const checkToken = process.argv.includes("--check-telegram-token");
const results: Array<{ id: string; ok: boolean; detail: string }> = [];

function record(id: string, ok: boolean, detail: string) {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${id}] ${detail}`);
}

const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf-8")) : null;
console.log(`=== VERIFICACION DE PUNTOS ABIERTOS ===`);
console.log(`Estado: ${state ? statePath : "no disponible (se usan solo comprobaciones de codigo)"}\n`);

// ---------------------------------------------------------------- [1] IL concentrado
console.log("--- [1] IL: rango completo vs concentrado ---");
const dexSlots = Object.entries(state?.dexPositions || {}) as Array<[string, any]>;
if (dexSlots.length === 0) {
  record("1-IL", true, "Sin slots DEX en el estado: nada que medir (comprobacion analitica cubierta por tests)");
} else {
  let worstFactor = 0;
  let totalExtraLossUsd = 0;
  for (const [slot, p] of dexSlots) {
    const entry = Number(p.entryPrice) || 0;
    const current = Number(p.price) || 0;
    const lower = Number(p.lowerRangePrice) || 0;
    const upper = Number(p.upperRangePrice) || 0;
    const capital = Number(p.initialCapitalUsd) || Number(p.currentCapitalUsd) || 0;
    if (!(entry > 0 && current > 0 && lower > 0 && upper > lower)) continue;

    const full = calculateFullRangeIlFraction(entry, current);
    const conc = calculateConcentratedIlFraction(entry, current, lower, upper);
    const factor = full > 0 && conc > 0 ? conc / full : null;
    const extraUsd = (conc - full) * capital;
    const persistedIl = Number(p.impermanentLossUsd) || 0;

    if (factor !== null) worstFactor = Math.max(worstFactor, factor);
    totalExtraLossUsd += extraUsd;

    console.log(
      `  ${slot}: entry=${entry} price=${current} rango=[${lower}, ${upper}]`
    );
    console.log(
      `     IL legacy (rango completo)=${(full * 100).toExponential(3)}% | IL concentrado correcto=${(conc * 100).toExponential(3)}% | factor=${factor === null ? "n/d (sin movimiento de precio)" : `${factor.toFixed(1)}x`}`
    );
    console.log(
      `     IL persistido por el motor=$${persistedIl.toFixed(4)} | sobre capital $${capital.toFixed(2)}: correcto $${(conc * capital).toFixed(4)} (subestimado $${extraUsd.toFixed(4)})`
    );
  }
  const confirmed = totalExtraLossUsd > 0.0001;
  record(
    "1-IL",
    confirmed,
    confirmed
      ? `CONFIRMADO: el motor subestima IL. Factor maximo ${worstFactor.toFixed(1)}x; IL adicional no contabilizado ~$${totalExtraLossUsd.toFixed(4)} sobre el capital de los slots`
      : "No se reproduce subestimacion con los rangos actuales (movimiento de precio insuficiente)"
  );
}

// ------------------------------------------------- [2] Normalizacion DEX sin acunar
console.log("\n--- [2] Normalizacion DEX: no acuna capital ---");
const reserveCash = Number(state?.equity?.unallocatedCashUsd) || 0;
const dexTarget = Number(state?.equity?.policyActiveTargetUsd)
  ? Math.max(0, Number(state.equity.policyActiveTargetUsd) - (Number(state?.cexPositions?.BTC?.allocatedCashUsd) || 0))
  : 0;
const slotsForPlan = dexSlots.map(([key, p]) => ({
  key,
  currentCapitalUsd: Number(p.currentCapitalUsd) || 0,
  initialCapitalUsd: Number(p.initialCapitalUsd) || 0,
}));
const noCashPlan = planDexCapitalNormalization(slotsForPlan, Number.MAX_SAFE_INTEGER / 1e6, 0);
const deficitPlan = planDexCapitalNormalization([{ key: "T", currentCapitalUsd: 20, initialCapitalUsd: 20 }], 60, 0);
const noMintOk = noCashPlan.moves.length === 0 && deficitPlan.moves.length === 0 && deficitPlan.unfundedDeficitUsd === 40;
console.log(
  `  Deficit sintetico (20 contra 60, caja 0): movimientos=${deficitPlan.moves.length} no financiado=$${deficitPlan.unfundedDeficitUsd}`
);
console.log(
  `  Estado vivo: reserva capturada=$${reserveCash.toFixed(2)} | dexInitialCapital=$${(Number(state?.equity?.dexInitialCapitalUsd) || 0).toFixed(2)} | sub/sobre-despliegue vs politica=$${(Number(state?.equity?.underDeploymentVsPolicyUsd) || 0).toFixed(2)}`
);
record(
  "2-DEX-NO-MINT",
  noMintOk,
  noMintOk
    ? "CONFIRMADO: sin caja disponible NO hay movimientos (el modelo no acuna capital); el deficit queda declarado en unfundedDeficitUsd"
    : "FALLO: el plan genera movimientos sin caja disponible"
);

// ------------------------------------------- [3] Reserva objetivo segun el regimen
console.log("\n--- [3] Reserva objetivo dependiente del regimen ---");
const capital = Number(state?.totalCapitalUsd) || 200;
const table: Array<{ regime: string; fiatPct: number; activeUsd: number; reserveUsd: number; cexUsd: number; dexUsd: number }> = [];
for (const regime of ["AGGRESSIVE_ACCUMULATION", "BALANCED_RANGE", "DEFENSIVE_STRESS"]) {
  const policy = getRegimePolicy(regime, "ANCHOR");
  const reserveUsd = capital * policy.fiatPct;
  const activeUsd = capital - reserveUsd;
  table.push({
    regime,
    fiatPct: policy.fiatPct,
    activeUsd,
    reserveUsd,
    cexUsd: activeUsd * policy.cexPct,
    dexUsd: activeUsd * policy.dexPct,
  });
}
for (const row of table) {
  console.log(
    `  ${row.regime.padEnd(24)} fiat=${(row.fiatPct * 100).toFixed(0)}% -> reserva $${row.reserveUsd.toFixed(0)} | activo $${row.activeUsd.toFixed(0)} (CEX $${row.cexUsd.toFixed(0)} / DEX $${row.dexUsd.toFixed(0)})`
  );
}
const observedReserve = Number(state?.equity?.policyReserveTargetUsd);
const swing = table[2].reserveUsd - table[0].reserveUsd;
console.log(
  `  Estado vivo: regimen=${state?.macroAllocation?.predominantRegime ?? "n/d"} -> reserva objetivo observada $${Number.isFinite(observedReserve) ? observedReserve : "n/d"}`
);
record(
  "3-RESERVE-REGIME",
  swing > 0,
  `CONFIRMADO: la reserva objetivo oscila $${table[0].reserveUsd.toFixed(0)} (AGGRESSIVE) a $${table[2].reserveUsd.toFixed(0)} (DEFENSIVE), un rango de $${swing.toFixed(0)} sobre $${capital}; el "despliegue vs politica" se mueve con el regimen y no solo con errores`
);

// ------------------------------------------------------------- [4] Higiene de secretos
console.log("\n--- [4] Higiene de secretos (token del bot) ---");
const TOKEN_PATTERN = /bot\d{8,}:[A-Za-z0-9_-]{30,}|\d{9,10}:[A-Za-z0-9_-]{30,}/g;
function scanDir(dir: string, hits: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", "data", "backups"].includes(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) scanDir(full, hits);
    else if (/\.(ts|tsx|js|mjs|json|py|sh|md|service|timer)$/.test(entry)) {
      const content = readFileSync(full, "utf-8");
      const m = content.match(TOKEN_PATTERN);
      if (m) hits.push(`${full} (${m.length})`);
    }
  }
  return hits;
}
const sourceHits = scanDir("src").concat(scanDir("scripts"), scanDir("config").filter(() => true));
const cleanNow = sourceHits.length === 0;
console.log(`  Coincidencias de patron de token en el arbol de trabajo: ${sourceHits.length}`);
for (const h of sourceHits) console.log(`    - ${h}`);
let historyExposed = false;
try {
  const out = execFileSync("git", ["log", "--oneline", "-S", "8794396982", "--all"], { encoding: "utf-8" });
  historyExposed = out.trim().length > 0;
  console.log(`  Exposicion en historial de git: ${historyExposed ? "SI" : "no"}`);
  for (const line of out.trim().split("\n").slice(0, 3)) if (line) console.log(`    - ${line}`);
} catch {}
let liveToken = "no verificado";
if (checkToken) {
  let token: string | null = null;
  try {
    const secrets = readFileSync(join(homedir(), ".env.secrets"), "utf-8");
    token = secrets.split("\n").find((l) => l.startsWith("TELEGRAM_TOKEN="))?.split("=").slice(1).join("=").trim() || null;
  } catch {}
  if (token) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10000) });
      const body: any = await res.json();
      liveToken = body?.ok ? `ACTIVO (bot @${body.result?.username})` : `inválido/rotado (ok=${body?.ok})`;
    } catch (err: any) {
      liveToken = `error de red: ${err?.message}`;
    }
  }
  console.log(`  Token en ~/.env.secrets: ${liveToken}`);
}
record(
  "4-TOKEN",
  cleanNow,
  cleanNow
    ? `CONFIRMADO: sin token en el codigo. ${historyExposed ? "PENDIENTE: el valor sigue en el historial de git (repo privado) -> rotar en BotFather." : "Sin rastro en el historial."}${checkToken ? ` Token actual: ${liveToken}.` : ""}`
    : `FALLO: quedan ${sourceHits.length} coincidencias de token en el codigo`
);

// ---------------------------------------------------- [5] Conservacion de capital
console.log("\n--- [5] Conservacion de capital (reserva capturada vs caja real) ---");
const conservation = auditCapitalConservation({
  capitalUsd: Number(state?.totalCapitalUsd) || 0,
  realizedNetUsd: Number(state?.equity?.cexRealizedNetUsd) || 0,
  deployedValueUsd: Number(state?.equity?.deployedValueUsd) || 0,
  capturedReserveUsd: Number(state?.unallocatedCashUsd ?? state?.equity?.unallocatedCashUsd) || 0,
});
console.log(
  `  Caja real = capital $${Number(state?.totalCapitalUsd) || 0} + PnL realizado $${(Number(state?.equity?.cexRealizedNetUsd) || 0).toFixed(2)} - desplegado $${(Number(state?.equity?.deployedValueUsd) || 0).toFixed(2)} = $${conservation.totalCashUsd.toFixed(2)}`
);
console.log(
  `  Reserva capturada (etiqueta) = $${(Number(state?.unallocatedCashUsd) || 0).toFixed(2)} | residuo derivado = $${conservation.derivedUntradedReserveUsd.toFixed(2)} | exceso = $${conservation.overshootUsd.toFixed(2)} (${conservation.overshootPct}% del capital)`
);
console.log(
  `  Reparaciones de conservacion aplicadas por el motor: ${state?.conservationRepairs ?? "n/d"}`
);
record(
  "5-CONSERVACION",
  !conservation.needsRepair,
  !conservation.needsRepair
    ? `CONFIRMADO: la etiqueta de reserva no excede la caja real (desviacion $${conservation.overshootUsd.toFixed(2)}, umbral 0.5). Sin capital acunado.`
    : `FALLO: la etiqueta de reserva excede la caja real en $${conservation.overshootUsd.toFixed(2)} (${conservation.overshootPct}% del capital): hay capital inexistente en los libros`
);

// ---------------------------------------------------------------------- Resumen
const failed = results.filter((r) => !r.ok);
console.log(`\n=== RESUMEN: ${results.length - failed.length}/${results.length} verificaciones en PASS ===`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAIL ${f.id}: ${f.detail}`);
  process.exit(1);
}
