/**
 * Pruebas de la cadena de hashes de los logs forenses.
 *
 * Aislamiento: TODO se escribe bajo /tmp/opencode (fuera de `data/`). El guard de
 * `env-guard` sigue bloqueando el log forense de produccion, por lo que estas
 * pruebas jamas tocan artefactos reales.
 */

import { test, expect, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ForensicAuditLogger } from "./forensic-audit-logger.js";
import {
  GENESIS_HASH,
  canonicalizeForHash,
  computeRecordHash,
  verifyChain,
} from "./audit-chain.js";

const BASE_DIR = "/tmp/opencode/audit-chain-test";
let seq = 0;

/** Directorio unico por prueba (el logger es singleton; evita caché entre pruebas). */
function freshDir(): string {
  return join(BASE_DIR, `run_${process.pid}_${seq++}`);
}

function todayFile(dir: string): string {
  const dateStr = new Date().toISOString().split("T")[0];
  return join(dir, `sim_audit_${dateStr}.jsonl`);
}

function readRecords(filePath: string): Record<string, any>[] {
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

afterAll(() => {
  if (existsSync(BASE_DIR)) rmSync(BASE_DIR, { recursive: true, force: true });
});

test("canonicalizeForHash es estable con distinto orden de claves", () => {
  const a = { b: 1, a: { d: 2, c: 3 }, c: [{ z: 1, y: 2 }] };
  const b = { c: [{ y: 2, z: 1 }], a: { c: 3, d: 2 }, b: 1 };

  expect(canonicalizeForHash(a)).toBe(canonicalizeForHash(b));
  expect(canonicalizeForHash(a)).toBe('{"a":{"c":3,"d":2},"b":1,"c":[{"y":2,"z":1}]}');

  // Los metadatos de cadena del nivel superior se excluyen.
  expect(canonicalizeForHash({ x: 1, hash: "dead", prevHash: "beef" })).toBe('{"x":1}');
});

test("computeRecordHash es determinista y depende de prevHash", () => {
  const record = { id: "r1", v: 2 };
  expect(computeRecordHash(record, GENESIS_HASH)).toBe(computeRecordHash(record, GENESIS_HASH));
  expect(computeRecordHash(record, GENESIS_HASH)).not.toBe(computeRecordHash(record, "f".repeat(64)));
  expect(computeRecordHash(record, GENESIS_HASH)).toMatch(/^[0-9a-f]{64}$/);
});

test("verifyChain ignora registros pre-cadena y arranca con GENESIS_HASH", () => {
  const legacy = { id: "legacy", v: 0 };
  const seed = { id: "r0", v: 1 };
  const seedHash = computeRecordHash(seed, GENESIS_HASH);
  const r0 = { ...seed, prevHash: GENESIS_HASH, hash: seedHash };
  const next = { id: "r1", v: 2 };
  const nextHash = computeRecordHash(next, seedHash);
  const r1 = { ...next, prevHash: seedHash, hash: nextHash };

  const result = verifyChain([legacy, r0, r1]);
  expect(result.ok).toBe(true);
  expect(result.checked).toBe(2);
  expect(result.legacySkipped).toBe(1);
  expect(result.brokenAt).toBe(null);
  expect(result.brokenId).toBe(null);
});

test("ForensicAuditLogger encadena 5 eventos y verifyChain da ok", () => {
  const dir = freshDir();
  const logger = ForensicAuditLogger.getInstance(dir);

  for (let i = 0; i < 5; i++) {
    logger.logEvent("PAPER", "SYS", `TEST_TRIGGER_${i}`, "BTC", "TEST_ACTION", `evento ${i}`, "INFO", { i });
  }

  const filePath = todayFile(dir);
  expect(existsSync(filePath)).toBe(true);

  const records = readRecords(filePath);
  expect(records.length).toBe(5);

  // Cadena continua: el primero arranca en GENESIS y cada uno enlaza con el anterior.
  expect(records[0].prevHash).toBe(GENESIS_HASH);
  for (let i = 1; i < records.length; i++) {
    expect(records[i].prevHash).toBe(records[i - 1].hash);
    expect(records[i].hash).toMatch(/^[0-9a-f]{64}$/);
  }

  const result = verifyChain(records);
  expect(result.ok).toBe(true);
  expect(result.checked).toBe(5);
  expect(result.legacySkipped).toBe(0);
  expect(result.brokenAt).toBe(null);
});

test("verifyChain detecta la manipulacion de la linea 3", () => {
  const dir = freshDir();
  const logger = ForensicAuditLogger.getInstance(dir);

  for (let i = 0; i < 5; i++) {
    logger.logEvent("PAPER", "CEX", `GRID_FILL_${i}`, "SOL", "FILL_L1", `evento ${i}`, "INFO", { i });
  }

  const filePath = todayFile(dir);
  const lines = readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  // Manipulacion: cambia el contenido de la linea 3 sin recalcular su hash.
  const target = JSON.parse(lines[2]);
  const originalDetails = target.details;
  target.details = "MANIPULADO";
  lines[2] = JSON.stringify(target);
  writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

  const records = lines.map((line) => JSON.parse(line));
  const result = verifyChain(records);

  expect(target.details).not.toBe(originalDetails);
  expect(result.ok).toBe(false);
  expect(result.brokenAt).toBe(2);
  expect(result.brokenId).toBe(target.id);
  expect(result.checked).toBe(5);
  expect(result.legacySkipped).toBe(0);
});

test("logEvent resuelve el ultimo hash de un archivo existente (lazy init)", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  const filePath = todayFile(dir);

  // Simula un proceso previo que ya dejo un registro encadenado en disco.
  const seed = { id: "seed", v: 1 };
  const seedHash = computeRecordHash(seed, GENESIS_HASH);
  writeFileSync(
    filePath,
    JSON.stringify({ ...seed, prevHash: GENESIS_HASH, hash: seedHash }) + "\n",
    "utf-8"
  );

  const logger = ForensicAuditLogger.getInstance(dir);
  const event = logger.logEvent("PAPER", "SYS", "AFTER_RESTART", "BTC", "NOOP", "continuacion", "INFO");

  expect(event.prevHash).toBe(seedHash);

  const records = readRecords(filePath);
  expect(records.length).toBe(2);
  const result = verifyChain(records);
  expect(result.ok).toBe(true);
  expect(result.checked).toBe(2);
});
