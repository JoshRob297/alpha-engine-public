#!/usr/bin/env bun
/**
 * Analisis de ESCALABILIDAD POR TAMANO DE CUENTA (Alpha Engine).
 *
 * Pregunta que responde: a que tamano de cuenta la ventaja observada (si existe)
 * muere por impacto de mercado y fees.
 *
 * Metodo:
 *  - Toma la expectativa y el payoff OBSERVADOS del ledger (`history`).
 *  - Escala el nocional proporcionalmente al capital (deploymentRatio).
 *  - Suma costo de fees maker/taker por tamano y el impacto modelado
 *    `impactUsd = impactK * notional^2 / depth`.
 *  - Reporta la curva de expectancy por capital y el `breakevenCapitalUsd`
 *    (capital donde la expectancy por trade cruza 0).
 *
 * Uso:
 *   bun run scripts/capital-scaling-analysis.ts --state <ruta> [--capital 200,2000,20000,100000] [--depth <usdPorActivo>]
 *
 * `--depth` acepta:
 *   - un numero (misma profundidad para cada activo operado), o
 *   - una lista `ACTIVO:USD,ACTIVO:USD`.
 * Si no se pasa, se intenta usar profundidad/tvl REAL grabada en el estado
 * (campos `depthUsd`, `liquidityUsd`, `liquidity`, `tvlUsd` de cada slot DEX).
 * Si tampoco hay, se usan supuestos documentados por perfil (ANCHOR/BETA).
 */

import { existsSync, readFileSync } from "node:fs";
import { scalingCurve, type LedgerTradeLike } from "../src/research/pnl-reconstruction.js";

// ---------------------------------------------------------------- supuestos
const IMPACT_K = 1.0;
const MAKER_FEE_BPS = 10; // 0.100% (coincide con BINANCE_MAKER_FEE = 0.0010 del motor)
const TAKER_FEE_BPS = 10; // 0.100% (DEFAULT_TAKER_FEE_BPS del motor)
const DEPLOYMENT_RATIO = 1.0; // nocional por trade = capital (despliegue total)
const TAKER_SHARE_DEFAULT = 0.5; // si el ledger no trae campo `liquidity`

// Profundidades asumidas cuando el estado NO graba profundidad real (USD).
// ANCHOR: majors liquidos (BTC/ETH/USDC y equivalentes) en un venue CEX de primer nivel.
// BETA: pools/altcoins de menor profundidad de libro.
const ANCHOR_DEPTH_USD = 5_000_000;
const BETA_DEPTH_USD = 250_000;

const ANCHOR_HINTS = ["BTC", "ETH", "WETH", "USDC", "USDT", "CBBTC", "WSOL", "SOL"];
const PROFILE_BY_ASSET = (asset: string): "ANCHOR" | "BETA" =>
  ANCHOR_HINTS.some((h) => asset.toUpperCase().includes(h)) ? "ANCHOR" : "BETA";

