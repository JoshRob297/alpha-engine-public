/**
 * Benchmark y Runner del Motor Genetico Paralelo en Compute-node (22 hilos)
 * Carga 1,200 velas horarias (~50 dias) y evoluciona 128 genomas en paralelo
 */

import { FAMILIES } from "./bot.js";
import { ParallelEvolutionEngine } from "./parallel-evolution.js";
import { makeSeries } from "./series.js";

async function fetchBinanceHourlyCandles(limit = 1200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=${limit}`;
  const res = await fetch(url);
  const raw = await res.json();
  return raw.map((c: any) => [
    c[0],
    parseFloat(c[1]),
    parseFloat(c[2]),
    parseFloat(c[3]),
    parseFloat(c[4]),
    parseFloat(c[5]),
  ]) as Array<[number, number, number, number, number, number]>;
}

export async function runParallelBenchmark() {
  console.log("=== INICIANDO BENCHMARK MOTOR GENETICO PARALELO (22 HILOS) ===");
  const candles = await fetchBinanceHourlyCandles(1000);
  console.log(`Velas cargadas: ${candles.length} horas (~41 dias de historial real)`);

  const series = makeSeries(candles);
  const engine = new ParallelEvolutionEngine(candles, series, {
    pop: 128, // Poblacion duplicada para mayor diversidad genetica
    elite: 8,
    immigrants: 8,
    numWindows: 3,
    threads: 22,
  });

  const start = performance.now();
  console.log("Inicializando poblacion de 128 genomas en paralelo...");
  await engine.initPopulation();
  const initTime = ((performance.now() - start) / 1000).toFixed(2);
  console.log(`Poblacion inicial evaluada en ${initTime}s`);

  console.log("\nEvolucionando 10 generaciones con Sortino Ratio...");
  for (let g = 1; g <= 10; g++) {
    const genStart = performance.now();
    const rep = await engine.step();
    const genTime = (performance.now() - genStart).toFixed(0);
    console.log(
      `Gen ${String(rep.gen).padStart(2)} | Fit Sortino: ${rep.bestFit.toFixed(4)} | Tiempo: ${genTime}ms | Lider Walk-Forward: ${rep.leader ? "APROBADO" : "BUSCANDO..."}`
    );
  }

  const totalTime = ((performance.now() - start) / 1000).toFixed(2);
  console.log(`\nOptimizacion genetica completa terminada en ${totalTime}s`);

  if (engine.leader) {
    const g = engine.leader.genome;
    console.log("\n=======================================================");
    console.log("       GENOMA LIDER PARALELO (SORTINO RATIO)          ");
    console.log("=======================================================");
    console.log(`Especie:         ${FAMILIES[g.family]}`);
    console.log(`Lookback:        ${g.lookback} horas`);
    console.log(`Entry Z:         ${g.entryZ.toFixed(2)} sigma`);
    console.log(`Niveles Grid:    ${g.levels} ordenes`);
    console.log(`Espaciado:       ${(g.spacing * 100).toFixed(2)}%`);
    console.log(`Multiplicador:   ${g.mult.toFixed(2)}x`);
    console.log(`Take-Profit:     ${(g.tp * 100).toFixed(2)}%`);
    console.log(`Stop-Loss:       ${(g.stop * 100).toFixed(2)}%`);
    console.log("-------------------------------------------------------");
    console.log(`Rendimiento Train: +${(engine.leader.train.ret * 100).toFixed(2)}% | MaxDD: ${(engine.leader.train.maxDD * 100).toFixed(2)}%`);
    console.log("=======================================================");
  }
}

if (import.meta.main) {
  runParallelBenchmark();
}
