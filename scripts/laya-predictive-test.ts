/**
 * FASE 2 — Test de Poder Predictivo de Laya (y baseline) sobre libro L2 real.
 *
 * Pregunta que responde: ¿la señal de Laya predice el movimiento adverso futuro
 * mejor que el OFI crudo / el spread? Si NO, Laya es un wrapper sin valor.
 *
 * Uso:
 *   bun run scripts/laya-predictive-test.ts --file data/l2/BTCUSDT_*.jsonl
 *   bun run scripts/laya-predictive-test.ts --file <f> --laya-ssh            (Laya en Compute-node via SSH)
 *   bun run scripts/laya-predictive-test.ts --file <f> --no-laya             (solo baselines)
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { OrderFlowImbalanceAnalyzer } from "../src/guardrails/ofi-analyzer.js";
import { evaluateSignal, spearmanIC } from "../src/research/predictive-stats.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? "true") : def;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

// Resolver archivo (soporta glob simple si no se pasa --file)
function resolveFile(): string {
  const f = arg("file");
  if (f && !f.includes("*")) return f;
  const dir = arg("dir", "data/l2")!;
  const prefix = arg("symbol")?.toUpperCase();
  const files = readdirSync(dir).filter((x) => x.endsWith(".jsonl") && (!prefix || x.startsWith(prefix))).sort();
  if (files.length === 0) throw new Error(`No hay archivos L2 en ${dir}`);
  return `${dir}/${files[files.length - 1]}`;
}

const FILE = resolveFile();
const LAYA_URL = arg("laya-url", "http://127.0.0.1:8088")!;
const USE_SSH = hasFlag("laya-ssh");
const NO_LAYAY = hasFlag("no-laya");
const SAMPLE_MS = parseInt(arg("sample-ms", "1000")!, 10);
const STATE_FORMAT = arg("state-format", "nl")!; // "nl" (texto natural) | "json"

/**
 * Construye el estado para Laya. Laya es un modelo de TEXTO: los números en JSON
 * apenas mueven su salida. Por defecto se envía una descripción en lenguaje natural.
 */
function buildState(ticker: string, book: string, mid: number, spreadBps: number, ofi: number, depthRatio: number, evap: boolean): any {
  if (STATE_FORMAT === "json") {
    return { ticker, book, mid_price: mid, spread_bps: spreadBps, ofi_score: ofi, depth_ratio: depthRatio, evaporating: evap };
  }
  const pressure =
    ofi > 0.5 ? "strong aggressive buying pressure" : ofi < -0.5 ? "strong aggressive selling pressure" : "balanced two-way flow";
  const bookState = evap ? "bid liquidity is evaporating rapidly" : "liquidity is stable";
  return {
    text:
      `Market snapshot for ${ticker}. Bid-ask spread is ${spreadBps.toFixed(2)} basis points. ` +
      `Order flow imbalance is ${ofi.toFixed(3)} on a scale from -1 (extreme aggressive selling) to +1 (extreme aggressive buying), indicating ${pressure}. ` +
      `Bid-to-ask depth ratio is ${depthRatio.toFixed(3)}. ${bookState}. Mid price is ${mid.toFixed(2)}.`,
  };
}
const HORIZONS = (arg("horizons", "1000,5000,30000,60000")!).split(",").map((x) => parseInt(x, 10));
const THRESHOLD_BPS = parseFloat(arg("threshold-bps", "2")!);

interface Snap { t: number; m: number; b: Array<[string, string]>; a: Array<[string, string]>; }

