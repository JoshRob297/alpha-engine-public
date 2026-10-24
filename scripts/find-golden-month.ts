/**
 * BÚSQUEDA DEL "MES DORADO" (VENTANA DE 720 HORAS DE MAYOR EXPANSIÓN Y VOLUMEN)
 * Busca la mejor ventana de 30 días continuos en los datasets para contrastar.
 */

import { readFileSync } from "node:fs";

const solAll = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/raw/sol_1h.json", "utf-8"));
const btcAll = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/raw/btc_1h.json", "utf-8"));
const fxAll = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json", "utf-8"));

console.log("Buscando ventanas doradas de 720 horas continuas...");

function findGoldenWindow(candles: any[], name: string) {
  let maxGainPct = -999;
  let bestIdx = 0;

  for (let i = 0; i <= candles.length - 720; i += 24) {
    const startP = candles[i].open;
    const endP = candles[i + 719].close;
    const gain = ((endP - startP) / startP) * 100;
    if (gain > maxGainPct) {
      maxGainPct = gain;
      bestIdx = i;
    }
  }

  const slice = candles.slice(bestIdx, bestIdx + 720);
  console.log(`• Mejor Mes en ${name}: Índice ${bestIdx} | Ganancia: +${maxGainPct.toFixed(2)}% (De $${slice[0].open.toFixed(2)} a $${slice[719].close.toFixed(2)})`);
  return { bestIdx, maxGainPct };
}

findGoldenWindow(solAll, "SOL");
findGoldenWindow(btcAll, "BTC");
findGoldenWindow(fxAll, "FX (usd_mxn)");