const get = (flag: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

function fail(msg: string): never {
  console.error(`[SCALING] ${msg}`);
  process.exit(1);
}

const statePath = get("--state");
if (!statePath) {
  fail("Falta --state <ruta>. Uso: bun run scripts/capital-scaling-analysis.ts --state <ruta> [--capital 200,2000] [--depth <usdPorActivo>]");
}
if (!existsSync(statePath!)) fail(`No existe el archivo de estado: ${statePath}`);

let state: any;
try {
  state = JSON.parse(readFileSync(statePath!, "utf-8"));
} catch (err: any) {
  fail(`Estado ilegible (JSON invalido): ${err?.message ?? err}`);
}

const capitalArg = get("--capital", "200,2000,20000,100000")!;
const capitals = capitalArg
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
if (capitals.length === 0) fail(`--capital invalido: "${capitalArg}"`);

const history: LedgerTradeLike[] = Array.isArray(state?.history) ? state.history : [];
const dexPositions: Record<string, any> =
  state?.dexPositions && typeof state.dexPositions === "object" && !Array.isArray(state.dexPositions)
    ? state.dexPositions
    : {};

// ------------------------------------------------------- resolucion de profundidad
const depthArg = get("--depth");
const cexAssets = Array.from(
  new Set(history.filter((t) => String(t?.venue || "").toUpperCase() !== "BASE_DEX" && t?.assetOrPool).map((t) => String(t.assetOrPool)))
);
const depthByAssetUsd: Record<string, number> = {};
let depthSource = "";

if (depthArg) {
  const kv = depthArg.split(",").map((s) => s.trim()).filter(Boolean);
  const parsedKv = kv.filter((s) => s.includes(":"));
  if (parsedKv.length > 0) {
    for (const pair of parsedKv) {
      const [k, v] = pair.split(":");
      const val = Number(v);
      if (k && Number.isFinite(val) && val > 0) depthByAssetUsd[k.trim()] = val;
    }
    depthSource = `--depth explicito por activo (${parsedKv.length} entradas)`;
  } else {
    const val = Number(kv[0]);
    if (!Number.isFinite(val) || val <= 0) fail(`--depth invalido: "${depthArg}"`);
    const assets = cexAssets.length > 0 ? cexAssets : ["GLOBAL"];
    for (const a of assets) depthByAssetUsd[a] = val;
    depthSource = `--depth explicito ($${val} USD por activo)`;
  }
} else {
  // 1) profundidad real grabada en el estado.
  let foundReal = false;
  for (const [slot, p] of Object.entries(dexPositions)) {
    const real = [p?.depthUsd, p?.liquidityUsd, p?.liquidity, p?.tvlUsd].find(
      (v) => typeof v === "number" && Number.isFinite(v) && v > 0
    );
    if (typeof real === "number") {
      depthByAssetUsd[slot] = real as number;
      foundReal = true;
    }
  }
  if (foundReal) {
    depthSource = "profundidad REAL grabada en el estado (campos depthUsd/liquidityUsd/liquidity/tvlUsd de dexPositions)";
  } else {
    // 2) supuestos documentados por perfil ANCHOR/BETA.
    const assets = cexAssets.length > 0 ? cexAssets : Object.keys(dexPositions);
    if (assets.length === 0) assets.push("GLOBAL");
    for (const a of assets) {
      depthByAssetUsd[a] = PROFILE_BY_ASSET(a) === "ANCHOR" ? ANCHOR_DEPTH_USD : BETA_DEPTH_USD;
    }
    depthSource = `SUPUESTO documentado por perfil: ANCHOR=$${ANCHOR_DEPTH_USD} / BETA=$${BETA_DEPTH_USD} (el estado no graba profundidad real)`;
  }
}
const depthTotal = Object.values(depthByAssetUsd).reduce((a, v) => a + v, 0);

// ---------------------------------------------------------------- payoff observado
const cexTrades = history.filter(
  (t) => String(t?.venue || "").toUpperCase() !== "BASE_DEX" && Number(t?.price) > 0 && Number(t?.amount) > 0
);
const wins = cexTrades.filter((t) => Number(t?.pnlNet) > 0);
const losses = cexTrades.filter((t) => Number(t?.pnlNet) < 0);
const sumNotional = cexTrades.reduce((a, t) => a + Number(t.price) * Number(t.amount), 0);
const sumGross = cexTrades.reduce((a, t) => a + Number(t.pnlNet || 0), 0);
const sumFees = cexTrades.reduce((a, t) => a + (typeof t.feePaidUsd === "number" ? t.feePaidUsd : 0), 0);
const sumSlip = cexTrades.reduce((a, t) => a + (typeof t.slippageUsd === "number" ? t.slippageUsd : 0), 0);
const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + Number(t.pnlNet), 0) / wins.length : 0;
const avgLoss = losses.length > 0 ? losses.reduce((a, t) => a + Number(t.pnlNet), 0) / losses.length : 0;
const decisive = wins.length + losses.length;

console.log("=== ANALISIS DE ESCALABILIDAD POR TAMANO DE CUENTA ===");
console.log(`Estado: ${statePath}`);
console.log("--- SUPUESTOS (todos explicitos) ---");
console.log(`Ley de impacto: impactUsd = impactK * notional^2 / depth ; impactK = ${IMPACT_K}`);
console.log(`Fees: maker ${MAKER_FEE_BPS} bps / taker ${TAKER_FEE_BPS} bps sobre el nocional.`);
console.log(`Nocional por trade = capital * deploymentRatio ; deploymentRatio = ${DEPLOYMENT_RATIO}`);
console.log(`Taker share: ${cexTrades.some((t) => t.liquidity) ? "observado en el ledger (campo liquidity)" : `default ${TAKER_SHARE_DEFAULT} (el ledger no trae liquidity)`}`);
console.log(`Profundidad: ${depthSource}`);
console.log(`  depthByAsset = ${JSON.stringify(depthByAssetUsd)} | depthTotal = $${depthTotal.toFixed(0)}`);
console.log(`Nota: la profundidad agregada se aplica a un unico trade de nocional = capital (aproximacion conservadora).`);