const snapshots: Snap[] = readFileSync(FILE, "utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean) as Snap[];

console.log(`[TEST] Archivo: ${FILE}`);
console.log(`[TEST] Snapshots: ${snapshots.length} | Sample: ${SAMPLE_MS}ms | Horizontes: ${HORIZONS.join(",")}ms | Umbral: ${THRESHOLD_BPS} bps`);

// Índices muestreados
const sampleIdx: number[] = [];
let lastT = -Infinity;
for (let i = 0; i < snapshots.length; i++) {
  if (snapshots[i].t - lastT >= SAMPLE_MS) { sampleIdx.push(i); lastT = snapshots[i].t; }
}

// Features OFI (alimentando TODOS los snapshots para conservar el delta real)
const analyzer = new OrderFlowImbalanceAnalyzer();
const ofiByIndex = new Array(snapshots.length).fill(0);
const spreadByIndex = new Array(snapshots.length).fill(0);
const depthRatioByIndex = new Array(snapshots.length).fill(0);
const evaporatingByIndex = new Array(snapshots.length).fill(false);
for (let i = 0; i < snapshots.length; i++) {
  const s = snapshots[i];
  const bids = s.b.map(([p, q]) => ({ price: parseFloat(p), amount: parseFloat(q) }));
  const asks = s.a.map(([p, q]) => ({ price: parseFloat(p), amount: parseFloat(q) }));
  const mt = analyzer.analyze({ bids, asks, timestamp: s.t });
  ofiByIndex[i] = mt.ofiScore;
  spreadByIndex[i] = asks[0] && bids[0] ? ((asks[0].price - bids[0].price) / s.m) * 10000 : 0;
  depthRatioByIndex[i] = mt.depthRatio;
  evaporatingByIndex[i] = mt.isLiquidityEvaporating;
}

// Retorno futuro (bps) por horizonte
function forwardBps(i: number, horizonMs: number): number | null {
  const target = snapshots[i].t + horizonMs;
  for (let j = i + 1; j < snapshots.length; j++) {
    if (snapshots[j].t >= target) return ((snapshots[j].m - snapshots[i].m) / snapshots[i].m) * 10000;
  }
  return null;
}

async function queryLaya(state: any): Promise<{ toxicFlow: number | null; meanReversion: number | null; regimeStress: number | null }> {
  const payload = JSON.stringify({
    state,
    questions: {
      toxic_flow: { type: "noul", instructions: "Is this aggressive/informed directional volume that will cause adverse selection?" },
      regime_stress: { type: "noul", instructions: "Is this book in systemic stress or abnormal spread expansion where quoting should pause?" },
      mean_reversion: { type: "noul", instructions: "Is the current price excursion likely to mean-revert within the near-term window?" },
    },
  });
  try {
    if (USE_SSH) {
      const out = execFileSync("ssh", ["compute-node", "curl -s -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:8088/decide"], { input: payload, timeout: 15000 });
      const parsed = JSON.parse(out.toString());
      const ans = parsed.answers || parsed;
      return { toxicFlow: ans.toxic_flow?.noul ?? null, regimeStress: ans.regime_stress?.noul ?? null, meanReversion: ans.mean_reversion?.noul ?? null };
    }
    const res = await fetch(`${LAYA_URL}/decide`, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { toxicFlow: null, meanReversion: null, regimeStress: null };
    const parsed: any = await res.json();
    const ans = parsed.answers || parsed;
    return { toxicFlow: ans.toxic_flow?.noul ?? null, regimeStress: ans.regime_stress?.noul ?? null, meanReversion: ans.mean_reversion?.noul ?? null };
  } catch {
    return { toxicFlow: null, meanReversion: null, regimeStress: null };
  }
}

async function main() {
  const toxicFlow: number[] = [];
  const meanRev: number[] = [];
  const ofi: number[] = [];
  const spread: number[] = [];
  const depthRatio: number[] = [];
  const idxUsed: number[] = [];

  // Fechas de retorno por horizonte
  const fwd: Record<number, number[]> = {};
  for (const h of HORIZONS) fwd[h] = [];

  let layaFails = 0;
  let layaQueried = 0;

  const ticker = (arg("symbol") || FILE.split("/").pop()!.split("_")[0] || "BTC").replace("USDT", "");
  const book = `${ticker}USDT`;

  for (const i of sampleIdx) {
    const fwdVals: Record<number, number | null> = {};
    let allFwd = true;
    for (const h of HORIZONS) {
      fwdVals[h] = forwardBps(i, h);
      if (fwdVals[h] === null) allFwd = false;
    }
    // Exigir TODOS los horizontes para mantener los arrays alineados (sin nulls).
    if (!allFwd) continue;

    ofi.push(ofiByIndex[i]);
    spread.push(spreadByIndex[i]);
    depthRatio.push(depthRatioByIndex[i]);
    idxUsed.push(i);

    let tf: number | null = null;
    let mr: number | null = null;
    if (!NO_LAYAY) {
      const r = await queryLaya(buildState(ticker, book, snapshots[i].m, spreadByIndex[i], ofiByIndex[i], depthRatioByIndex[i], evaporatingByIndex[i]));
      layaQueried++;
      tf = r.toxicFlow;
      mr = r.meanReversion;
      if (tf === null) layaFails++;
    } else {
      tf = 0; mr = 0;
    }
    toxicFlow.push(tf ?? 0);
    meanRev.push(mr ?? 0);

    for (const h of HORIZONS) fwd[h].push(fwdVals[h] as number);
  }

  console.log(`[TEST] Muestras útiles: ${idxUsed.length} | Consultas Laya: ${layaQueried} (fallos: ${layaFails})`);

  const report: any = { file: FILE, samples: idxUsed.length, layaQueried, layaFails, thresholdBps: THRESHOLD_BPS, horizons: {} };

  console.log(`\n${"=".repeat(96)}`);
  console.log(`  PODER PREDICTIVO — IC (Spearman) y AUC para evento adverso (retorno < -${THRESHOLD_BPS} bps)`);
  console.log(`${"=".repeat(96)}`);
  console.log(`  Señal                  | Horizonte | n   | IC        | AUC   | vsBaseline(AUC)`);
  console.log(`${"-".repeat(96)}`);

  for (const h of HORIZONS) {
    const y = fwd[h].slice(0, toxicFlow.length);
    if (y.length < 20) { console.log(`  (horizonte ${h}ms: muestras insuficientes)`); continue; }

    const evLaya = evaluateSignal(toxicFlow, y, THRESHOLD_BPS, true);
    const evOfiBear = evaluateSignal(ofi.map((v) => -v), y, THRESHOLD_BPS, true); // presión vendedora
    const evSpread = evaluateSignal(spread, y, THRESHOLD_BPS, true);
    const icMeanRev = spearmanIC(meanRev, y); // reversión: IC positivo esperado si predice rebote

    const bestBaseAuc = Math.max(evOfiBear.auc, evSpread.auc);
    const delta = (evLaya.auc - bestBaseAuc);

    console.log(`  Laya toxiFlow          | ${String(h).padStart(6)}ms  | ${String(evLaya.n).padStart(4)}| ${String(evLaya.ic).padStart(9)} | ${evLaya.auc} | ${delta >= 0 ? "+" : ""}${delta.toFixed(4)}`);
    console.log(`  -OFI (baseline)        | ${String(h).padStart(6)}ms  | ${String(evOfiBear.n).padStart(4)}| ${String(evOfiBear.ic).padStart(9)} | ${evOfiBear.auc} | (ref)`);
    console.log(`  Spread (baseline)      | ${String(h).padStart(6)}ms  | ${String(evSpread.n).padStart(4)}| ${String(evSpread.ic).padStart(9)} | ${evSpread.auc} | (ref)`);
    console.log(`  Laya meanReversion IC  | ${String(h).padStart(6)}ms  | ${String(evLaya.n).padStart(4)}| ${String(icMeanRev).padStart(9)} |   -   | (reversión)`);
    console.log(`${"-".repeat(96)}`);

    report.horizons[h] = {
      layaToxicFlow: evLaya,
      baselineNegOfi: evOfiBear,
      baselineSpread: evSpread,
      layaMeanReversionIC: icMeanRev,
      beatsBaselineAuc: delta > 0,
    };
  }

  // Veredicto
  const horizonsArr = HORIZONS.map((h) => report.horizons[h]).filter(Boolean);
  const beats = horizonsArr.filter((x: any) => x.beatsBaselineAuc).length;
  const verdict =
    layaFails === layaQueried
      ? "INCONCLUSO: Laya no respondió (¿servicio apagado?). Correr baselines y reintentar con Laya activa."
      : beats >= Math.ceil(horizonsArr.length / 2)
      ? "Laya APORTA: bate al baseline (OFI crudo) en la mayoría de horizontes. Hay señal para explorar."
      : "Laya NO APORTA: no supera al baseline de OFI crudo. Es un wrapper sin valor predictivo añadido.";

  console.log(`\n[VEREDICTO] ${verdict}`);

  try {
    writeFileSync("data/laya_predictive_report.json", JSON.stringify({ ...report, verdict }, null, 2));
    console.log("[REPORT] data/laya_predictive_report.json");
  } catch {}
}

main().catch((e) => console.error("[TEST ERROR]", e));
