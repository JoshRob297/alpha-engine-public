/**
 * Runner de Economía DEX — Compara estrategias de liquidez concentrada.
 *
 * Uso: bun run src/research/run-dex-economics.ts [--symbol ETHUSDT] [--hours 8760] [--fee-apr 68.9] [--width 0.065]
 */

import { BinanceHistoricalFeeder } from "../cex/binance-history.js";
import { simulateDex, simulateHold, DEFAULT_DEX_CONFIG, type DexSeries } from "./dex-economics-sim.js";
import { writeFileSync } from "node:fs";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const SYMBOL = arg("symbol", "ETHUSDT");
const HOURS = parseInt(arg("hours", "8760"), 10);
const FEE_APR = parseFloat(arg("fee-apr", "68.9"));
const WIDTH = parseFloat(arg("width", "0.065"));

async function main() {
  console.log("=".repeat(84));
  console.log(`  SIMULADOR DE ECONOMÍA DEX (Liquidez Concentrada v3)  |  ${SYMBOL}  |  ${HOURS}h`);
  console.log("=".repeat(84));

  const series = await BinanceHistoricalFeeder.fetchHistoricalSeries(SYMBOL, HOURS, 2000);
  if (!series) {
    console.error("Fallo la descarga de datos.");
    return;
  }
  const dex: DexSeries = { close: Array.from(series.close), n: series.close.length };
  console.log(`[DATA] ${dex.n} velas horarias | rango ±${(WIDTH * 100).toFixed(1)}% | fee APR base ${FEE_APR}%`);
  console.log(`[COSTOS] Gas por acción: $${DEFAULT_DEX_CONFIG.gasPerActionUsd} USD | cooldown ${DEFAULT_DEX_CONFIG.rebalanceCooldownBars}h\n`);

  const cfg = { ...DEFAULT_DEX_CONFIG, rangeHalfWidthPct: WIDTH };

  const results = [
    simulateDex("LP Pasiva (rebalanceo al salir)", dex, "none", FEE_APR, cfg),
    simulateDex("LP + Señal Volatilidad", dex, "vol", FEE_APR, cfg),
    simulateDex("LP + Señal Tendencia", dex, "trend", FEE_APR, cfg),
    simulateHold(dex),
  ];

  console.log(`  Estrategia                       | Ret%   | Fees   | IL*    | Gas   | Rebal | Pausas | InRange%`);
  console.log("-".repeat(84));
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(32)} | ${String(r.retPct).padStart(6)} | ${String(r.feesUsd).padStart(6)} | ${String(r.ilUsd).padStart(6)} | ${String(r.gasUsd).padStart(5)} | ${String(r.rebalances).padStart(5)} | ${String(r.pauses).padStart(6)} | ${String(r.inRangePct).padStart(7)}`
    );
  }
  console.log("  * IL = drag acumulado de rebalanceo (divergencia vs composición de entrada de cada tramo).");

  const passive = results[0];
  const bestSignal = results.slice(1, 3).reduce((a, b) => (b.retPct > a.retPct ? b : a), results[1]);
  const hold = results[3];

  console.log("\n[VEREDICTO]");
  console.log(`  ¿La señal bate a la LP pasiva? ${bestSignal.retPct > passive.retPct ? "SÍ" : "NO"} (${bestSignal.retPct}% vs ${passive.retPct}%)`);
  console.log(`  ¿La mejor LP bate a Hold?      ${Math.max(passive.retPct, bestSignal.retPct) > hold.retPct ? "SÍ" : "NO"} (mejor=${Math.max(passive.retPct, bestSignal.retPct)}% vs Hold=${hold.retPct}%)`);

  try {
    writeFileSync("data/dex_economics_report.json", JSON.stringify({ symbol: SYMBOL, hours: dex.n, width: WIDTH, feeApr: FEE_APR, results }, null, 2));
    console.log("\n[REPORT] data/dex_economics_report.json");
  } catch {}
}

main().catch((e) => console.error("[DEX SIM ERROR]", e));
