#!/usr/bin/env bun
/**
 * Auditoria INDEPENDIENTE del PnL del motor (Alpha Engine).
 *
 * Que hace:
 *  - Recomputa el tramo CEX a partir de los componentes del propio ledger
 *    (`pnlNet` vs bruto implicito por `price`/`pnlPct`/`amount`) y suma fees+slippage.
 *  - Recomputa la coherencia contable de cada slot DEX:
 *    initialCapitalUsd + accumulatedFeesUsd - impermanentLossUsd - gasSpentUsd == currentCapitalUsd.
 *
 * Que NO hace:
 *  - No es un recalculo desde klines: es una verificacion de coherencia interna
 *    (suma de componentes). Un ledger consistente pero mal alimentado seguiria cuadrando.
 *
 * Uso:
 *   bun run scripts/independent-pnl-audit.ts --state <ruta> [--json]
 *
 * Exit code:
 *   0 si cuadra (desvio total CEX <= 0.5 USD y todos los slots DEX evaluables coherentes).
 *   1 si falla, si no se puede leer el estado o si la desviacion supera el umbral.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  reconcileTradesWithLedger,
  reconcileDexSlot,
  type LedgerTradeLike,
  type DexSlotLike,
} from "../src/research/pnl-reconstruction.js";

const DEVIATION_THRESHOLD_USD = 0.5;

const get = (flag: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const asJson = process.argv.includes("--json");
const statePath = get("--state");

function fail(msg: string): never {
  console.error(`[AUDIT] ${msg}`);
  process.exit(1);
}

if (!statePath) {
  fail("Falta --state <ruta>. Uso: bun run scripts/independent-pnl-audit.ts --state <ruta> [--json]");
}
if (!existsSync(statePath!)) {
  fail(`No existe el archivo de estado: ${statePath}`);
}

let state: any;
try {
  state = JSON.parse(readFileSync(statePath!, "utf-8"));
} catch (err: any) {
  fail(`Estado ilegible (JSON invalido): ${err?.message ?? err}`);
}

const history: LedgerTradeLike[] = Array.isArray(state?.history) ? state.history : [];
const dexPositions: Record<string, DexSlotLike> = (state?.dexPositions && typeof state.dexPositions === "object" && !Array.isArray(state.dexPositions))
  ? state.dexPositions
  : {};

// ------------------------------------------------------------------- CEX
const cex = reconcileTradesWithLedger(history);
const cexCosts = history.reduce(
  (acc, t) => {
    const fees = typeof t.feePaidUsd === "number" ? t.feePaidUsd : typeof t.feeSavedOrPaid === "number" ? t.feeSavedOrPaid : 0;
    const slip = typeof t.slippageUsd === "number" ? t.slippageUsd : 0;
    return { fees: acc.fees + fees, slippage: acc.slippage + slip };
  },
  { fees: 0, slippage: 0 }
);
const cexNetAfterCosts = cex.ledgerTotalUsd - cexCosts.fees - cexCosts.slippage;
const cexDeviation = Math.abs(cex.ledgerTotalUsd - cex.reconstructedTotalUsd);

// ------------------------------------------------------------------- DEX
const dexSlots = Object.entries(dexPositions).map(([key, slot]) => ({
  key,
  recon: reconcileDexSlot(slot),
}));
const dexEvaluable = dexSlots.filter((s) => s.recon.evaluable);
const dexIncoherent = dexEvaluable.filter((s) => !s.recon.coherent);

// Estado pre-correccion: nada auditable (sin trades CEX y sin ningun slot DEX evaluable).
const preCorrection = history.length === 0 && dexEvaluable.length === 0;

// ---------------------------------------------------------------- VEREDICTO
const cexOk = cexDeviation <= DEVIATION_THRESHOLD_USD;
const dexOk = dexIncoherent.length === 0;
const ok = cexOk && dexOk && !preCorrection;

interface AuditReport {
  statePath: string;
  generatedAt: string;
  preCorrection: boolean;
  cex: {
    tradesInLedger: number;
    checked: number;
    coveragePct: number;
    ledgerTotalUsd: number;
    reconstructedTotalUsd: number;
    deviationUsd: number;
    feesUsd: number;
    slippageUsd: number;
    netAfterCostsUsd: number;
    mismatches: typeof cex.mismatches;
  };
  dex: {
    slots: number;
    evaluable: number;
    incoherent: number;
    details: Array<{
      slot: string;
      evaluable: boolean;
      coherent: boolean;
      currentCapitalUsd: number;
      expectedCapitalUsd: number;
      deltaUsd: number;
      reason: string;
    }>;
  };
  ok: boolean;
}

const report: AuditReport = {
  statePath: statePath!,
  generatedAt: new Date().toISOString(),
  preCorrection,
  cex: {
    tradesInLedger: history.length,
    checked: cex.checked,
    coveragePct: cex.coveragePct,
    ledgerTotalUsd: cex.ledgerTotalUsd,
    reconstructedTotalUsd: cex.reconstructedTotalUsd,
    deviationUsd: Number(cexDeviation.toFixed(6)),
    feesUsd: Number(cexCosts.fees.toFixed(6)),
    slippageUsd: Number(cexCosts.slippage.toFixed(6)),
    netAfterCostsUsd: Number(cexNetAfterCosts.toFixed(6)),
    mismatches: cex.mismatches,
  },
  dex: {
    slots: dexSlots.length,
    evaluable: dexEvaluable.length,
    incoherent: dexIncoherent.length,
    details: dexSlots.map((s) => ({
      slot: s.recon.slot,
      evaluable: s.recon.evaluable,
      coherent: s.recon.coherent,
      currentCapitalUsd: s.recon.currentCapitalUsd,
      expectedCapitalUsd: s.recon.expectedCapitalUsd,
      deltaUsd: s.recon.deltaUsd,
      reason: s.recon.reason,
    })),
  },
  ok,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(ok && !preCorrection ? 0 : 1);
}

const money = (v: number) => (Number.isFinite(v) ? `$${v.toFixed(4)}` : "n/d");

console.log("=== AUDITORIA INDEPENDIENTE DE PNL ===");
console.log(`Estado: ${statePath}`);
console.log(`Alcance: coherencia INTERNA del ledger (suma de componentes), no recalculo desde klines.`);
console.log(`Umbral de desvio total CEX: $${DEVIATION_THRESHOLD_USD.toFixed(2)}\n`);

if (preCorrection) {
  console.log("ESTADO PRE-CORRECCION: no hay `history` con trades y ningun slot DEX registra initialCapital/IL/gas.");
  console.log("No hay nada que auditar todavia. El motor aun no persistio trades cerrados ni la contabilidad DEX completa.\n");
}

console.log("--- CEX (ledger `history`) ---");
console.log(
  `Trades en ledger: ${history.length} | Chequeados: ${cex.checked} | Cobertura: ${cex.coveragePct.toFixed(1)}%`
);
console.log(
  `Total ledger (pnlNet bruto): ${money(cex.ledgerTotalUsd)} | Reconstruido: ${money(cex.reconstructedTotalUsd)} | Desvio: ${money(cexDeviation)}`
);
console.log(
  `Fees: ${money(cexCosts.fees)} | Slippage: ${money(cexCosts.slippage)} | Neto despues de costos: ${money(cexNetAfterCosts)}`
);
if (cex.mismatches.length > 0) {
  console.log(`  Mismatches (${cex.mismatches.length}):`);
  for (const m of cex.mismatches) {
    console.log(
      `   #${m.index} ${m.timestamp} ${m.assetOrPool} ${m.action} | ledger ${money(m.ledgerUsd)} vs recon ${money(m.reconstructedUsd)} | diff ${money(m.diffUsd)}`
    );
  }
} else if (cex.checked > 0) {
  console.log("  Sin mismatches: todos los componentes cuadran.");
} else if (!preCorrection) {
  console.log("  Sin trades CEX elegibles (amount>0 / venue CEX) en el ledger.");
}

console.log("\n--- DEX (ledger `dexPositions`) ---");
if (dexSlots.length === 0) {
  console.log("Sin slots DEX en el estado.");
} else {
  console.log(`Slots: ${dexSlots.length} | Evaluables: ${dexEvaluable.length} | Incoherentes: ${dexIncoherent.length}`);
  for (const { recon } of dexSlots) {
    if (!recon.evaluable) {
      console.log(`  ${recon.slot}: NO EVALUABLE (${recon.reason})`);
      continue;
    }
    const flag = recon.coherent ? "OK" : "FALLA";
    console.log(
      `  ${flag} ${recon.slot}: actual ${money(recon.currentCapitalUsd)} vs esperado ${money(recon.expectedCapitalUsd)} | delta ${money(recon.deltaUsd)}`
    );
    if (!recon.coherent) console.log(`       ${recon.explanation}`);
  }
}

console.log("\n=== VEREDICTO ===");
if (preCorrection) {
  console.log("PRE-CORRECCION: sin datos persistidos. La auditoria no puede validar el ledger todavia.");
  process.exit(1);
}
if (ok) {
  console.log(`CUADRA: desvio CEX ${money(cexDeviation)} <= $${DEVIATION_THRESHOLD_USD.toFixed(2)} y ${dexEvaluable.length} slots DEX evaluables coherentes.`);
  process.exit(0);
}
if (!cexOk) {
  console.log(`FALLA CEX: desvio total ${money(cexDeviation)} > $${DEVIATION_THRESHOLD_USD.toFixed(2)}.`);
}
if (!dexOk) {
  console.log(`FALLA DEX: ${dexIncoherent.length} slot(s) con capital no explicado por inicial + fees - IL - gas.`);
  for (const s of dexIncoherent) console.log(`  - ${s.recon.slot}: ${s.recon.explanation}`);
}
process.exit(1);
