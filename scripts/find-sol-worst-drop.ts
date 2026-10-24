/**
 * COMPARACIÓN FORENSE EN LOS PEORES DÍAS DE SHOCK EN SOLANA (120 HORAS DE VOLATILIDAD EXTREMA)
 * Buscando la ventana exacta donde el candado rígido de 16h choca contra el híbrido de Laya
 */

import { readFileSync } from "node:fs";

const solCandlesAll = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/raw/sol_1h.json", "utf-8"));

// Buscar la peor caída histórica de 120h en todo el dataset de SOL
let worstDropPct = 0;
let worstIndex = 0;

for (let i = 0; i <= solCandlesAll.length - 120; i += 24) {
  const slice = solCandlesAll.slice(i, i + 120);
  const minP = Math.min(...slice.map((c: any) => c.low));
  const startP = slice[0].open;
  const drop = ((minP - startP) / startP) * 100;
  if (drop < worstDropPct) {
    worstDropPct = drop;
    worstIndex = i;
  }
}

const worstWindow = solCandlesAll.slice(worstIndex, worstIndex + 120);
console.log(`Ventana de Peor Shock en SOL: Caída de ${worstDropPct.toFixed(2)}% (De $${worstWindow[0].open.toFixed(2)} a $${Math.min(...worstWindow.map((c: any) => c.low)).toFixed(2)})`);

function testWindow(mode: "RIGID_16H" | "HYBRID_LAYA") {
  let cash = 1000;
  let inPos = false;
  let holdings = 0;
  let entry = 0;
  let entryH = 0;
  let wins = 0;
  let losses = 0;
  let isLocked = false;
  let lockH = -1;

  const spacing = 0.024;
  let gridPrice = worstWindow[0].open * (1 - spacing);

  for (let h = 0; h < 120; h++) {
    const c = worstWindow[h];
    const mid = (c.open + c.close) / 2;
    const ofi = (c.close - c.open) / (c.high - c.low + 0.0001);
    const toxic = c.close < c.open && c.volume > 50000 ? 0.75 : 0.20;

    if (isLocked) {
      if (mode === "RIGID_16H") {
        if (h - lockH >= 16) {
          isLocked = false;
          gridPrice = mid * (1 - spacing);
        }
      } else {
        if (h - lockH >= 6 && ofi > 0.20 && toxic < 0.35) {
          isLocked = false;
          gridPrice = mid * (1 - spacing * 1.25);
        }
      }
    }

    if (!inPos && !isLocked && c.low <= gridPrice) {
      inPos = true;
      holdings = 250 / gridPrice;
      entry = gridPrice;
      entryH = h;
      cash -= 250 * 1.001;
    } else if (inPos && h > entryH) {
      const stop = entry * 0.96;
      const tp = entry * 1.02;
      if (c.low <= stop) {
        cash += holdings * stop * 0.999;
        losses++;
        inPos = false;
        isLocked = true;
        lockH = h;
      } else if (c.high >= tp) {
        cash += holdings * tp * 0.999;
        wins++;
        inPos = false;
        gridPrice = mid * (1 - spacing);
      }
    }
  }

  if (inPos) cash += holdings * worstWindow[119].close * 0.999;
  return { pnl: parseFloat((cash - 1000).toFixed(2)), wins, losses };
}

console.log("Resultados en Choque Extremo de SOL:");
console.log("• Reloj Rígido 16h :", testWindow("RIGID_16H"));
console.log("• Híbrido Laya     :", testWindow("HYBRID_LAYA"));
