/**
 * Tests del grabador de inputs de replay.
 *
 * Regla dura: nada se escribe fuera de /tmp/opencode. En entorno de pruebas el
 * guard (env-guard.ts) bloquea el directorio por defecto y cualquier ruta bajo
 * data/, por lo que cada test pasa su propio directorio temporal explicito.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  __resetLineCountCache,
  isRecordingWriteAllowed,
  readRecordedWindow,
  recordPulseInput,
  summarizeRecording,
  type PulseInputSample,
} from "./input-recorder.js";
import { isTestEnvironment } from "./env-guard.js";

const TMP_ROOT = "/tmp/opencode/input-recorder-tests";
let dir = "";

function freshDir(name: string): string {
  const target = join(TMP_ROOT, name);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  return target;
}

function sample(overrides: Partial<PulseInputSample> = {}): PulseInputSample {
  return {
    ticker: "BTC",
    mid: 100_000,
    bid: 99_990,
    ask: 100_010,
    spreadBps: 2.0,
    ofiScore: 0.10,
    depthRatio: 1.10,
    toxicFlow: 0.12,
    jevRegime: "BALANCED_RANGE",
    jevConfidence: 0.80,
    layaToxicFlow: 0.12,
    decision: "HOLD",
    reason: "Normal holding",
    ...overrides,
  };
}

beforeEach(() => {
  __resetLineCountCache();
  dir = freshDir("case");
});

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

test("entorno de pruebas detectado y escritura por defecto bloqueada", () => {
  expect(isTestEnvironment()).toBe(true);
  expect(isRecordingWriteAllowed("./data/replay")).toBe(false);
  expect(isRecordingWriteAllowed("./data")).toBe(false);
});

test("recordPulseInput no escribe en data/ ni en el directorio por defecto durante tests", () => {
  const defaultResult = recordPulseInput(sample());
  expect(defaultResult.written).toBe(false);
  expect(defaultResult.reason).toBe("test_environment_default_dir_blocked");

  const dataResult = recordPulseInput(sample(), { dir: "./data/replay" });
  expect(dataResult.written).toBe(false);
  expect(dataResult.reason).toBe("test_environment_data_dir_blocked");

  const cwdData = recordPulseInput(sample(), { dir: join(process.cwd(), "data", "replay") });
  expect(cwdData.written).toBe(false);

  const nonTemp = recordPulseInput(sample(), { dir: "/root/proyectos/alpha-engine/tmp-replay" });
  expect(nonTemp.written).toBe(false);
  expect(nonTemp.reason).toBe("test_environment_non_temp_dir_blocked");

  expect(existsSync("./data/replay")).toBe(false);
  expect(existsSync("/root/proyectos/alpha-engine/tmp-replay")).toBe(false);
});

test("roundtrip: escribe y relee los samples con metadatos de trazabilidad", () => {
  const res = recordPulseInput(sample({ timestampIso: "2026-01-02T10:00:00.000Z", ticker: "BTC" }), { dir });
  expect(res.written).toBe(true);
  expect(res.path).toBe(join(dir, "2026-01-02.jsonl"));

  recordPulseInput(sample({ timestampIso: "2026-01-02T10:00:05.000Z", ticker: "SOL", mid: 200 }), { dir });

  const window = readRecordedWindow({ dir });
  expect(window.samples.length).toBe(2);
  expect(window.corruptLines).toBe(0);
  expect(window.files.length).toBe(1);

  const first = window.samples[0];
  expect(first.ticker).toBe("BTC");
  expect(first.mid).toBe(100_000);
  expect(first.bid).toBe(99_990);
  expect(first.ask).toBe(100_010);
  expect(first.spreadBps).toBe(2.0);
  expect(first.ofiScore).toBe(0.10);
  expect(first.depthRatio).toBe(1.10);
  expect(first.toxicFlow).toBe(0.12);
  expect(first.jevRegime).toBe("BALANCED_RANGE");
  expect(first.jevConfidence).toBe(0.80);
  expect(first.layaToxicFlow).toBe(0.12);
  expect(first.decision).toBe("HOLD");
  expect(first.timestampIso).toBe("2026-01-02T10:00:00.000Z");
  expect(typeof first.engineVersion).toBe("string");
  expect(first.pid).toBe(process.pid);
});

test("rotacion por fecha UTC: un archivo por dia y orden por timestamp", () => {
  recordPulseInput(sample({ timestampIso: "2026-03-01T23:59:59.000Z" }), { dir });
  recordPulseInput(sample({ timestampIso: "2026-03-02T00:00:01.000Z" }), { dir });
  recordPulseInput(sample({ timestampIso: "2026-03-02T12:00:00.000Z" }), { dir });

  expect(existsSync(join(dir, "2026-03-01.jsonl"))).toBe(true);
  expect(existsSync(join(dir, "2026-03-02.jsonl"))).toBe(true);

  const summary = summarizeRecording(dir);
  expect(summary.days).toBe(2);
  expect(summary.files).toBe(2);
  expect(summary.samples).toBe(3);
  expect(summary.firstTs).toBe("2026-03-01T23:59:59.000Z");
  expect(summary.lastTs).toBe("2026-03-02T12:00:00.000Z");
  expect(summary.decisions.HOLD).toBe(3);
});

test("rotacion por cap: al superar N lineas rota a .1 y sigue en el archivo nuevo", () => {
  for (let i = 0; i < 5; i++) {
    const res = recordPulseInput(sample({ timestampIso: `2026-04-05T00:00:0${i}.000Z` }), {
      dir,
      maxLinesPerFile: 3,
    });
    expect(res.written).toBe(true);
    if (i === 3) expect(res.rotated).toBe(true);
    if (i < 3) expect(res.rotated).toBe(false);
  }

  const base = join(dir, "2026-04-05.jsonl");
  const rotated = `${base}.1`;
  expect(existsSync(rotated)).toBe(true);

  const baseLines = readFileSync(base, "utf-8").trim().split("\n").length;
  const rotatedLines = readFileSync(rotated, "utf-8").trim().split("\n").length;
  expect(rotatedLines).toBe(3);
  expect(baseLines).toBe(2);

  const window = readRecordedWindow({ dir });
  expect(window.samples.length).toBe(5);
  expect(window.samples[0].timestampIso).toBe("2026-04-05T00:00:00.000Z");
  expect(window.samples[4].timestampIso).toBe("2026-04-05T00:00:04.000Z");
});

test("readRecordedWindow filtra por ticker y por rango temporal", () => {
  recordPulseInput(sample({ timestampIso: "2026-05-01T00:00:00.000Z", ticker: "BTC" }), { dir });
  recordPulseInput(sample({ timestampIso: "2026-05-01T06:00:00.000Z", ticker: "SOL" }), { dir });
  recordPulseInput(sample({ timestampIso: "2026-05-02T00:00:00.000Z", ticker: "BTC" }), { dir });
  recordPulseInput(sample({ timestampIso: "2026-05-03T00:00:00.000Z", ticker: "BTC" }), { dir });

  const byTicker = readRecordedWindow({ dir, ticker: "BTC" });
  expect(byTicker.samples.map((s) => s.timestampIso)).toEqual([
    "2026-05-01T00:00:00.000Z",
    "2026-05-02T00:00:00.000Z",
    "2026-05-03T00:00:00.000Z",
  ]);

  const byRange = readRecordedWindow({
    dir,
    fromIso: "2026-05-01T05:00:00.000Z",
    toIso: "2026-05-02T00:00:00.000Z",
  });
  expect(byRange.samples.map((s) => s.ticker)).toEqual(["SOL", "BTC"]);

  const onlySecondDay = readRecordedWindow({
    dir,
    fromIso: "2026-05-02T00:00:00.000Z",
    toIso: "2026-05-02T23:59:59.000Z",
    ticker: "BTC",
  });
  expect(onlySecondDay.samples.length).toBe(1);
  expect(onlySecondDay.samples[0].timestampIso).toBe("2026-05-02T00:00:00.000Z");
});

test("lineas corruptas se ignoran y se cuentan; los samples validos siguen leyendose", () => {
  recordPulseInput(sample({ timestampIso: "2026-06-07T00:00:00.000Z" }), { dir });
  const path = join(dir, "2026-06-07.jsonl");
  const valid = readFileSync(path, "utf-8");
  writeFileSync(path, `${valid}{"ticker":"BTC", roto\n\nno-json\n{"ticker":"ETH"}\n`, "utf-8");

  const window = readRecordedWindow({ dir });
  expect(window.samples.length).toBe(1);
  expect(window.corruptLines).toBe(3);
  expect(window.totalLines).toBe(4);

  const summary = summarizeRecording(dir);
  expect(summary.samples).toBe(1);
  expect(summary.corruptLines).toBe(3);
});

test("summarizeRecording cuenta decisiones por valor y agrupa las ausentes", () => {
  recordPulseInput(sample({ timestampIso: "2026-07-01T00:00:00.000Z", decision: "HOLD" }), { dir });
  recordPulseInput(sample({ timestampIso: "2026-07-01T00:01:00.000Z", decision: "HOLD" }), { dir });
  recordPulseInput(sample({ timestampIso: "2026-07-01T00:02:00.000Z", decision: "FRONT_RUN_EXIT" }), { dir });
  recordPulseInput(sample({ timestampIso: "2026-07-01T00:03:00.000Z", decision: undefined }), { dir });

  const summary = summarizeRecording(dir);
  expect(summary.days).toBe(1);
  expect(summary.samples).toBe(4);
  expect(summary.decisions.HOLD).toBe(2);
  expect(summary.decisions.FRONT_RUN_EXIT).toBe(1);
  expect(summary.decisions.sin_decision).toBe(1);
});

test("timestamp invalido cae al reloj del proceso sin romper la escritura", () => {
  const res = recordPulseInput(sample({ timestampIso: "no-es-fecha" }), { dir });
  expect(res.written).toBe(true);

  const day = new Date().toISOString().slice(0, 10);
  expect(res.path).toBe(join(dir, `${day}.jsonl`));

  const window = readRecordedWindow({ dir });
  expect(window.samples.length).toBe(1);
  expect(window.samples[0].timestampIso).toBe(new Date(window.samples[0].timestampIso).toISOString());
});
