/**
 * Replay determinista de DECISIONES sobre una ventana grabada de pulsos.
 *
 * Objetivo: detectar no-determinismo en el test OOS de la corrida Paper. Lee los
 * inputs grabados por src/guardrails/input-recorder.ts y vuelve a evaluar la decision
 * de salida, comparandola con la decision que el motor grabo en su momento.
 *
 * ---------------------------------------------------------------------------
 * HONESTIDAD SOBRE LO REPRODUCIBLE (leer antes de confiar en el % de acuerdo)
 * ---------------------------------------------------------------------------
 * src/guardrails/exit-governance.ts NO exporta una funcion PURA que reciba los
 * campos del pulso. Su unica entrada ejecutable es:
 *
 *   export async function evaluateExitGovernance(ticker, book, entryAvgPrice,
 *       currentPrice, targetTpPrice, ofiScore, spreadBps, jevRegime, alreadyPartialTakenPct)
 *
 * Es ASINCRONA e IMPURA: (a) llama a Laya por HTTP en 127.0.0.1:8088 dentro del
 * propio cuerpo (evaluateMarketStateLocal), y (b) escribe en el dataset de
 * destilacion (recordDistillationSample). Por eso NO se puede usar como oraculo de
 * replay: su resultado depende de la red local del momento y contamina el dataset.
 *
 * Campos que FALTAN en la API pura de exit-governance.ts:
 *   1. No existe kernel puro exportado de la decision (el arbol if/else de salidas).
 *   2. classifyTriggerSource() es un closure local, no exportado.
 *   3. No hay forma de inyectar el juicio de Laya ya resuelto (toxicFlow); el motor
 *      lo obtiene de la red, asi que el determinismo depende de un servicio externo.
 *   4. No se puede suprimir el efecto secundario de escritura (recordDistillationSample).
 *
 * Estrategia de este script: se hace el replay sobre la parte que SI es pura y
 * verificable, y se declara explicitamente el resto:
 *   - Umbrales y perfil de activo: se usan las funciones REALES del motor,
 *     getRegimePolicy() y getAssetProfile() de src/guardrails/regime-policy.ts.
 *     Esos son los mismos valores que el motor consume, no una copia.
 *   - Arbol de decision: se replica el kernel de exit-governance.ts tal cual, pero
 *     congelando el juicio de Laya desde la grabacion (layaToxicFlow) en lugar de
 *     llamar a la red. Eso es lo que vuelve el replay determinista.
 *   - Anti-deriva: se verifica que las condiciones clave sigan existiendo
 *     literalmente en exit-governance.ts. Si el motor cambia el kernel y este
 *     script no, se reporta "KERNEL DRIFT" y el resultado no debe considerarse valido.
 *   - Un pulso sin contexto de posicion (entryAvgPrice/currentGainPct, targetTpPrice)
 *     se marca como "NO REPRODUCIBLE AUN" y no entra en el % de acuerdo.
 *
 * Uso:
 *   bun run scripts/replay-decisions.ts --date 2026-10-18 [--dir <ruta>] [--ticker BTC] [--json]
 *
 * Codigos de salida:
 *   0 = todas las decisiones comparables coinciden (100%)
 *   1 = acuerdo < 100% (hay no-determinismo o divergencia real) o nada comparable
 *   2 = no hay grabaciones para la ventana pedida
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readRecordedWindow, type RecordedPulseInput } from "../src/guardrails/input-recorder.js";
import { getAssetProfile, getRegimePolicy } from "../src/guardrails/regime-policy.js";

const EXIT_GOVERNANCE_PATH = fileURLToPath(
  new URL("../src/guardrails/exit-governance.ts", import.meta.url)
);

type ReproducedAction =
  | "HOLD"
  | "TAKE_PROFIT_PARTIAL"
  | "TAKE_PROFIT_STANDARD"
  | "FRONT_RUN_EXIT"
  | "TRAILING_EXPANSION"
  | "EMERGENCY_DELEVERAGE"
  | null;

interface ReproResult {
  reproducible: boolean;
  action: ReproducedAction;
  branch: string;
  missing: string[];
  notes: string[];
  gainPct: number | null;
  toxicFlow: number | null;
}

interface Divergence {
  timestampIso: string;
  ticker: string;
  recorded: string;
  reproduced: string;
  branch: string;
  reason: string;
}

interface CliArgs {
  date: string | null;
  dir?: string;
  ticker?: string;
  json: boolean;
}

/**
 * Condiciones clave del kernel de exit-governance.ts. Si alguna desaparece del
 * fuente, el kernel replicado aqui quedo desincronizado.
 */
