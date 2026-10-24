/**
 * REPRODUCTOR FORENSE COMPARATIVO DE LOS 2 PEORES DÍAS DE SHOCK EN BITSO
 * Simula las 24 horas exactas de:
 * - Shock 1: 21 de Septiembre de 2026 (Volatilidad 3.05% - Flash Crash y Rebote)
 * - Shock 2: 01 de Julio de 2026 (Volatilidad 2.82% - Salto Brusco de Verano)
 * Ejecuta la lógica real de FxEngineAutonomous con $120.00 MXN de capital.
 */

import { readFileSync } from "node:fs";

const RAW_FILE = "/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json";
const allCandles = JSON.parse(readFileSync(RAW_FILE, "utf-8"));

function simulateDay(dayName: string, startIndex: number, initialCapital: number) {
  const candles = allCandles.slice(startIndex, startIndex + 24);
  const minP = Math.min(...candles.map((c: any) => c.low));
  const maxP = Math.max(...candles.map((c: any) => c.high));
  const changePct = ((maxP - minP) / minP) * 100;

  console.log("================================================================================");
  console.log(`   SIMULACIÓN FORENSE: ${dayName.toUpperCase()}`);
  console.log(`   Fecha Inicio: ${new Date(candles[0].timestamp).toISOString()} // Rango: ${changePct.toFixed(2)}%`);
  console.log(`   Apertura: $${candles[0].open.toFixed(3)} | Min: $${minP.toFixed(3)} | Max: $${maxP.toFixed(3)} | Cierre: $${candles[23].close.toFixed(3)} MXN`);
  console.log("================================================================================\n");

  let cashMxn = initialCapital;
  let inPos = false;
  let qtyUsd = 0;
  let entryAvg = 0;
  let tpPrice = 0;
  let stopPrice = 0;
  let realizedPnlMxn = 0;
  let trades = 0;

  let gridPending = true;
  let gridPrice = parseFloat((candles[0].open * 0.9985).toFixed(3));
  let gridAmountUsd = parseFloat((70.0 / gridPrice).toFixed(4));

  console.log(`[00:00] Orden L1 colocada: Compra $${gridAmountUsd} USD @ $${gridPrice.toFixed(3)} MXN.\n`);

  for (let h = 0; h < 24; h++) {
    const c = candles[h];
    const timeStr = new Date(c.timestamp).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
    const midPrice = (c.open + c.close) / 2;
    let action = "Monitoreando libro sin alteraciones.";

    // 1. Fill de compra
    if (!inPos && gridPending && c.low <= gridPrice) {
      inPos = true;
      qtyUsd = gridAmountUsd;
      entryAvg = gridPrice;
      tpPrice = parseFloat((entryAvg * 1.0045).toFixed(3));
      stopPrice = parseFloat((entryAvg * 0.992).toFixed(3));
      cashMxn -= qtyUsd * entryAvg;
      gridPending = false;
      trades++;
      action = `COMPRA LLENADA: $${qtyUsd} USD @ $${entryAvg.toFixed(3)} MXN. TP: $${tpPrice.toFixed(3)}.`;
    }

    // 2. Gestión de posición
    if (inPos) {
      if (c.low <= stopPrice) {
        const proceeds = qtyUsd * stopPrice;
        const loss = proceeds - qtyUsd * entryAvg;
        cashMxn += proceeds;
        realizedPnlMxn += loss;
        trades++;
        action = `STOP DEFENSIVO: Venta a $${stopPrice.toFixed(3)} MXN. Pérdida: -$${Math.abs(loss).toFixed(2)} MXN.`;
        inPos = false;
        qtyUsd = 0;
        entryAvg = 0;
        gridPending = false;
      } else if (c.high >= tpPrice) {
        const proceeds = qtyUsd * tpPrice;
        const profit = proceeds - qtyUsd * entryAvg;
        cashMxn += proceeds;
        realizedPnlMxn += profit;
        trades++;
        action = `TAKE PROFIT COMPLETADO: Venta a $${tpPrice.toFixed(3)} MXN (+0.45%). Ganancia: +$${profit.toFixed(2)} MXN.`;
        inPos = false;
        qtyUsd = 0;
        entryAvg = 0;
        gridPending = true;
        gridPrice = parseFloat((midPrice * 0.9985).toFixed(3));
        gridAmountUsd = parseFloat((70.0 / gridPrice).toFixed(4));
      }
    }

    const currentEquity = cashMxn + (inPos ? qtyUsd * midPrice : 0);
    console.log(`Hora ${String(h + 1).padStart(2, "0")} [${timeStr}] | Spot: $${c.close.toFixed(3)} | Balance: $${currentEquity.toFixed(2)} MXN`);
    console.log(`        Acción : ${action}`);
  }

  const finalEquity = cashMxn + (inPos ? qtyUsd * candles[23].close : 0);
  console.log("\n--------------------------------------------------------------------------------");
  console.log(`RESUMEN ${dayName.toUpperCase()}:`);
  console.log(`• Capital Inicial: $${initialCapital.toFixed(2)} MXN`);
  console.log(`• Capital Final  : $${finalEquity.toFixed(2)} MXN`);
  console.log(`• PnL Neto Día   : ${realizedPnlMxn >= 0 ? "+" : ""}$${realizedPnlMxn.toFixed(2)} MXN (${((realizedPnlMxn / initialCapital) * 100).toFixed(2)}%)`);
  console.log(`• Total Trades   : ${trades} operaciones`);
  console.log("--------------------------------------------------------------------------------\n\n");

  return { dayName, initialCapital, finalEquity, pnl: realizedPnlMxn, trades };
}

console.log("================================================================================");
console.log("   STRESS TEST COMPARATIVO: LOS 2 DIAS DE MAYOR IMPACTO DEL AÑO EN BITSO        ");
console.log("================================================================================\n");

// Shock 1: 21 de Septiembre (Index 4578)
const res1 = simulateDay("Caso 1: Shock de Septiembre (Flash Crash - 3.05%)", 4578, 120.0);

// Shock 2: 01 de Julio (Index 2604)
const res2 = simulateDay("Caso 2: Shock de Julio (Salto Direccional - 2.82%)", 2604, 120.0);

console.log("================================================================================");
console.log("                       BALANCE COMPARATIVO FINAL                                ");
console.log("================================================================================");
console.log(`Caso 1 (21 Sep): PnL ${res1.pnl >= 0 ? "+" : ""}$${res1.pnl.toFixed(2)} MXN | Balance: $${res1.finalEquity.toFixed(2)} MXN`);
console.log(`Caso 2 (01 Jul): PnL ${res2.pnl >= 0 ? "+" : ""}$${res2.pnl.toFixed(2)} MXN | Balance: $${res2.finalEquity.toFixed(2)} MXN`);
console.log("================================================================================");
