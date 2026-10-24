/**
 * REPRODUCTOR FORENSE CON CAPITAL IDÉNTICO: $7,088.00 MXN ($400 USD)
 * Compara exactamente el mismo capital de la simulación rápida anual
 * contra la simulación forense hora por hora en los 2 días de shock.
 */

import { readFileSync } from "node:fs";

const RAW_FILE = "/mnt/storage/alpha-backtest/raw/usd_mxn_1h.json";
const allCandles = JSON.parse(readFileSync(RAW_FILE, "utf-8"));

function simulateFullCapital(dayName: string, startIndex: number, initialCapital: number) {
  const candles = allCandles.slice(startIndex, startIndex + 24);
  const minP = Math.min(...candles.map((c: any) => c.low));
  const maxP = Math.max(...candles.map((c: any) => c.high));
  const changePct = ((maxP - minP) / minP) * 100;

  console.log("================================================================================");
  console.log(`   TEST CON CAPITAL COMPLETO ($7,088.00 MXN / $400 USD): ${dayName.toUpperCase()}`);
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

  // Con $7,088 MXN, el bot despliega niveles estándar de $80 USD (~$1,417 MXN por nivel)
  let gridPending = true;
  let gridPrice = parseFloat((candles[0].open * 0.9985).toFixed(3));
  let gridAmountUsd = parseFloat((80.0).toFixed(4)); // $80 USD exactos como en el backtest anual

  console.log(`[00:00] Orden L1 colocada: Compra $${gridAmountUsd} USD @ $${gridPrice.toFixed(3)} MXN (Costo: $${(gridAmountUsd * gridPrice).toFixed(2)} MXN).\n`);

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
        gridAmountUsd = parseFloat((80.0).toFixed(4));
      }
    }

    const currentEquity = cashMxn + (inPos ? qtyUsd * midPrice : 0);
    console.log(`Hora ${String(h + 1).padStart(2, "0")} [${timeStr}] | Spot: $${c.close.toFixed(3)} | Balance: $${currentEquity.toFixed(2)} MXN`);
    console.log(`        Acción : ${action}`);
  }

  const finalEquity = cashMxn + (inPos ? qtyUsd * candles[23].close : 0);
  console.log("\n--------------------------------------------------------------------------------");
  console.log(`RESUMEN EXACTO CON $7,088 MXN:`);
  console.log(`• Capital Inicial: $${initialCapital.toFixed(2)} MXN`);
  console.log(`• Capital Final  : $${finalEquity.toFixed(2)} MXN`);
  console.log(`• Pérdida Neta   : ${realizedPnlMxn >= 0 ? "+" : ""}$${realizedPnlMxn.toFixed(2)} MXN`);
  console.log(`• Drawdown Real  : ${((realizedPnlMxn / initialCapital) * 100).toFixed(3)}% del capital total`);
  console.log("--------------------------------------------------------------------------------\n\n");

  return { dayName, initialCapital, finalEquity, pnl: realizedPnlMxn, drawdownPct: (realizedPnlMxn / initialCapital) * 100 };
}

console.log("================================================================================");
console.log("   COMPARACIÓN DIRECTA 1:1 CON CAPITAL DE $7,088.00 MXN ($400 USD)              ");
console.log("================================================================================\n");

// Shock 1: 21 de Septiembre (Index 4578)
const res1 = simulateFullCapital("Caso 1: Flash Crash de Septiembre (3.05%)", 4578, 7088.0);

// Shock 2: 01 de Julio (Index 2604)
const res2 = simulateFullCapital("Caso 2: Shock Direccional de Julio (2.82%)", 2604, 7088.0);

console.log("================================================================================");
console.log("                       TABLA COMPARATIVA FINAL EXACTA                           ");
console.log("================================================================================");
console.log(`Simulación Rápida Anual (Reporte Oficial) : Pérdida registrada = -$113.80 MXN (-1.61%)`);
console.log(`Forense Hora por Hora (21 Sep con $7,088) : Pérdida exacta     = $${res1.pnl.toFixed(2)} MXN (${res1.drawdownPct.toFixed(2)}%)`);
console.log(`Forense Hora por Hora (01 Jul con $7,088) : Pérdida exacta     = $${res2.pnl.toFixed(2)} MXN (${res2.drawdownPct.toFixed(2)}%)`);
console.log("================================================================================");