const KERNEL_ANCHORS: string[] = [
  "if (currentGainPct <= -3.00 && (toxicFlow >= 0.90 || ofiScore <= -0.85))",
  'toxicFlow > 0.65 || jevRegime === "DEFENSIVE_STRESS" || ofiScore < -0.55',
  'profile === "ANCHOR" ? -2.20 : profile === "BETA" ? -3.20 : -0.80',
  "const minGainThreshold = policy.frontRunMin > 1.0 ? policy.frontRunMin : 0.60;",
  "if (currentGainPct >= policy.frontRunMin && (ofiScore < -0.50 || toxicFlow > 0.50))",
  "else if (currentGainPct >= policy.tp1Threshold && alreadyPartialTakenPct < 0.50)",
  "else if (currentGainPct >= policy.tp2Threshold && alreadyPartialTakenPct < 0.70)",
  "else if (currentPrice >= targetTpPrice && targetTpPrice > 0)",
  "if (ofiScore > 0.50 && toxicFlow < 0.20)",
  "if (ofiScore > 0.60 && toxicFlow < 0.20 && jevRegime === 'AGGRESSIVE_ACCUMULATION')",
  "layaJudgment.ok && layaJudgment.toxicFlow !== null ? layaJudgment.toxicFlow : (ofiScore < -0.50 ? 0.85 : 0.10)",
];

const tag = "REPRODUCIBLE_AUN_NO";

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Verifica que el kernel replicado siga alineado con exit-governance.ts. */
function checkKernelDrift(): { drift: string[]; error: string | null } {
  if (!existsSync(EXIT_GOVERNANCE_PATH)) {
    return { drift: [], error: `no se encontro ${EXIT_GOVERNANCE_PATH}` };
  }
  const source = normalizeWhitespace(readFileSync(EXIT_GOVERNANCE_PATH, "utf-8"));
  const drift = KERNEL_ANCHORS.filter((anchor) => !source.includes(normalizeWhitespace(anchor)));
  return { drift, error: null };
}

/**
 * Kernel de decision replicado de evaluateExitGovernance() con el juicio de Laya
 * congelado desde la grabacion. Ver la cabecera del archivo: esto NO es una funcion
 * exportada del motor, es una replica auditada por el guard de deriva.
 */