console.log("\n--- PAYOFF OBSERVADO (CEX) ---");
console.log(`Trades elegibles: ${cexTrades.length} | Nocional acumulado: $${sumNotional.toFixed(2)} | Bruto acumulado: $${sumGross.toFixed(4)}`);
console.log(`Fees: $${sumFees.toFixed(4)} | Slippage: $${sumSlip.toFixed(4)} | Neto: $${(sumGross - sumFees - sumSlip).toFixed(4)}`);
console.log(`Win rate (decisivos): ${decisive > 0 ? ((wins.length / decisive) * 100).toFixed(1) : "n/d"}% | Avg win: $${avgWin.toFixed(4)} | Avg loss: $${avgLoss.toFixed(4)}`);
if (cexTrades.length === 0) {
  console.log("ADVERTENCIA: sin trades CEX observados. La expectativa bruta por nocional = 0 -> curva degenerada (breakeven 0).");
  console.log("El analisis es reproducible, pero no hay ventaja observada que escalar todavia.");
}

console.log("\n--- CURVA DE ESCALADO ---");
console.log("capitalUsd      nocionalUsd     brutoUsd     feeUsd      impactUsd     expectUsd    expectPct   breakevenUsd");
const points = capitals.map((c) => scalingCurve(history, c, depthByAssetUsd, {
  impactK: IMPACT_K,
  makerFeeBps: MAKER_FEE_BPS,
  takerFeeBps: TAKER_FEE_BPS,
  deploymentRatio: DEPLOYMENT_RATIO,
  takerShareDefault: TAKER_SHARE_DEFAULT,
}));
const fmt = (v: number) =>
  !Number.isFinite(v) ? "Infinity" : v.toFixed(4).padStart(12);
for (const p of points) {
  console.log(
    `${p.capitalUsd.toFixed(0).padStart(10)}  ${fmt(p.notionalUsd)}  ${fmt(p.grossEdgeUsd)}  ${fmt(p.feeUsd)}  ${fmt(p.impactUsd)}  ${fmt(p.expectancyUsd)}  ${fmt(p.expectancyPct)}  ${fmt(p.breakevenCapitalUsd)}`
  );
}

const be = points[0]?.breakevenCapitalUsd ?? 0;
const bePoint = scalingCurve(history, Number.isFinite(be) ? be : capitals[capitals.length - 1], depthByAssetUsd, {
  impactK: IMPACT_K,
  makerFeeBps: MAKER_FEE_BPS,
  takerFeeBps: TAKER_FEE_BPS,
  deploymentRatio: DEPLOYMENT_RATIO,
  takerShareDefault: TAKER_SHARE_DEFAULT,
});

console.log("\n--- VEREDICTO ---");
console.log(`grossEdgePerNotional observado = ${points[0]?.grossEdgePerNotional ?? 0} (bruto por unidad de nocional, libre de impacto)`);
if (!Number.isFinite(be)) {
  console.log("breakevenCapitalUsd = Infinito: con la profundidad y el taker share dados no hay impacto modelado que cruce la expectativa a 0.");
} else if (be <= 0) {
  console.log("breakevenCapitalUsd = 0: la expectativa ya es negativa antes de impacto (fees >= edge bruto). Ninguna cuenta es rentable con estos supuestos.");
} else {
  console.log(`breakevenCapitalUsd = $${be.toFixed(0)}: por debajo de ese capital la expectancy por trade es positiva; por encima, el impacto + fees la llevan a 0 y luego a negativo.`);
  console.log(`  Verificacion en el breakeven: expectancy $${bePoint.expectancyUsd.toFixed(6)} (${bePoint.expectancyPct.toFixed(4)}%) sobre capital $${bePoint.capitalUsd.toFixed(0)}.`);
}
