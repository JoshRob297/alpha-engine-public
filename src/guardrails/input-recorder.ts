/**
 * Grabador de inputs por pulso (reproducibilidad y auditoria del OOS Paper).
 *
 * Problema que resuelve: el test OOS de la corrida Paper no era reproducible porque
 * no se persistian ni los inputs de mercado (mid/bid/ask/spread/OFI/depth) ni el
 * juicio de Jev/Laya ni la decision tomada. Sin esos datos, un replay no puede
 * distinguir "el motor decidio distinto" de "el mercado estaba distinto".
 *
 * Diseno:
 * - Append-only por dia UTC: <dir>/<YYYY-MM-DD>.jsonl (rotacion diaria).
 * - Rotacion por cap de lineas: al superar N lineas el archivo vigente se renombra
 *   a <YYYY-MM-DD>.jsonl.1 y se continua con uno nuevo (no se pierde historia).
 * - Cada linea lleva engineVersion y pid para trazabilidad del binario/proceso que
 *   la escribio.
 * - Aislamiento de tests: en entorno de pruebas NO se escribe nunca en el directorio
 *   por defecto ni dentro de data/. Solo se autoriza un directorio temporal explicito
 *   en /tmp (ver env-guard.ts).
 *
 * El registro del timestamp de muestreo (timestampIso) es lo que ordena el replay;
 * recordedAtIso solo documenta cuando se persistio la linea.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { allowProductionWrite } from "./env-guard.js";

/** Directorio por defecto de grabaciones (relativo al cwd del proceso). */
export const DEFAULT_REPLAY_DIR = "./data/replay";

/** Cap de lineas por archivo antes de rotar a ".1". */
export const DEFAULT_MAX_LINES_PER_FILE = 20_000;

/**
 * Input de un pulso del motor. Las claves de microestructura y regimen son
 * deliberadamente las mismas que consume la gobernanza de salidas, para que el
 * replay pueda reevaluar la decision con los mismos campos.
 *
 * Campos de contexto de posicion (book/entryAvgPrice/currentGainPct/targetTpPrice/
 * alreadyPartialTakenPct) son opcionales en el tipo pero son REQUERIDOS por la
 * gobernanza de salidas; sin ellos el replay solo puede reproducir la parte de
 * clasificacion, no el fallo de umbrales. Se documenta en scripts/replay-decisions.ts.
 */
export interface PulseInputSample {
  /** Timestamp de muestreo (UTC ISO). Si falta se usa el reloj del proceso. */
  timestampIso?: string;
  ticker: string;
  mid: number;
  bid: number;
  ask: number;
  spreadBps: number;
  ofiScore: number;
  depthRatio: number;
  toxicFlow: number;
  jevRegime: string;
  jevConfidence: number;
  /** Juicio de Laya ya resuelto (toxicFlow). Si falta, el replay aplica el fail-safe del motor. */
  layaToxicFlow?: number;
  /** Decision efectivamente tomada por el motor en este pulso. */
  decision?: string;
  /** Motivo textual de la decision. */
  reason?: string;
  /** Libro/par operado (solo trazabilidad, no afecta la decision). */
  book?: string;
  /** Precio promedio de entrada de la posicion. */
  entryAvgPrice?: number;
  /** Ganancia actual en porcentaje (si el motor ya la calculo, se prefiere sobre mid/entryAvgPrice). */
  currentGainPct?: number;
  /** Precio objetivo del genoma para el cierre total. */
  targetTpPrice?: number;
  /** Porcentaje de la posicion ya cerrado en parciales previos (0..1). */
  alreadyPartialTakenPct?: number;
}

/** Linea efectivamente persistida: sample original + metadatos de trazabilidad. */
export interface RecordedPulseInput extends PulseInputSample {
  timestampIso: string;
  recordedAtIso: string;
  engineVersion: string;
  pid: number;
}

export interface RecordPulseOptions {
  /** Directorio destino. Si se omite usa env REPLAY_DIR o ./data/replay. */
  dir?: string;
  /** Cap de lineas por archivo antes de rotar. Default 20000 o env REPLAY_MAX_LINES. */
  maxLinesPerFile?: number;
  /** Version del motor que firma las lineas. Default env ENGINE_VERSION o "alpha-engine@dev". */
  engineVersion?: string;
}

export interface RecordPulseResult {
  written: boolean;
  path: string | null;
  /** Motivo cuando no se escribio (bloqueo por entorno de pruebas o error de I/O). */
  reason?: string;
  /** true si esta escritura provoco una rotacion a ".1". */
  rotated?: boolean;
}

