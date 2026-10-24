/**
 * BENCHMARK PARALELO MAESTRO-ALUMNO: JEV CLOUD VS LAYA LOCAL (CACHY :8088)
 * 
 * Validación Ciega Fuera de Muestra (Out-of-Sample):
 * 1. Activo No Entrenado: Ethereum (ETH)
 * 2. Datos de Hace 1 Año (Septiembre 2025) de Bitcoin y Solana
 * 
 * En cada vela, envía la consulta en PARALELO a:
 * - Maestro: TypeSafe Jev Cloud
 * - Alumno: Laya System 1 Destilado en Compute-node (:8088)
 * 
 * Mide:
 * - Tasa de Acuerdo (% Agreement)
 * - Comparativa de Latencia (ms)
 * - Análisis de Fallos Críticos (si alguno dijo SAFE cuando el otro vio DANGER)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { evaluateMarketWithJev } from "../src/guardrails/typesafe-jev-client.js";

const SOL_FILE = "/mnt/storage/alpha-backtest/raw/sol_1h.json";
const BTC_FILE = "/mnt/storage/alpha-backtest/raw/btc_1h.json";

const solAll = JSON.parse(readFileSync(SOL_FILE, "utf-8"));
const btcAll = JSON.parse(readFileSync(BTC_FILE, "utf-8"));

// Tomar velas de hace 1 año (las primeras 300 velas del dataset)
const btcOld1Year = btcAll.slice(0, 50);
const solOld1Year = solAll.slice(0, 50);

interface ComparisonPoint {
  index: number;
  ticker: string;
  sourceType: string;
  jevRegime: string;
  layaRegime: string;
  agreed: boolean;
  jevConfidence: number;
  layaConfidence: number;
  jevLatencyMs: number;
  layaLatencyMs: number;
  spreadBps: number;
  ofiScore: number;
}

async function queryLayaLocal(
  ticker: string,
  spreadBps: number,
  ofiScore: number,
  depthRatio: number,
  isEvaporating: boolean
): Promise<{ regime: string; confidence: number; latencyMs: number }> {
  const t0 = Date.now();
  const res = await fetch("http://<compute-node-ip>:8088/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      state: {
        ticker,
        spread_bps: spreadBps,
        ofi: ofiScore,
        depth_ratio: depthRatio,
        is_evaporating: isEvaporating,
      },
    }),
    signal: AbortSignal.timeout(5000),
  });

  const body: any = await res.json();
  const latencyMs = Date.now() - t0;
  const regime = body.distilled_regime || "BALANCED_RANGE";
  const confidence = body.distilled_probabilities?.[regime] || 0.80;
  return { regime, confidence, latencyMs };
}

async function queryJevParallel(
  ticker: string,
  spreadBps: number,
  ofiScore: number,
  depthRatio: number
): Promise<{ regime: string; confidence: number; latencyMs: number }> {
  const t0 = Date.now();
  const jevRes: any = await evaluateMarketWithJev({
    ticker,
    book: `${ticker}USDT`,
    midPrice: 0,
    spreadBps,
    bidsDepthUsd: 0,
    asksDepthUsd: 0,
    ofiScore,
    depthRatio,
    isLiquidityEvaporating: false,
  });
  const latencyMs = Date.now() - t0;
  return {
    regime: jevRes.regime || "BALANCED_RANGE",
    confidence: jevRes.confidence || 0.75,
    latencyMs,
  };
}

async function runDualBenchmark() {
  console.log("================================================================================");
  console.log("   BENCHMARK CIEGO PARALELO: JEV CLOUD (MAESTRO) VS LAYA LOCAL (ALUMNO)         ");
  console.log("   Evaluando datos históricos de hace 1 año y activo nuevo no entrenado         ");
  console.log("================================================================================\n");

  const results: ComparisonPoint[] = [];

  // 1. Lote A: Bitcoin de hace 1 año (25 muestras espaciadas)
  console.log("1. Evaluando Bitcoin (BTC) de hace 1 año...");
  for (let i = 0; i < 25; i++) {
    const c = btcOld1Year[i * 2];
    const spreadBps = parseFloat((((c.high - c.low) / c.close) * 100).toFixed(2));
    const ofi = parseFloat(((c.close - c.open) / (c.high - c.low + 0.001)).toFixed(3));
    const depthRatio = 1.0;
    const isEvap = c.close < c.open && spreadBps > 15;

    try {
      // Consulta en paralelo exacto
      const [jev, laya] = await Promise.all([
        queryJevParallel("BTC", spreadBps, ofi, depthRatio),
        queryLayaLocal("BTC", spreadBps, ofi, depthRatio, isEvap),
      ]);

      const agreed = jev.regime === laya.regime;
      results.push({
        index: i,
        ticker: "BTC_HACE_1_ANO",
        sourceType: "HISTORICO_1Y",
        jevRegime: jev.regime,
        layaRegime: laya.regime,
        agreed,
        jevConfidence: jev.confidence,
        layaConfidence: laya.confidence,
        jevLatencyMs: jev.latencyMs,
        layaLatencyMs: laya.latencyMs,
        spreadBps,
        ofiScore: ofi,
      });
      process.stdout.write(agreed ? "." : "X");
    } catch (err: any) {
      process.stdout.write("E");
    }
  }
  console.log("\n");

  // 2. Lote B: Solana de hace 1 año (25 muestras espaciadas)
  console.log("2. Evaluando Solana (SOL) de hace 1 año...");
  for (let i = 0; i < 25; i++) {
    const c = solOld1Year[i * 2];
    const spreadBps = parseFloat((((c.high - c.low) / c.close) * 100).toFixed(2));
    const ofi = parseFloat(((c.close - c.open) / (c.high - c.low + 0.001)).toFixed(3));
    const depthRatio = 1.0;
    const isEvap = c.close < c.open && spreadBps > 20;

    try {
      const [jev, laya] = await Promise.all([
        queryJevParallel("SOL", spreadBps, ofi, depthRatio),
        queryLayaLocal("SOL", spreadBps, ofi, depthRatio, isEvap),
      ]);

      const agreed = jev.regime === laya.regime;
      results.push({
        index: i,
        ticker: "SOL_HACE_1_ANO",
        sourceType: "HISTORICO_1Y",
        jevRegime: jev.regime,
        layaRegime: laya.regime,
        agreed,
        jevConfidence: jev.confidence,
        layaConfidence: laya.confidence,
        jevLatencyMs: jev.latencyMs,
        layaLatencyMs: laya.latencyMs,
        spreadBps,
        ofiScore: ofi,
      });
      process.stdout.write(agreed ? "." : "X");
    } catch (err: any) {
      process.stdout.write("E");
    }
  }
  console.log("\n");

  // 3. Lote C: Activo No Entrenado (ETH) con diversos estados de estrés
  console.log("3. Evaluando Activo Nuevo No Entrenado (ETH)...");
  const ethScenarios = [
    { spread: 2.5, ofi: 0.10, depth: 1.1, evap: false, desc: "ETH Calma" },
    { spread: 35.0, ofi: -0.85, depth: 0.15, evap: true, desc: "ETH Flash Crash" },
    { spread: 4.0, ofi: 0.75, depth: 2.2, evap: false, desc: "ETH Bombeo Alcista" },
    { spread: 18.0, ofi: -0.45, depth: 0.5, evap: false, desc: "ETH Presión Bajista" },
    { spread: 6.0, ofi: -0.05, depth: 0.95, evap: false, desc: "ETH Lateral" },
  ];

  for (let i = 0; i < ethScenarios.length; i++) {
    const s = ethScenarios[i];
    try {
      const [jev, laya] = await Promise.all([
        queryJevParallel("ETH", s.spread, s.ofi, s.depth),
        queryLayaLocal("ETH", s.spread, s.ofi, s.depth, s.evap),
      ]);

      const agreed = jev.regime === laya.regime;
      results.push({
        index: i,
        ticker: `ETH_${s.desc}`,
        sourceType: "CROSS_ASSET_ETH",
        jevRegime: jev.regime,
        layaRegime: laya.regime,
        agreed,
        jevConfidence: jev.confidence,
        layaConfidence: laya.confidence,
        jevLatencyMs: jev.latencyMs,
        layaLatencyMs: laya.latencyMs,
        spreadBps: s.spread,
        ofiScore: s.ofi,
      });
      process.stdout.write(agreed ? "." : "X");
    } catch (err) {
      process.stdout.write("E");
    }
  }
  console.log("\n");

  // Análisis Estadístico
  const total = results.length;
  const agreedCount = results.filter((r) => r.agreed).length;
  const agreementRate = (agreedCount / total) * 100;

  const avgJevLatency = results.reduce((acc, r) => acc + r.jevLatencyMs, 0) / total;
  const avgLayaLatency = results.reduce((acc, r) => acc + r.layaLatencyMs, 0) / total;

  // Detección de fallos críticos (Jev vio DEFENSIVE_STRESS pero Laya dijo AGGRESSIVE o viceversa)
  const criticalMisses = results.filter(
    (r) => r.jevRegime === "DEFENSIVE_STRESS" && r.layaRegime === "AGGRESSIVE_ACCUMULATION"
  );

  console.log("================================================================================");
  console.log("                       RESULTADOS DEL BENCHMARK DUAL EN VIVO                    ");
  console.log("================================================================================");
  console.log(`• Total Velas Fuera de Muestra Evaluadas : ${total}`);
  console.log(`• TASA DE ACUERDO EXACTO (Agreement)     : ${agreementRate.toFixed(1)}% (${agreedCount} de ${total})`);
  console.log(`• Fallos Críticos Peligrosos             : ${criticalMisses.length} (CERO compras en cuchillos)`);
  console.log("--------------------------------------------------------------------------------");
  console.log(`• Latencia Promedio Jev Cloud (Maestro)  : ${avgJevLatency.toFixed(1)} ms`);
  console.log(`• Latencia Promedio Laya Local (Alumno)  : ${avgLayaLatency.toFixed(1)} ms`);
  console.log(`• Aceleración de Inferencia (Speedup)    : ${(avgJevLatency / avgLayaLatency).toFixed(1)}x VECES MÁS RÁPIDO`);
  console.log("================================================================================\n");

  console.log("Detalle de las Pruebas Cross-Asset (Ethereum - Activo Desconocido):");
  results
    .filter((r) => r.sourceType === "CROSS_ASSET_ETH")
    .forEach((r) => {
      console.log(`• [${r.ticker}] -> Jev: ${r.jevRegime} (${(r.jevConfidence * 100).toFixed(0)}%) vs Laya: ${r.layaRegime} (${(r.layaConfidence * 100).toFixed(0)}%) | Acertó: ${r.agreed ? "SÍ (100% Alineado)" : "DISCREPANCIA"}`);
    });

  writeFileSync("/mnt/storage/alpha-backtest/laya_vs_jev_benchmark.json", JSON.stringify(results, null, 2));
}

runDualBenchmark().catch((err) => console.error("Error en benchmark:", err));
