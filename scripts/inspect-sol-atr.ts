import { readFileSync } from "node:fs";

const solCandlesAll = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/raw/sol_1h.json", "utf-8"));
const solMonth = solCandlesAll.slice(solCandlesAll.length - 720);

for (let h = 0; h < 10; h++) {
  const c = solMonth[h];
  const tr = (c.high - c.low) / c.close;
  console.log(`[SOL H=${h}] Close: $${c.close.toFixed(2)} | Range: ${(tr * 100).toFixed(2)}%`);
}
