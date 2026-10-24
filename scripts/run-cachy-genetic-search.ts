import { readFileSync, writeFileSync } from "node:fs";
import { runGeneticSearch } from "./optimize-atr-genetics.js";

const SOL_FILE = "/home/user/alpha-backtest/raw/sol_1h.json";
const BTC_FILE = "/home/user/alpha-backtest/raw/btc_1h.json";
const FX_FILE = "/home/user/alpha-backtest/raw/usd_mxn_1h.json";

console.log("================================================================================");
console.log("   EVOLUCIÓN GENÉTICA DE HIPERPARÁMETROS FÍSICOS DE ATR EN CACHY (22 HILOS)     ");
console.log("================================================================================\n");

console.log("1. Optimizando Genoma para Solana (SOL/USD - 4,705 Horas)...");
const solAll = JSON.parse(readFileSync(SOL_FILE, "utf-8"));
const bestSol = runGeneticSearch(solAll, 50, 30);
console.log(`• Genoma Élite SOL: Spacing=${bestSol.k_spacing}x | TP=${bestSol.k_tp}x | Stop=${bestSol.k_stop}x | Desc=${bestSol.k_discount}x`);
console.log(`  PnL: +$${bestSol.netPnl} USD | WinRate: ${bestSol.winRate}% | Profit Factor: ${bestSol.profitFactor} | Trades: ${bestSol.trades}\n`);

console.log("2. Optimizando Genoma para Bitcoin (BTC/USD - 4,705 Horas)...");
const btcAll = JSON.parse(readFileSync(BTC_FILE, "utf-8"));
const bestBtc = runGeneticSearch(btcAll, 50, 30);
console.log(`• Genoma Élite BTC: Spacing=${bestBtc.k_spacing}x | TP=${bestBtc.k_tp}x | Stop=${bestBtc.k_stop}x | Desc=${bestBtc.k_discount}x`);
console.log(`  PnL: +$${bestBtc.netPnl} USD | WinRate: ${bestBtc.winRate}% | Profit Factor: ${bestBtc.profitFactor} | Trades: ${bestBtc.trades}\n`);

console.log("3. Optimizando Genoma para FX (usd_mxn en Bitso - 4,705 Horas)...");
const fxAll = JSON.parse(readFileSync(FX_FILE, "utf-8"));
const bestFx = runGeneticSearch(fxAll, 50, 30);
console.log(`• Genoma Élite FX: Spacing=${bestFx.k_spacing}x | TP=${bestFx.k_tp}x | Stop=${bestFx.k_stop}x | Desc=${bestFx.k_discount}x`);
console.log(`  PnL: +$${bestFx.netPnl} USD | WinRate: ${bestFx.winRate}% | Profit Factor: ${bestFx.profitFactor} | Trades: ${bestFx.trades}\n`);

const eliteGenomes = { bestSol, bestBtc, bestFx, evolvedAt: new Date().toISOString() };
writeFileSync("/home/user/proyectos/alpha-engine/data/evolved_atr_genomes.json", JSON.stringify(eliteGenomes, null, 2));
console.log("Genomas élite guardados en /home/user/proyectos/alpha-engine/data/evolved_atr_genomes.json");
