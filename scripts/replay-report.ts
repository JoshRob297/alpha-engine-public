/**
 * Generador de Reporte y Diagnóstico Comparativo del Replay Ciego
 * Analiza /mnt/storage/alpha-backtest/replay_state.json y genera
 * resumen cuantitativo detallado de salud, drawdown y viabilidad.
 */

import { readFileSync, existsSync } from "node:fs";

const STATE_FILE = "/mnt/storage/alpha-backtest/replay_state.json";

function main() {
  if (!existsSync(STATE_FILE)) {
    console.error(`Archivo ${STATE_FILE} no encontrado. Ejecuta primero scripts/replay-harness.ts`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  const m = raw.metrics;
  const c = raw.counts;

  console.log("\n========================================================");
  console.log("       INFORME DE AUDITORÍA: REPLAY CIEGO 1 AÑO         ");
  console.log("========================================================");
  console.log(`Período Simulado     : ${raw.totalHoursSimulated} horas (${raw.simulationDays} días de mercado real)`);
  console.log(`Tiempo de Ejecución  : ${raw.elapsedRealSeconds} segundos (Aceleración ~${((raw.totalHoursSimulated * 3600) / raw.elapsedRealSeconds).toFixed(0)}x)`);
  console.log(`Capital Base Inicial : $${raw.initialCapitalUsd.toFixed(2)} USD`);
  console.log("--------------------------------------------------------");
  console.log("1. RENDIMIENTO CUANTITATIVO GENERAL:");
  console.log(`   • Win Rate Efectivo   : ${m.winRatePct}%`);
  console.log(`   • Profit Factor       : ${m.profitFactor >= 99 ? "99.9 (Sin pérdidas mayores)" : m.profitFactor}`);
  console.log(`   • Drawdown Máximo     : ${m.maxDrawdownPct}%`);
  console.log(`   • Peor Trade Único    : ${m.worstTradePct}%`);
  console.log(`   • Total Trades        : ${m.totalTrades} (${m.winningTrades} Ganadores / ${m.losingTrades} Perdedores)`);
  console.log("--------------------------------------------------------");
  console.log("2. DESGLOSE DE PnL REALIZADO:");
  console.log(`   • PnL CEX (Spot Mallas): +$${m.totalPnlMxn} MXN`);
  console.log(`   • DEX Fees (Slipstream): +$${raw.finalDexFeesUsd} USD (~+$${(raw.finalDexFeesUsd * 17.7).toFixed(2)} MXN)`);
  const totalCombinedMxn = m.totalPnlMxn + raw.finalDexFeesUsd * 17.7;
  console.log(`   • Rendimiento Neto Tot : +$${totalCombinedMxn.toFixed(2)} MXN`);
  console.log(`   • ROI Anualizado Real  : +${((totalCombinedMxn / (raw.initialCapitalUsd * 17.7)) * 100).toFixed(2)}%`);
  console.log("--------------------------------------------------------");
  console.log("3. ANÁLISIS DE COMPORTAMIENTO DE SALIDAS:");
  console.log(`   • Take Profits Totales: ${c.takeProfits}`);
  console.log(`   • Ping-Pong Reciclados: ${c.pingPongRecycles}`);
  console.log(`   • Hard Stops Clásicos : ${c.hardStops}`);
  console.log(`   • Emergency Deleverage: ${c.emergencyDeleverage} (Umbral estricto <= -3.0%)`);
  console.log("--------------------------------------------------------");
  console.log("4. VEREDICTO DE SOSTENIBILIDAD:");
  if (m.maxDrawdownPct <= 3.0 && m.profitFactor >= 1.5) {
    console.log("   [DICTAMEN] SISTEMA MATEMÁTICAMENTE SOSTENIBLE Y ROBUSTO.");
    console.log("   Cero quiebra de cuenta, drawdowns contenidos dentro de la tolerancia institucional.");
  } else {
    console.log("   [DICTAMEN] REQUIERE REVISIÓN DE GOBERNANZA.");
  }
  console.log("========================================================\n");
}

main();
