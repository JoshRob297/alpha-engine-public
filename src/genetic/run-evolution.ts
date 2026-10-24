/**
 * Runner con Walk-Forward Validation en Compute-node
 */

import { FAMILIES } from "./bot.js";
import { EvolutionEngine } from "./evolution.js";
import { makeSeries } from "./series.js";

async function fetchBinanceHourlyCandles(symbol = "BTCUSDT", limit = 1000) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error HTTP ${res.status} descargando velas`);
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

export async function runWalkForwardEvolution() {
  console.log("=== MOTOR GENETICO CON WALK-FORWARD VALIDATION (BTCUSDT) ===");
  const candles = await fetchBinanceHourlyCandles("BTCUSDT", 900);
  console.log(`Velas cargadas: ${candles.length} horas (~37 dias de historial real)`);

  const series = makeSeries(candles);
  const engine = new EvolutionEngine(series, {
    pop: 48,
    elite: 4,
    immigrants: 4,
    numWindows: 3, // 3 ventanas deslizantes out-of-sample
  });

  console.log(`Ventanas Walk-Forward configuradas: ${engine.windows.length}`);
  engine.windows.forEach((w, i) => {
    console.log(`  Ventana ${i + 1}: Train [${w.trainFrom}..${w.trainTo}] -> Val OOS [${w.valFrom}..${w.valTo}]`);
  });

  console.log("\nEvolucionando generaciones...");
  const maxGen = 12;
  for (let g = 1; g <= maxGen; g++) {
    const report = engine.step();
    if (g % 3 === 0 || g === maxGen) {
      console.log(
        `Gen ${String(report.gen).padStart(2)} | Mejor Fit: ${report.bestFit.toFixed(4)} | Lider Walk-Forward: ${report.leader ? "APROBADO" : "BUSCANDO..."}`
      );
    }
  }

  const leader = engine.leader;
  if (!leader) {
    console.log("\nAlerta: Ningun genoma supero el Walk-Forward en multiples ventanas. Riesgo de overfitting evitado.");
    return;
  }

  const g = leader.genome;
  console.log("\n=======================================================");
  console.log("       GENOMA LIDER VALIDADO VIA WALK-FORWARD         ");
  console.log("=======================================================");
  console.log(`Especie (Family):       ${FAMILIES[g.family]}`);
  console.log(`Ventana (Lookback):     ${g.lookback} horas`);
  console.log(`Umbral (Entry Z):       ${g.entryZ.toFixed(2)} sigma`);
  console.log(`Niveles Grid:           ${g.levels} ordenes`);
  console.log(`Espaciado:              ${(g.spacing * 100).toFixed(2)}%`);
  console.log(`Multiplicador:          ${g.mult.toFixed(2)}x`);
  console.log(`Take-Profit:            ${(g.tp * 100).toFixed(2)}%`);
  console.log(`Stop-Loss:              ${(g.stop * 100).toFixed(2)}%`);
  console.log("-------------------------------------------------------");
  console.log(`Rendimiento Train:      +${(leader.train.ret * 100).toFixed(2)}% | MaxDD: ${(leader.train.maxDD * 100).toFixed(2)}%`);
  console.log("Resultados en Ventanas Out-of-Sample (Walk-Forward):");
  leader.valResults.forEach((val, i) => {
    console.log(`  OOS Ventana ${i + 1}: Ret: +${(val.ret * 100).toFixed(2)}% | MaxDD: ${(val.maxDD * 100).toFixed(2)}% | WinRate: ${(val.winRate * 100).toFixed(0)}%`);
  });
  console.log("=======================================================");
  console.log("Estado: Sizing limitado a 20% max (Half-Kelly) + Circuit Breakers integrados.");
}

if (import.meta.main) {
  runWalkForwardEvolution();
}