export interface ReadWindowOptions {
  dir?: string;
  /** Limite inferior inclusivo (ISO). */
  fromIso?: string;
  /** Limite superior inclusivo (ISO). */
  toIso?: string;
  ticker?: string;
}

export interface RecordedWindow {
  samples: RecordedPulseInput[];
  /** Archivos efectivamente leidos (paths absolutos). */
  files: string[];
  /** Lineas no parseables o sin forma de sample (se ignoran y se cuentan). */
  corruptLines: number;
  /** Lineas totales leidas (validas + corruptas). */
  totalLines: number;
}

export interface RecordingSummary {
  days: number;
  files: number;
  samples: number;
  firstTs: string | null;
  lastTs: string | null;
  /** Conteo de pulsos por decision; los pulsos sin decision se agrupan en "sin_decision". */
  decisions: Record<string, number>;
  corruptLines: number;
}

const REPLAY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl(?:\.(\d+))?$/;

/**
 * Cache de lineas por archivo. Evita releer el archivo completo en cada append;
 * se hidrata una sola vez por path y proceso, y se invalida al rotar.
 */
const lineCountCache = new Map<string, number>();

function resolveReplayDir(explicitDir?: string): { dir: string; explicit: boolean } {
  const raw = explicitDir ?? process.env.REPLAY_DIR;
  return { dir: resolve(raw ?? DEFAULT_REPLAY_DIR), explicit: raw !== undefined && raw !== "" };
}

function isInsideDir(base: string, target: string): boolean {
  const b = resolve(base);
  const t = resolve(target);
  return t === b || t.startsWith(b + sep);
}

/**
 * Unica puerta que decide si esta grabacion puede tocar disco.
 * - Produccion (no test): sin restricciones.
 * - Tests: exige dir explicito y que caiga en un temporal; jamas dentro de data/.
 */
function evaluateWritePermission(dir: string, explicit: boolean): string | null {
  if (allowProductionWrite()) return null;

  if (!explicit) return "test_environment_default_dir_blocked";
  if (isInsideDir(resolve(process.cwd(), "data"), dir) || basename(dir) === "data") {
    return "test_environment_data_dir_blocked";
  }
  if (!isInsideDir(tmpdir(), dir)) return "test_environment_non_temp_dir_blocked";
  return null;
}

function resolveMaxLines(opts: RecordPulseOptions): number {
  if (typeof opts.maxLinesPerFile === "number" && opts.maxLinesPerFile > 0) {
    return Math.floor(opts.maxLinesPerFile);
  }
  const fromEnv = Number(process.env.REPLAY_MAX_LINES);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return DEFAULT_MAX_LINES_PER_FILE;
}

function resolveEngineVersion(opts: RecordPulseOptions): string {
  return opts.engineVersion ?? process.env.ENGINE_VERSION ?? "alpha-engine@dev";
}

