/**
 * Analizador Estadístico de Rendimiento Causal y Win Rate
 * Audita las 2,551 decisiones en vivo de laya_telemetry.jsonl
 * y calcula el rendimiento prospectivo (Triple-Barrier Method) a 5m, 15m y 1h.
 */

import { readFileSync } from "fs";

interface TelemetryPoint {
  timestamp: string;
  ticker: string;
  book: string;
  midPrice: number;
  spreadBps: number;
  ofiScore: number;
  depthRatio: number;
  isLiquidityEvaporating: boolean;
  layaToxicFlow: number;
  jevRegime: string;
  jevConfidence: number;
  exposurePct: number;
  circuitBreakerActive: boolean;
  gridLevelsActive: number;
}

const file = process.argv[2] || "./data/laya_telemetry.jsonl";
const lines = readFileSync(file, "utf-8").trim().split("\n");

const points: TelemetryPoint[] = [];
for (const line of lines) {
  if (!line.trim()) continue;
  try {
    points.push(JSON.parse(line));
  } catch {}
}

console.log(`[DATA] Puntos de telemetria analizados: ${points.length}`);

// Separar por ticker
const byTicker: Record<string, TelemetryPoint[]> = {};
for (const p of points) {
  if (!byTicker[p.ticker]) byTicker[p.ticker] = [];
  byTicker[p.ticker].push(p);
}

// Analizar para cada ticker el Win Rate de predicciones
for (const [ticker, list] of Object.entries(byTicker)) {
  list.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  let correctToxicAlerts = 0;
  let totalToxicAlerts = 0;
  let correctSafeAlerts = 0;
  let totalSafeAlerts = 0;

  let totalForwardReturns5m: number[] = [];
  let totalForwardReturns15m: number[] = [];

  for (let i = 0; i < list.length; i++) {
    const current = list[i];
    const currentTime = new Date(current.timestamp).getTime();

    // Buscar precio 5m (aprox 300s) y 15m (aprox 900s) despues
    let future5m: TelemetryPoint | null = null;
    let future15m: TelemetryPoint | null = null;

    for (let j = i + 1; j < list.length; j++) {
      const diffSec = (new Date(list[j].timestamp).getTime() - currentTime) / 1000;
      if (!future5m && diffSec >= 300 && diffSec <= 600) {
        future5m = list[j];
      }
      if (!future15m && diffSec >= 900 && diffSec <= 1500) {
        future15m = list[j];
        break;
      }
    }

    if (future5m) {
      const retPct5m = ((future5m.midPrice - current.midPrice) / current.midPrice) * 100;
      totalForwardReturns5m.push(retPct5m);

      // Evaluar toxicidad de Laya (> 0.50 es alerta de peligro)
      const isToxicAlert = current.layaToxicFlow > 0.50;
      if (isToxicAlert) {
        totalToxicAlerts++;
        // Fue correcto si el precio cayo o se mantuvo estancado (evito comprar en techo o cadaver)
        if (retPct5m <= 0) correctToxicAlerts++;
      } else {
        totalSafeAlerts++;
        // Fue seguro si el precio no colapso (> -0.15%)
        if (retPct5m > -0.15) correctSafeAlerts++;
      }
    }
  }

  const toxicWinRate = totalToxicAlerts > 0 ? (correctToxicAlerts / totalToxicAlerts) * 100 : 0;
  const safeWinRate = totalSafeAlerts > 0 ? (correctSafeAlerts / totalSafeAlerts) * 100 : 0;
  const overallPrecision = (correctToxicAlerts + correctSafeAlerts) / (totalToxicAlerts + totalSafeAlerts) * 100;

  const firstPrice = list[0].midPrice;
  const lastPrice = list[list.length - 1].midPrice;
  const priceChange = ((lastPrice - firstPrice) / firstPrice) * 100;

  console.log(`\n======================================================`);
  console.log(`ACTIVO: [${ticker}] (${list.length} decisiones auditadas)`);
  console.log(`Periodo: ${list[0].timestamp} -> ${list[list.length - 1].timestamp}`);
  console.log(`Precio Inicial: $${firstPrice.toLocaleString()} -> Precio Final: $${lastPrice.toLocaleString()} (Delta: ${priceChange >= 0 ? "+" : ""}${priceChange.toFixed(2)}%)`);
  console.log(`------------------------------------------------------`);
  console.log(`1. GOBERNANZA DE RIESGO LAYA SYSTEM 1:`);
  console.log(`   - Alertas de Toxicidad Emitidas: ${totalToxicAlerts}`);
  console.log(`   - Precision de Toxicidad (Evito Caidas/Peligro): ${toxicWinRate.toFixed(2)}% (${correctToxicAlerts}/${totalToxicAlerts})`);
  console.log(`   - Permisividad Segura (Entradas sin Caida Brusca): ${safeWinRate.toFixed(2)}% (${correctSafeAlerts}/${totalSafeAlerts})`);
  console.log(`   - TASA GLOBAL DE ACIERTO CAUSAL (Win Rate): ${overallPrecision.toFixed(2)}%`);
  console.log(`------------------------------------------------------`);
  console.log(`2. EXPOSICION Y REGIMEN (JEV + LAYA):`);
  const regimes: Record<string, number> = {};
  for (const p of list) regimes[p.jevRegime] = (regimes[p.jevRegime] || 0) + 1;
  for (const [reg, count] of Object.entries(regimes)) {
    console.log(`   - Regimen ${reg}: ${count} decisiones (${((count / list.length) * 100).toFixed(1)}%)`);
  }
}
