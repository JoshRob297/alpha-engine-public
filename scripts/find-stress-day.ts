import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json", "utf-8"));
console.log("Total velas:", data.length);
console.log("Primera vela:", new Date(data[0].timestamp).toISOString(), "Precio:", data[0].close);
console.log("Ultima vela:", new Date(data[data.length - 1].timestamp).toISOString(), "Precio:", data[data.length - 1].close);

// Buscar los 5 dias con mayor volatilidad/shock de 24 horas continuas
const shocks: any[] = [];
for (let i = 0; i < data.length - 24; i += 6) {
  const daySlice = data.slice(i, i + 24);
  const minP = Math.min(...daySlice.map((c: any) => c.low));
  const maxP = Math.max(...daySlice.map((c: any) => c.high));
  const changePct = ((maxP - minP) / minP) * 100;
  shocks.push({
    index: i,
    startDate: new Date(daySlice[0].timestamp).toISOString(),
    minPrice: minP,
    maxPrice: maxP,
    changePct: parseFloat(changePct.toFixed(2)),
    startPrice: daySlice[0].open,
    endPrice: daySlice[23].close,
  });
}

shocks.sort((a, b) => b.changePct - a.changePct);
console.log("\nTop 5 Dias de Mayor Shock en USD/MXN:");
console.log(JSON.stringify(shocks.slice(0, 5), null, 2));