function reproduceExitDecision(sample: RecordedPulseInput): ReproResult {
  const missing: string[] = [];
  const notes: string[] = [];

  // Ganancia: se prefiere la que el motor ya calculo; si no, se deriva de mid/entrada.
  let gainPct: number | null = null;
  if (typeof sample.currentGainPct === "number") {
    gainPct = sample.currentGainPct;
  } else if (
    typeof sample.entryAvgPrice === "number" &&
    sample.entryAvgPrice > 0 &&
    typeof sample.mid === "number"
  ) {
    gainPct = (sample.mid / sample.entryAvgPrice - 1) * 100;
    notes.push("gainPct derivado de mid/entryAvgPrice (currentGainPct no grabado)");
  } else {
    missing.push("currentGainPct (o entryAvgPrice + mid)");
  }

  // Toxicidad: si la grabacion trae el juicio de Laya, se usa tal cual (determinista).
  // Si no, se aplica el mismo fail-safe del motor ante Laya no disponible.
  let toxicFlow: number | null = null;
  if (typeof sample.layaToxicFlow === "number") {
    toxicFlow = sample.layaToxicFlow;
  } else {
    toxicFlow = sample.ofiScore < -0.5 ? 0.85 : 0.1;
    notes.push("layaToxicFlow ausente: se aplico el fail-safe OFI del motor (ofi < -0.50 ? 0.85 : 0.10)");
  }

  const partialTaken = sample.alreadyPartialTakenPct ?? 0;
  if (typeof sample.alreadyPartialTakenPct !== "number") {
    notes.push("alreadyPartialTakenPct ausente: asumido 0");
  }

  if (missing.length > 0) {
    return { reproducible: false, action: null, branch: tag, missing, notes, gainPct: null, toxicFlow };
  }

  const gain = gainPct as number;

  // Efecto 0: colapso sistemico (mismos umbrales que el motor).
  if (gain <= -3.0 && (toxicFlow >= 0.9 || sample.ofiScore <= -0.85)) {
    return { reproducible: true, action: "EMERGENCY_DELEVERAGE", branch: "ESCENARIO_0_EMERGENCY", missing, notes, gainPct: gain, toxicFlow };
  }

  // Efecto 0b: gobernanza causal en perdida (stop dinamico Laya/Jev).
  if (gain < 0) {
    const profile = getAssetProfile(sample.ticker);
    const dynamicStopLimit = profile === "ANCHOR" ? -2.2 : profile === "BETA" ? -3.2 : -0.8;
    if (gain <= dynamicStopLimit && (toxicFlow > 0.65 || sample.jevRegime === "DEFENSIVE_STRESS" || sample.ofiScore < -0.55)) {
      return { reproducible: true, action: "EMERGENCY_DELEVERAGE", branch: "ESCENARIO_0B_STOP_DINAMICO", missing, notes, gainPct: gain, toxicFlow };
    }
    return { reproducible: true, action: "HOLD", branch: "HOLD_DEFENSIVO", missing, notes, gainPct: gain, toxicFlow };
  }

  const policy = getRegimePolicy(sample.jevRegime, sample.ticker);
  const minGainThreshold = policy.frontRunMin > 1.0 ? policy.frontRunMin : 0.6;
  if (gain < minGainThreshold) {
    return { reproducible: true, action: "HOLD", branch: "BELOW_FEE_THRESHOLD", missing, notes, gainPct: gain, toxicFlow };
  }

  // Efecto 1: front-run ante flujo toxico.
  if (gain >= policy.frontRunMin && (sample.ofiScore < -0.5 || toxicFlow > 0.5)) {
    return { reproducible: true, action: "FRONT_RUN_EXIT", branch: "ESCENARIO_1_FRONT_RUN", missing, notes, gainPct: gain, toxicFlow };
  }

  // Efecto 2: TP1 parcial (DCA out 1) o trailing por euforia.
  if (gain >= policy.tp1Threshold && partialTaken < 0.5) {
    if (sample.ofiScore > 0.6 && toxicFlow < 0.2 && sample.jevRegime === "AGGRESSIVE_ACCUMULATION") {
      return { reproducible: true, action: "TRAILING_EXPANSION", branch: "ESCENARIO_2_TRAILING_EUFORIA", missing, notes, gainPct: gain, toxicFlow };
    }
    return { reproducible: true, action: "TAKE_PROFIT_PARTIAL", branch: "ESCENARIO_2_TP1_PARCIAL", missing, notes, gainPct: gain, toxicFlow };
  }

  // Efecto 3: TP2 parcial (DCA out 2).
  if (gain >= policy.tp2Threshold && partialTaken < 0.7) {
    return { reproducible: true, action: "TAKE_PROFIT_PARTIAL", branch: "ESCENARIO_3_TP2_PARCIAL", missing, notes, gainPct: gain, toxicFlow };
  }

  // Efecto 4: meta del genoma o trailing.
  const targetTp = sample.targetTpPrice;
  if (typeof targetTp === "number" && targetTp > 0 && sample.mid >= targetTp) {
    if (sample.ofiScore > 0.5 && toxicFlow < 0.2) {
      return { reproducible: true, action: "TRAILING_EXPANSION", branch: "ESCENARIO_4_TRAILING", missing, notes, gainPct: gain, toxicFlow };
    }
    return { reproducible: true, action: "TAKE_PROFIT_STANDARD", branch: "ESCENARIO_4_TP_ESTANDAR", missing, notes, gainPct: gain, toxicFlow };
  }

  if (typeof targetTp !== "number" || !(targetTp > 0)) {
    // Sin targetTpPrice no se puede excluir el cierre total; no se inventa un HOLD.
    return {
      reproducible: false,
      action: null,
      branch: "ESCENARIO_4_NO_REPRODUCIBLE",
      missing: [...missing, "targetTpPrice"],
      notes,
      gainPct: gain,
      toxicFlow,
    };
  }

  return { reproducible: true, action: "HOLD", branch: "FALLTHROUGH_HOLD", missing, notes, gainPct: gain, toxicFlow };
}

