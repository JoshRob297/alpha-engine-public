#!/usr/bin/env bun
/**
 * alpha-audit — CLI de auditoria de estrategias/bots.
 *
 * Ingesta un archivo (estado del motor, JSON/JSONL o CSV con mapeo), lo adapta al modelo
 * canonico, deriva el PnL neto, aplica inferencia robusta + walk-forward + escalado y emite
 * un veredicto con evidencia, calidad de datos, hash de entrada y limitaciones.
 *
 * Uso:
 *   alpha-audit --file estado.json
 *   alpha-audit --file export.csv --adapter generic --mapping mapping.json --capital 1000
 *   alpha-audit --file trades.jsonl --adapter generic --mapping '{"ts":"t","symbol":"s","pnlNet":"pnl","fees":"fee"}'
 *   alpha-audit --file trades.json --adapter alpha-engine --oos-start 2026-10-24T17:49:08Z
 *
 * Opciones: --adapter auto|alpha-engine|generic | --mapping archivo-o-json | --format json|jsonl|csv
 *           --delimiter , | --capital USD | --oos-start ISO | --folds N | --out DIR | --json | --label NOMBRE
 *
 * Codigos de salida: 0 auditoria emitida | 3 datos insuficientes (NO AUDITABLE) | 1 error.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adaptAlphaEngineState } from "../src/audit/adapters/alpha-engine.js";
import { adaptGeneric, detectFormat, type GenericMapping } from "../src/audit/adapters/generic.js";
import { runAudit, type AuditResult } from "../src/audit/audit-run.js";

const TOOL = "alpha-audit/0.1.0";

interface Args {
  file?: string;
  adapter: "auto" | "alpha-engine" | "generic";
  mapping?: string;
  format?: "json" | "jsonl" | "csv";
  delimiter?: string;
  capital?: number;
  oosStart?: string;
  folds: number;
  out: string;
  json: boolean;
  label?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, def?: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  const has = (flag: string) => argv.includes(flag);
  return {
    file: get("--file"),
    adapter: (get("--adapter", "auto") as Args["adapter"]) ?? "auto",
    mapping: get("--mapping"),
    format: get("--format") as Args["format"],
    delimiter: get("--delimiter"),
    capital: get("--capital") ? Number(get("--capital")) : undefined,
    oosStart: get("--oos-start"),
    folds: Number(get("--folds", "4")),
    out: get("--out", "data/audit_reports")!,
    json: has("--json"),
    label: get("--label"),
  };
}

function usage(): void {
  console.log(`alpha-audit — auditoria independiente de estrategias/bots

Uso:
  alpha-audit --file <ruta> [opciones]

Opciones:
  --adapter auto|alpha-engine|generic   Como interpretar el archivo (default: auto)
  --mapping <archivo|json>              Mapeo de columnas (obligatorio para formatos de terceros)
  --format json|jsonl|csv               Formato (default: autodetectado)
  --delimiter <char>                    Delimitador CSV (default: ,)
  --capital <usd>                       Capital inicial (default: del estado si existe)
  --oos-start <iso>                     Ventana out-of-sample: solo trades posteriores
  --folds <n>                           Folds de walk-forward (default: 4)
  --out <dir>                           Directorio del reporte JSON (default: data/audit_reports)
  --label <nombre>                      Etiqueta de la auditoria
  --json                                Imprimir el resultado en JSON

Mapeo (JSON): { "ts": "...", "symbol": "...", "qty": "...", "entryPrice": "...",
                "exitPrice": "...", "pnlNet": "...", "fees": "...", "slippage": "...",
                "extraCosts": ["swap"], "costSign": "positive|negative", "pnlKind": "gross|net" }

Salida: 0 auditoria emitida | 3 datos insuficientes | 1 error.`);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function loadMapping(raw: string): GenericMapping {
  const text = existsSync(raw) ? readFileSync(raw, "utf-8") : raw;
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed.ts !== "string" || typeof parsed.symbol !== "string") {
    throw new Error("Mapeo invalido: se requieren al menos 'ts' y 'symbol'.");
  }
  return parsed as GenericMapping;
}

function fmtP(p: number): string {
  if (p === 0) return "<1e-6";
  if (p < 0.0001) return p.toExponential(2);
  return String(p);
}

function printReport(result: AuditResult, meta: { file: string; hash: string; adapter: string; label?: string; reportPath?: string }): void {
  const s = result.sample;
  const inf = result.inference;
  console.log("=== ALPHA AUDIT ===");
  console.log(`Fuente:      ${meta.file}${meta.label ? ` (${meta.label})` : ""}`);
  console.log(`sha256:      ${meta.hash}`);
  console.log(`Adaptador:   ${meta.adapter} | Calidad: ${result.dataQuality.sufficiency} (${result.dataQuality.coveragePct}% verificable, ${result.dataQuality.rowsWithFees}/${result.dataQuality.totalRows} con costes)`);
  if (!s || !inf) {
    console.log(`\nVEREDICTO: ${result.verdict}`);
    console.log(`  ${result.reason}`);
    for (const l of result.limitations) console.log(`  - ${l}`);
    if (result.issues.length) for (const i of result.issues) console.log(`  ! ${i}`);
    return;
  }
  console.log(
    `Muestra:     n=${s.closed} (${s.wins}W/${s.losses}L) | WR ${s.winRatePct}% vs breakeven ${s.breakevenWinRatePct}% (deficit ${s.deficitPp} pp) | payoff 1:${s.payoffRatio}`
  );
  console.log(
    `Neto:        $${s.totalNetUsd}${s.totalNetPct !== null ? ` (${s.totalNetPct}% del capital)` : ""} | expectancy $${s.expectancyUsd}/trade | PF ${s.profitFactor}`
  );
  console.log(
    `Inferencia:  bootstrap IC95% [$${inf.bootstrap.ci95LowUsd}, $${inf.bootstrap.ci95HighUsd}] | binomial p=${fmtP(inf.binomialPValue)} | n efectivo ${inf.effectiveN} (lag-1 ${inf.autocorrelationLag1})`
  );
  if (result.walkForward) {
    console.log(`Walk-forward: ${result.walkForward.positiveFolds}/${result.walkForward.folds} folds positivos (${result.walkForward.expectancies.join(", ")})`);
  }
  if (result.scaling) {
    console.log(
      `Escalado:    breakeven de capital ${result.scaling.breakevenCapitalUsd === null ? "no alcanzado con la profundidad asumida" : `$${result.scaling.breakevenCapitalUsd}`}`
    );
  }
  if (inf.riskProfile.tTestUnsuitable) {
    console.log(`Perfil:      t-test inapropiado -> ${inf.riskProfile.unsuitabilityReasons.join("; ")}`);
  }
  console.log(`\nVEREDICTO: ${result.verdict}`);
  console.log(`  ${result.reason}`);
  if (inf.stopReasons.length) for (const r of inf.stopReasons) console.log(`  - ${r}`);
  if (result.limitations.length) {
    console.log("Limitaciones:");
    for (const l of result.limitations) console.log(`  - ${l}`);
  }
  if (result.issues.length) {
    console.log("Incidencias de ingesta:");
    for (const i of result.issues.slice(0, 10)) console.log(`  ! ${i}`);
  }
  if (meta.reportPath) console.log(`\nReporte: ${meta.reportPath}`);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    usage();
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const args = parseArgs(argv);
  if (!args.file) {
    console.error("Falta --file. Usar --help para ver el uso.");
    process.exit(1);
  }
  if (!existsSync(args.file)) {
    console.error(`Archivo no encontrado: ${args.file}`);
    process.exit(1);
  }

  const raw = readFileSync(args.file, "utf-8");
  const hash = sha256(raw);

  let adapter = args.adapter;
  if (adapter === "auto") {
    try {
      const parsed = JSON.parse(raw);
      adapter = parsed && typeof parsed === "object" && (Array.isArray(parsed.history) || "totalCapitalUsd" in parsed || "equity" in parsed)
        ? "alpha-engine"
        : "generic";
    } catch {
      adapter = "generic";
    }
    if (adapter === "generic" && !args.mapping) {
      console.error(
        "No se puede adivinar el esquema del archivo: pasá --mapping con el mapeo de columnas (ver --help) o --adapter alpha-engine."
      );
      process.exit(1);
    }
  }

  let dataset;
  try {
    if (adapter === "alpha-engine") {
      dataset = adaptAlphaEngineState(JSON.parse(raw), args.file);
    } else {
      if (!args.mapping) {
        console.error("--adapter generic requiere --mapping.");
        process.exit(1);
      }
      dataset = adaptGeneric(raw, {
        source: args.file,
        format: args.format ?? detectFormat(raw),
        delimiter: args.delimiter,
        mapping: loadMapping(args.mapping),
        capitalUsd: args.capital,
      });
    }
  } catch (err: any) {
    console.error(`Error de ingesta: ${err?.message || err}`);
    process.exit(1);
  }

  const result = runAudit(dataset, {
    capitalUsd: args.capital ?? dataset.account.capitalUsd,
    oosStart: args.oosStart,
    folds: args.folds,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = (args.label ?? args.file.split("/").pop() ?? "audit").replace(/[^a-zA-Z0-9._-]/g, "_");
  const reportPath = join(args.out, `audit_${slug}_${stamp}.json`);
  const payload = {
    tool: TOOL,
    generatedAt: new Date().toISOString(),
    input: { file: args.file, sha256: hash, adapter, label: args.label ?? null, capitalUsd: args.capital ?? dataset.account.capitalUsd ?? null, oosStart: args.oosStart ?? null },
    dataQuality: dataset.quality,
    result,
  };
  try {
    if (!existsSync(args.out)) mkdirSync(args.out, { recursive: true });
    writeFileSync(reportPath, JSON.stringify(payload, null, 2), "utf-8");
  } catch (err: any) {
    console.error(`No se pudo escribir el reporte: ${err?.message || err}`);
  }

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    printReport(result, { file: args.file, hash, adapter, label: args.label, reportPath });
  }

  process.exit(result.verdict === "NO AUDITABLE" ? 3 : 0);
}

main();
