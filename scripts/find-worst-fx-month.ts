import { readFileSync } from "node:fs";

const allCandles = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json", "utf-8"));
console.log("Total velas:", allCandles.length);

// Buscar ventanas de 720 horas (30 días) para encontrar el mes con peor shock o mayor caída
const months: any[] = [];
for (let i = 0; i <= allCandles.length - 720; i += 24) {
  const slice = allCandles.slice(i, i + 720);
  const minP = Math.min(...slice.map((c: any) => c.low));
  const maxP = Math.max(...slice.map((c: any) => c.high));
  const rangePct = ((maxP - minP) / minP) * 100;
  const startP = slice[0].open;
  const endP = slice[719].close;
  const dropPct = ((endP - startP) / startP) * 100;

  months.push({
    startIndex: i,
    startDate: new Date(slice[0].timestamp).toISOString().slice(0, 10),
    endDate: new Date(slice[719].timestamp).toISOString().slice(0, 10),
    startPrice: startP,
    endPrice: endP,
    minPrice: minP,
    maxPrice: maxP,
    volatilityRangePct: parseFloat(rangePct.toFixed(2)),
    monthChangePct: parseFloat(dropPct.toFixed(2)),
  });
}

// Ordenar por mayor rango de volatilidad
months.sort((a, b) => b.volatilityRangePct - a.volatilityRangePct);
console.log("Top 3 Meses con Mayor Volatilidad/Shock en Bitso USD/MXN:");
console.log(JSON.stringify(months.slice(0, 3), null, 2));
