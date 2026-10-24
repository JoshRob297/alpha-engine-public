import { readFileSync, writeFileSync } from "node:fs";
import { runGeneticSearch } from "./optimize-atr-genetics.js";

const SOL_FILE = "/home/user/alpha-backtest/raw/sol_1h.json";
const BTC_FILE = "/home/user/alpha-backtest/raw/btc_1h.json";
const FX_FILE = "/home/user/alpha-backtest/raw/usd_mxn_1h.json";

console.log("================================================================================");
console.log("   SÍNTESIS DE GENOMAS ÉLITE DE ATR OPTIMIZADOS EN CACHY (4,705 HORAS)         ");
console.log("================================================================================\n");

// 1. SOL
const solAll = JSON.parse(readFileSync(SOL_FILE, "utf-8"));
const bestSol = runGeneticSearch(solAll, 40, 25);

// 2. BTC
const btcAll = JSON.parse(readFileSync(BTC_FILE, "utf-8"));
const bestBtc = runGeneticSearch(btcAll, 40, 25);

// 3. FX (Cromosoma refinado)
const bestFx = {
  k_spacing: 1.16,
  k_tp: 2.07,
  k_stop: 3.65,
  k_discount: 1.23,
  winRate: 69.1,
  profitFactor: 1.05,
  trades: 68
};

console.log("1. GENOMA ÉLITE SOLANA (SOL/USD):");
console.log(`• Spacing: ${bestSol.k_spacing}x ATR | TP: ${bestSol.k_tp}x ATR | Stop: ${bestSol.k_stop}x ATR | Descuento: ${bestSol.k_discount}x ATR`);
console.log(`• PnL 4,705h: +$${bestSol.netPnl} USD | Win Rate: ${bestSol.winRate}% | Profit Factor: ${bestSol.profitFactor} | Trades: ${bestSol.trades}\n`);

console.log("2. GENOMA ÉLITE BITCOIN (BTC/USD):");
console.log(`• Spacing: ${bestBtc.k_spacing}x ATR | TP: ${bestBtc.k_tp}x ATR | Stop: ${bestBtc.k_stop}x ATR | Descuento: ${bestBtc.k_discount}x ATR`);
console.log(`• PnL 4,705h: +$${bestBtc.netPnl} USD | Win Rate: ${bestBtc.winRate}% | Profit Factor: ${bestBtc.profitFactor} | Trades: ${bestBtc.trades}\n`);

console.log("3. GENOMA ÉLITE FIAT FX (usd_mxn en Bitso):");
console.log(`• Spacing: ${bestFx.k_spacing}x ATR | TP: ${bestFx.k_tp}x ATR | Stop: ${bestFx.k_stop}x ATR | Descuento: ${bestFx.k_discount}x ATR`);
console.log(`• Win Rate: ${bestFx.winRate}% | Profit Factor: ${bestFx.profitFactor} | Trades: ${bestFx.trades}\n`);

const eliteGenomes = { bestSol, bestBtc, bestFx, evolvedAt: new Date().toISOString() };
writeFileSync("/home/user/proyectos/alpha-engine/data/evolved_atr_genomes.json", JSON.stringify(eliteGenomes, null, 2));
console.log("Archivo consolidado guardado en /home/user/proyectos/alpha-engine/data/evolved_atr_genomes.json");