function normalizeTimestamp(timestampIso?: string): string {
  if (typeof timestampIso === "string" && timestampIso.length > 0) {
    const parsed = new Date(timestampIso);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function countLinesInFile(path: string): number {
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf-8");
  if (text.length === 0) return 0;
  const parts = text.split("\n");
  // Si el archivo no termina en salto, la ultima linea es parcial pero cuenta.
  return text.endsWith("\n") ? parts.length - 1 : parts.length;
}

function getCachedLineCount(path: string): number {
  const cached = lineCountCache.get(path);
  if (cached !== undefined) return cached;
  const counted = countLinesInFile(path);
  lineCountCache.set(path, counted);
  return counted;
}

/**
 * Graba un pulsos del motor. Devuelve el resultado de la escritura en lugar de
 * lanzar, para que el motor pueda continuar aunque el disco este lleno o el
 * entorno este bloqueado.
 */
export function recordPulseInput(sample: PulseInputSample, opts: RecordPulseOptions = {}): RecordPulseResult {
  const { dir, explicit } = resolveReplayDir(opts.dir);

  const blocked = evaluateWritePermission(dir, explicit);
  if (blocked !== null) {
    return { written: false, path: null, reason: blocked };
  }

  const timestampIso = normalizeTimestamp(sample.timestampIso);
  const day = timestampIso.slice(0, 10);
  const basePath = join(dir, `${day}.jsonl`);
  const maxLines = resolveMaxLines(opts);

  try {
    mkdirSync(dir, { recursive: true });

    let rotated = false;
    const currentLines = getCachedLineCount(basePath);
    if (currentLines >= maxLines) {
      renameSync(basePath, `${basePath}.1`);
      lineCountCache.set(basePath, 0);
      rotated = true;
    }

    const record: RecordedPulseInput = {
      ...sample,
      timestampIso,
      recordedAtIso: new Date().toISOString(),
      engineVersion: resolveEngineVersion(opts),
      pid: process.pid,
    };

    appendFileSync(basePath, JSON.stringify(record) + "\n", "utf-8");
    lineCountCache.set(basePath, getCachedLineCount(basePath) + 1);

    return { written: true, path: basePath, rotated };
  } catch (err) {
    return {
      written: false,
      path: null,
      reason: `write_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function isRecordedSample(value: unknown): value is RecordedPulseInput {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.ticker === "string" && typeof v.timestampIso === "string";
}

function listReplayFiles(dir: string, fromIso?: string, toIso?: string): string[] {
  if (!existsSync(dir)) return [];

  const fromDay = typeof fromIso === "string" ? fromIso.slice(0, 10) : null;
  const toDay = typeof toIso === "string" ? toIso.slice(0, 10) : null;

  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const match = REPLAY_FILE_PATTERN.exec(entry);
    if (match === null) continue;
    const day = match[1];
    if (fromDay !== null && day < fromDay) continue;
    if (toDay !== null && day > toDay) continue;
    files.push(join(dir, entry));
  }
  files.sort();
  return files;
}

/**
 * Lee y ordena los pulsos grabados de una ventana. Las lineas corruptas no abortan
 * la lectura: se ignoran y se cuentan para auditoria.
 */
export function readRecordedWindow(opts: ReadWindowOptions = {}): RecordedWindow {
  const { dir } = resolveReplayDir(opts.dir);
  const files = listReplayFiles(dir, opts.fromIso, opts.toIso);

  const samples: RecordedPulseInput[] = [];
  let corruptLines = 0;
  let totalLines = 0;

  const fromMs = opts.fromIso !== undefined ? new Date(opts.fromIso).getTime() : null;
  const toMs = opts.toIso !== undefined ? new Date(opts.toIso).getTime() : null;
  const fromValid = fromMs !== null && !Number.isNaN(fromMs) ? fromMs : null;
  const toValid = toMs !== null && !Number.isNaN(toMs) ? toMs : null;

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      totalLines += 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        corruptLines += 1;
        continue;
      }

      if (!isRecordedSample(parsed)) {
        corruptLines += 1;
        continue;
      }

      if (opts.ticker !== undefined && parsed.ticker !== opts.ticker) continue;

      const tsMs = new Date(parsed.timestampIso).getTime();
      if (Number.isNaN(tsMs)) {
        corruptLines += 1;
        continue;
      }
      if (fromValid !== null && tsMs < fromValid) continue;
      if (toValid !== null && tsMs > toValid) continue;

      samples.push(parsed);
    }
  }

  samples.sort((a, b) => new Date(a.timestampIso).getTime() - new Date(b.timestampIso).getTime());

  return { samples, files, corruptLines, totalLines };
}

/** Resumen de una carpeta de grabaciones para auditoria rapida. */
export function summarizeRecording(dir?: string): RecordingSummary {
  const resolved = resolveReplayDir(dir).dir;
  const files = listReplayFiles(resolved);
  const windows = readRecordedWindow({ dir: resolved });
  const samples = windows.samples;

  const days = new Set<string>();
  for (const file of files) {
    const match = REPLAY_FILE_PATTERN.exec(basename(file));
    if (match !== null) days.add(match[1]);
  }

  const decisions: Record<string, number> = {};
  for (const sample of samples) {
    const key = typeof sample.decision === "string" && sample.decision.length > 0 ? sample.decision : "sin_decision";
    decisions[key] = (decisions[key] ?? 0) + 1;
  }

  return {
    days: days.size,
    files: files.length,
    samples: samples.length,
    firstTs: samples.length > 0 ? samples[0].timestampIso : null,
    lastTs: samples.length > 0 ? samples[samples.length - 1].timestampIso : null,
    decisions,
    corruptLines: windows.corruptLines,
  };
}

/** Expuesto para tests: limpia la cache de conteo de lineas por proceso. */
export function __resetLineCountCache(): void {
  lineCountCache.clear();
}

/** Expuesto para diagnostico: indica si el entorno actual bloquea escrituras. */
export function isRecordingWriteAllowed(dir = DEFAULT_REPLAY_DIR): boolean {
  const resolved = resolveReplayDir(dir);
  return evaluateWritePermission(resolved.dir, resolved.explicit) === null;
}