function normalizeDecision(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toUpperCase();
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { date: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--date") args.date = argv[++i] ?? null;
    else if (arg === "--dir") args.dir = argv[++i];
    else if (arg === "--ticker") args.ticker = argv[++i];
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Uso: bun run scripts/replay-decisions.ts --date <YYYY-MM-DD> [--dir <ruta>] [--ticker <T>] [--json]");
      process.exit(0);
    }
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { drift, error: driftError } = checkKernelDrift();

  if (args.date === null) {
    console.error("Falta --date <YYYY-MM-DD>. Ver --help.");
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    console.error(`Fecha invalida: "${args.date}". Formato esperado YYYY-MM-DD.`);
    process.exit(1);
  }

  const fromIso = `${args.date}T00:00:00.000Z`;
  const toIso = `${args.date}T23:59:59.999Z`;

  let window: ReturnType<typeof readRecordedWindow>;
  try {
    window = readRecordedWindow({ dir: args.dir, fromIso, toIso, ticker: args.ticker });
  } catch (err) {
    console.error(`Error leyendo la ventana grabada: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  if (window.samples.length === 0) {
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            date: args.date,
            dir: args.dir ?? null,
            ticker: args.ticker ?? null,
            status: "sin_grabaciones",
            samples: 0,
            corruptLines: window.corruptLines,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Sin grabaciones para ${args.date}${args.ticker ? ` (ticker ${args.ticker})` : ""}. Nada que reproducir.`);
    }
    process.exit(2);
  }

  const divergences: Divergence[] = [];
  const missingCounts = new Map<string, number>();
  let comparable = 0;
  let matches = 0;
  let notComparable = 0;
  let notReproducible = 0;

  for (const sample of window.samples) {
    const reproduced = reproduceExitDecision(sample);
    for (const field of reproduced.missing) {
      missingCounts.set(field, (missingCounts.get(field) ?? 0) + 1);
    }
    if (!reproduced.reproducible) {
      notReproducible += 1;
      continue;
    }

    const recorded = normalizeDecision(sample.decision);
    if (recorded === "") {
      notComparable += 1;
      continue;
    }

    comparable += 1;
    if (recorded === reproduced.action) {
      matches += 1;
      continue;
    }

    const gainTxt = reproduced.gainPct !== null ? `${reproduced.gainPct.toFixed(2)}%` : "n/d";
    divergences.push({
      timestampIso: sample.timestampIso,
      ticker: sample.ticker,
      recorded,
      reproduced: reproduced.action ?? "NULL",
      branch: reproduced.branch,
      reason:
        `kernel=${reproduced.branch} gain=${gainTxt} ofi=${sample.ofiScore} toxic=${reproduced.toxicFlow} ` +
        `regimen=${sample.jevRegime}; grabado=${recorded} reproducible=${reproduced.action}`,
    });
  }

  const agreementPct = comparable > 0 ? (matches / comparable) * 100 : 0;
  const nonReproducibleDetail = [...missingCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([field, count]) => ({ field, samples: count }));

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          date: args.date,
          dir: args.dir ?? null,
          ticker: args.ticker ?? null,
          files: window.files,
          samples: window.samples.length,
          comparable,
          matches,
          divergences: divergences.length,
          agreementPct: Number(agreementPct.toFixed(4)),
          notComparable,
          notReproducible,
          nonReproducibleDetail,
          corruptLines: window.corruptLines,
          kernelDrift: drift,
          kernelDriftError: driftError,
          divergenceDetail: divergences.slice(0, 10),
        },
        null,
        2
      )
    );
  } else {
    console.log("=".repeat(80));
    console.log("  REPLAY DETERMINISTA DE DECISIONES (gobernanza de salidas)");
    console.log("=".repeat(80));
    console.log(`Fecha UTC        : ${args.date}`);
    console.log(`Directorio       : ${args.dir ?? "(default/env REPLAY_DIR)"}`);
    console.log(`Ticker filtro    : ${args.ticker ?? "(todos)"}`);
    console.log(`Archivos leidos  : ${window.files.length}`);
    console.log(`Lineas corruptas : ${window.corruptLines}`);
    console.log("");
    console.log(`Muestras totales      : ${window.samples.length}`);
    console.log(`Decisiones comparadas : ${comparable}`);
    console.log(`Coincidencias         : ${matches}`);
    console.log(`Acuerdo               : ${agreementPct.toFixed(2)}%`);
    console.log(`Sin decision grabada  : ${notComparable}`);
    console.log(`No reproducibles aun  : ${notReproducible}`);
    console.log("");

    if (nonReproducibleDetail.length > 0) {
      console.log("Campos faltantes en la grabacion (bloquean el replay completo):");
      for (const item of nonReproducibleDetail) {
        console.log(`  - ${item.field}: ${item.samples} muestras`);
      }
      console.log("");
    }

    if (divergences.length > 0) {
      console.log(`Divergencias (mostrando hasta 10 de ${divergences.length}):`);
      for (const div of divergences.slice(0, 10)) {
        console.log(`  [${div.timestampIso}] ${div.ticker}`);
        console.log(`      grabado=${div.recorded} | replay=${div.reproduced}`);
        console.log(`      ${div.reason}`);
      }
      console.log("");
    }

    if (driftError !== null) {
      console.log(`ADVERTENCIA: ${driftError}. El guard de deriva no pudo validarse.`);
    } else if (drift.length > 0) {
      console.log("KERNEL DRIFT DETECTADO: exit-governance.ts cambio y el kernel de este replay no.");
      for (const anchor of drift) {
        console.log(`  - condicion ausente: ${anchor}`);
      }
      console.log("El resultado NO es valido hasta alinear el script con el motor.");
    } else {
      console.log("Guard de deriva: kernel alineado con exit-governance.ts.");
    }
    console.log("");
    console.log(`Limites de reproducibilidad: ${tag} los pulsos sin currentGainPct/entryAvgPrice o targetTpPrice.`);
    console.log("El kernel no es una funcion exportada del motor: exit-governance.ts no expone");
    console.log("una variante pura ni permite inyectar el juicio de Laya. Detalle en la cabecera del script.");
    console.log("=".repeat(80));
  }

  if (comparable === 0) {
    console.log("AVISO: hay grabaciones pero ninguna decision comparable. Se considera fallo de auditoria.");
    process.exit(1);
  }
  process.exit(agreementPct >= 100 ? 0 : 1);
}

if (import.meta.main) {
  main();
}

export { reproduceExitDecision, checkKernelDrift, KERNEL_ANCHORS };
