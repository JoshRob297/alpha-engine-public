/**
 * BENCHMARK PARALELO MAESTRO-ALUMNO: JEV CLOUD VS LAYA SYSTEM 1 (CORRIENDO EN CACHY)
 */

import { readFileSync, writeFileSync } from "node:fs";

// Cargar dataset histórico
const solAll = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/raw/sol_1h.json", "utf-8"));
const btcAll = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/raw/btc_1h.json", "utf-8"));

// 25 velas históricas de hace 1 año
const btcSamples = btcAll.slice(0, 25);
const solSamples = solAll.slice(0, 25);

interface BenchmarkItem {
  id: string;
  ticker: string;
  spreadBps: number;
  ofiScore: number;
  depthRatio: number;
  isEvap: boolean;
}

const testItems: BenchmarkItem[] = [];

// A. Bitcoin hace 1 año
btcSamples.forEach((c: any, i: number) => {
  const spread = parseFloat((((c.high - c.low) / c.close) * 100).toFixed(2));
  const ofi = parseFloat(((c.close - c.open) / (c.high - c.low + 0.001)).toFixed(3));
  testItems.push({
    id: `BTC_1Y_${i}`,
    ticker: "BTC",
    spreadBps: spread,
    ofiScore: ofi,
    depthRatio: 1.0,
    isEvap: c.close < c.open && spread > 15,
  });
});

// B. Solana hace 1 año
solSamples.forEach((c: any, i: number) => {
  const spread = parseFloat((((c.high - c.low) / c.close) * 100).toFixed(2));
  const ofi = parseFloat(((c.close - c.open) / (c.high - c.low + 0.001)).toFixed(3));
  testItems.push({
    id: `SOL_1Y_${i}`,
    ticker: "SOL",
    spreadBps: spread,
    ofiScore: ofi,
    depthRatio: 1.0,
    isEvap: c.close < c.open && spread > 20,
  });
});

// C. Cross-Asset: Ethereum (Activo No Entrenado)
const ethScenarios = [
  { id: "ETH_CALMA", ticker: "ETH", spreadBps: 2.5, ofiScore: 0.10, depthRatio: 1.1, isEvap: false },
  { id: "ETH_FLASH_CRASH", ticker: "ETH", spreadBps: 35.0, ofiScore: -0.85, depthRatio: 0.15, isEvap: true },
  { id: "ETH_MOMENTUM_UP", ticker: "ETH", spreadBps: 4.0, ofiScore: 0.75, depthRatio: 2.2, isEvap: false },
  { id: "ETH_BLEEDING_DOWN", ticker: "ETH", spreadBps: 18.0, ofiScore: -0.45, depthRatio: 0.5, isEvap: false },
  { id: "ETH_SIDEWAYS", ticker: "ETH", spreadBps: 6.0, ofiScore: -0.05, depthRatio: 0.95, isEvap: false },
];
testItems.push(...ethScenarios);

// Guardar payload para que Compute-node lo ejecute localmente
writeFileSync("/tmp/benchmark_payload.json", JSON.stringify(testItems, null, 2));
console.log(`Payload con ${testItems.length} casos listo para benchmark dual.`);
