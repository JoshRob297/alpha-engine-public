#!/usr/bin/env bun
/**
 * Cuarentena de eventos forenses sinteticos escritos por la suite de tests.
 *
 * Sintoma detectado: registros con mode=LIVE "Orden real colocada en Binance" y
 * fills con precio imposible (avgPrice=100000, orderId=1) en el log de produccion.
 * Origen: la suite de tests no estaba aislada del log forense (corregido en
 * src/telemetry/audit-logger.ts + forensic-audit-logger.ts).
 *
 * Este script NO borra evidencia: la mueve a data/audit_logs/quarantine/ y deja en
 * el archivo original un unico registro WARN documentando la extraccion.
 *
 * Uso:
 *   bun run scripts/quarantine-stub-audit-events.ts                # dry-run
 *   bun run scripts/quarantine-stub-audit-events.ts --apply
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const apply = process.argv.includes("--apply");
const get = (flag: string, fallback: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const logsDir = get("--dir", "./data/audit_logs");
const quarantineDir = join(logsDir, "quarantine");

/** Firma del stub: precio fuera de rango imposible con orderId de prueba. */
function isStub(rec: any): boolean {
  const m = rec?.metrics || {};
  const avg = Number(m.avgPrice);
  const orderId = Number(m.orderId);
  if (rec?.trigger === "ORDER_FILLED_REAL" && (avg >= 99999 || orderId === 1)) return true;
  if (rec?.trigger === "ORDER_PLACED" && rec?.mode === "LIVE" && /orden real/i.test(rec?.details || "")) {
    // Ordenes marcadas LIVE en un dia donde la tesoreria real estaba a cero.
    return avg === 0 || m.price === undefined ? false : true;
  }
  return false;
}

if (!existsSync(logsDir)) {
  console.error(`[AUDIT QUARANTINE] No existe el directorio: ${logsDir}`);
  process.exit(1);
}

const files = readdirSync(logsDir).filter((f) => f.endsWith(".jsonl"));
let totalMoved = 0;

for (const file of files) {
  const path = join(logsDir, file);
  const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  const parsed: Array<{ raw: string; rec: any }> = [];
  for (const l of lines) {
    try {
      parsed.push({ raw: l, rec: JSON.parse(l) });
    } catch {
      parsed.push({ raw: l, rec: null });
    }
  }

  const stubs = parsed.filter((p) => p.rec && isStub(p.rec));
  if (stubs.length === 0) continue;

  console.log(`[AUDIT QUARANTINE] ${file}: ${stubs.length} evento(s) sintetico(s)`);
  for (const s of stubs) {
    console.log(
      `   - ${s.rec.timestamp} mode=${s.rec.mode} ${s.rec.trigger} ${s.rec.asset} | ${s.rec.action} | ${(s.rec.details || "").slice(0, 90)}`
    );
  }
  totalMoved += stubs.length;

  if (!apply) continue;

  const kept = parsed.filter((p) => !(p.rec && isStub(p.rec)));
  kept.push({
    raw: JSON.stringify({
      id: `forensic_quarantine_${Date.now()}`,
      timestamp: new Date().toISOString(),
      mode: "PAPER",
      category: "SYS",
      trigger: "EVIDENCE_QUARANTINE",
      asset: "AUDIT_LOG",
      action: "STUB_EVENTS_REMOVED",
      details: `${stubs.length} evento(s) sintetico(s) movidos a quarantine/${file}.quarantined.jsonl (tests escribiendo en el log forense de produccion).`,
      level: "WARN",
      metrics: { removed: stubs.length, sourceFile: file },
    }),
    rec: null,
  });

  if (!existsSync(quarantineDir)) mkdirSync(quarantineDir, { recursive: true });
  for (const s of stubs) appendFileSync(join(quarantineDir, `${file}.quarantined.jsonl`), s.raw + "\n", "utf-8");
  writeFileSync(path, kept.map((k) => k.raw).join("\n") + "\n", "utf-8");
}

if (totalMoved === 0) {
  console.log("[AUDIT QUARANTINE] Sin eventos sinteticos detectados.");
} else if (!apply) {
  console.log(`[AUDIT QUARANTINE] Dry-run: ${totalMoved} evento(s) a mover. Ejecutar con --apply.`);
} else {
  console.log(`[AUDIT QUARANTINE] Aplicado: ${totalMoved} evento(s) movidos a ${quarantineDir}`);
}
