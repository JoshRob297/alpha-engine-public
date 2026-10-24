#!/usr/bin/env bun
/**
 * Verificador de integridad de la cadena de hashes de los logs forenses.
 *
 * Uso:
 *   bun run scripts/verify-audit-chain.ts --file data/audit_logs/sim_audit_2026-10-16.jsonl
 *   bun run scripts/verify-audit-chain.ts --all [--dir data/audit_logs]
 *   bun run scripts/verify-audit-chain.ts --all --json
 *
 * Salida por archivo: registros, verificados, pre-cadena y resultado.
 * Exit code 1 si algun archivo presenta ruptura de cadena; 0 si todo esta ok.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { verifyChain } from "../src/telemetry/audit-chain.js";

interface FileReport {
  file: string;
  records: number;
  checked: number;
  legacySkipped: number;
  brokenAt: number | null;
  brokenId: string | null;
  ok: boolean;
  parseErrors: number;
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function verifyFile(filePath: string): FileReport {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  const records: Record<string, any>[] = [];
  const brokenLines: boolean[] = [];
  let parseErrors = 0;

  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
      brokenLines.push(false);
    } catch {
      parseErrors++;
      // Una linea ilegible rompe la cadena: no se puede re-verificar su hash.
      records.push(null as unknown as Record<string, any>);
      brokenLines.push(true);
    }
  }

  const chain = verifyChain(records);
  const firstBrokenLine = brokenLines.indexOf(true);

  const brokenAt = chain.brokenAt !== null
    ? chain.brokenAt
    : firstBrokenLine >= 0
      ? firstBrokenLine
      : null;

  return {
    file: filePath,
    records: lines.length,
    checked: chain.checked,
    legacySkipped: chain.legacySkipped,
    brokenAt,
    brokenId: chain.brokenId,
    ok: chain.ok && parseErrors === 0,
    parseErrors,
  };
}

function printReport(report: FileReport): void {
  const estado = report.ok
    ? "OK"
    : `RUPTURA${report.brokenAt !== null ? ` en indice ${report.brokenAt}` : ""}${
        report.brokenId ? ` (id ${report.brokenId})` : ""
      }`;
  console.log(report.file);
  console.log(`  registros:   ${report.records}`);
  console.log(`  verificados: ${report.checked}`);
  console.log(`  pre-cadena:  ${report.legacySkipped}`);
  if (report.parseErrors > 0) console.log(`  lineas ilegibles: ${report.parseErrors}`);
  console.log(`  resultado:   ${estado}`);
}

function main(): void {
  const json = process.argv.includes("--json");
  const single = argValue("--file");
  const all = process.argv.includes("--all");
  const dir = resolve(argValue("--dir") ?? "data/audit_logs");

  if (!single && !all) {
    console.error("Uso: bun run scripts/verify-audit-chain.ts --file <ruta> | --all [--dir <dir>] [--json]");
    process.exit(2);
  }

  const files: string[] = [];
  if (single) {
    const filePath = resolve(single);
    if (!existsSync(filePath)) {
      console.error(`Archivo no encontrado: ${filePath}`);
      process.exit(2);
    }
    files.push(filePath);
  } else {
    if (!existsSync(dir)) {
      if (json) console.log(JSON.stringify({ dir, files: [], ok: true }));
      else console.log(`Sin directorio de auditoria: ${dir}`);
      process.exit(0);
    }
    for (const entry of readdirSync(dir).sort()) {
      if (entry.endsWith(".jsonl")) files.push(join(dir, entry));
    }
    if (files.length === 0) {
      if (json) console.log(JSON.stringify({ dir, files: [], ok: true }));
      else console.log(`Sin archivos .jsonl en: ${dir}`);
      process.exit(0);
    }
  }

  const reports = files.map(verifyFile);
  const failed = reports.filter((r) => !r.ok);

  if (json) {
    console.log(JSON.stringify({ files: reports, ok: failed.length === 0 }, null, 2));
  } else {
    for (const report of reports) printReport(report);
    console.log("");
    console.log(
      `RESUMEN: ${reports.length - failed.length}/${reports.length} archivos integros${failed.length > 0 ? `, ${failed.length} con ruptura` : ""}`
    );
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

main();
