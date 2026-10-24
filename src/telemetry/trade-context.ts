/**
 * Provenance por operacion (reproducibilidad del registro).
 *
 * Motivo: el ledger guardaba el resultado de cada cierre pero NO el contexto que lo
 * produjo (regimen, OFI, toxicidad, juicio de Laya, modelo de IL, version del motor).
 * Sin eso no se puede reconstruir por que se cerro un trade ni auditar la decision
 * meses despues: el registro queda irreproducible.
 *
 * Este modulo construye el contexto con lo que el motor tiene en el momento de la
 * decision. Todo opcional: si un campo no esta disponible se omite (no se inventa).
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface TradeContext {
  /** Version del motor (package.json) al momento de la operacion. */
  engineVersion: string;
  /** Modelo de IL activo en el tramo DEX. */
  ilModel?: "concentrated" | "full_range";
  /** Regimen macro aplicado a la asignacion. */
  appliedRegime?: string;
  /** Regimen observado en el activo. */
  assetRegime?: string;
  jevConfidence?: number;
  spreadBps?: number;
  ofiScore?: number;
  toxicFlow?: number;
  /** Juicio de toxicidad de Laya (0..1) reconstruido desde el pulso. */
  layaToxicFlow?: number;
  /** Huella del genoma activo del activo (no el valor: solo identificacion). */
  genomeFingerprint?: string;
  /** Fraccion de la posicion ya realizada por tomas parciales. */
  partialTakenPct?: number;
  freezer?: boolean;
}

let cachedEngineVersion: string | null = null;

export function engineVersionString(): string {
  if (cachedEngineVersion) return cachedEngineVersion;
  for (const path of ["package.json", "/home/user/proyectos/alpha-engine/package.json"]) {
    try {
      if (existsSync(path)) {
        const pkg = JSON.parse(readFileSync(path, "utf-8"));
        cachedEngineVersion = typeof pkg.version === "string" ? pkg.version : "unknown";
        return cachedEngineVersion!;
      }
    } catch {}
  }
  cachedEngineVersion = "unknown";
  return cachedEngineVersion;
}

/** Huella estable de un genoma (identifica la configuracion sin duplicarla en el log). */
export function genomeFingerprint(genome: unknown): string | undefined {
  if (!genome || typeof genome !== "object") return undefined;
  try {
    const canonical = JSON.stringify(genome, Object.keys(genome as Record<string, unknown>).sort());
    return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  } catch {
    return undefined;
  }
}

export function buildTradeContext(input: {
  appliedRegime?: string;
  assetRegime?: string;
  jevConfidence?: number;
  spreadBps?: number;
  ofiScore?: number;
  toxicFlow?: number;
  layaToxicFlow?: number;
  genome?: unknown;
  partialTakenPct?: number;
}): TradeContext {
  const ctx: TradeContext = {
    engineVersion: engineVersionString(),
    ilModel: process.env.DEX_IL_MODEL === "full_range" ? "full_range" : "concentrated",
    freezer: process.env.GENOME_FREEZE === "true",
  };
  if (input.appliedRegime) ctx.appliedRegime = input.appliedRegime;
  if (input.assetRegime) ctx.assetRegime = input.assetRegime;
  if (typeof input.jevConfidence === "number") ctx.jevConfidence = round(input.jevConfidence, 4);
  if (typeof input.spreadBps === "number") ctx.spreadBps = round(input.spreadBps, 3);
  if (typeof input.ofiScore === "number") ctx.ofiScore = round(input.ofiScore, 4);
  if (typeof input.toxicFlow === "number") ctx.toxicFlow = round(input.toxicFlow, 4);
  if (typeof input.layaToxicFlow === "number") ctx.layaToxicFlow = round(input.layaToxicFlow, 4);
  if (typeof input.partialTakenPct === "number") ctx.partialTakenPct = round(input.partialTakenPct, 4);
  const fp = genomeFingerprint(input.genome);
  if (fp) ctx.genomeFingerprint = fp;
  return ctx;
}

function round(v: number, digits: number): number {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}
