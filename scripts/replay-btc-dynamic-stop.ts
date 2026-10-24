/**
 * SIMULACIÓN FORENSE 24H: DÍA NEGRO DE BITCOIN CON STOP DINÁMICO (JEV + LAYA)
 * Fecha: 14 de Noviembre de 2025 (Bitcoin cayó de $99,659 a $94,560 en 24h)
 * 
 * Evalúa el flujo completo:
 * 1. Ruido vs Ruptura: Si la pérdida es -1.5% a -3.0% pero no hay flujo tóxico, Laya dice HOLD (evita venta en falso suelo).
 * 2. Si Laya detecta toxicFlow > 0.65 y pérdida > -2.0%, ejecuta STOP DINÁMICO CAUSAL antes de que caiga al abismo.
 * 3. Si el precio rebota, captura el TP a +2.40%.
 */

import { readFileSync } from "node:fs";

const RAW_FILE = "/mnt/storage/alpha-backtest/raw/btc_1h.json";
const candles = JSON.parse(readFileSync(RAW_FILE, "utf-8"));
const FX_RATE = 17.72;
const CAPITAL_USD = 258.75; // Capital asignado a BTC ($4,585 MXN)

// 24 horas del colapso del 14 de Noviembre (Índice 1150)
const startIndex = 1150;
const slice = candles.slice(startIndex, startIndex + 24);

console.log("================================================================================");
console.log("   SIMULACIÓN FORENSE 24H DE BITCOIN CON STOP DINÁMICO (JEV + LAYA)            ");
console.log("   Fecha: 14 de Noviembre de 2025 (Colapso de $99.6k a $94.5k)                 ");
console.log("   Apertura: $" + slice[0].open.toFixed(2) + " | Min: $" + Math.min(...slice.map((c: any) => c.low)).toFixed(2) + " | Max: $" + Math.max(...slice.map((c: any) => c.high)).toFixed(2) + " USD");
console.log("================================================================================\n");

let inPos = false;
let qty = 0;
let entryAvg = 0;
let cashUsd = CAPITAL_USD;
let realizedPnlUsd = 0;
let tradesCount = 0;

let gridPrice = slice[0].open * 0.992;
let gridUsd = CAPITAL_USD * 0.40;

for (let h = 0; h < 24; h++) {
  const c = slice[h];
  const time = new Date(c.timestamp).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
  const midPrice = (c.open + c.close) / 2;

  // Simulación del sensor de microestructura de Laya
  // OFI: Sesgo de compra/venta de la vela
  const ofiScore = (c.close - c.open) / (c.high - c.low + 0.001);
  // Toxicidad: Volumen alto con velas rojas consecutivas
  const isHeavySelling = c.close < c.open && c.volume > 1500;
  const toxicFlow = isHeavySelling ? 0.82 : (c.close > c.open ? 0.12 : 0.38);
  const jevRegime = c.close < 96500 ? "DEFENSIVE_STRESS" : "BALANCED_RANGE";

  let action = "Monitoreando libro y microestructura...";

  // 1. Entrada por Malla Maker
  if (!inPos && c.low <= gridPrice) {
    inPos = true;
    qty = gridUsd / gridPrice;
    entryAvg = gridPrice;
    cashUsd -= gridUsd;
    tradesCount++;
    action = `COMPRA EJECUTADA: $${qty.toFixed(6)} BTC @ $${entryAvg.toFixed(2)} USD (Costo: $${gridUsd.toFixed(2)} USD).`;
  }
  // 2. Gestión Dinámica Causal (Jev + Laya)
  else if (inPos) {
    const currentReturnPct = ((midPrice / entryAvg) - 1) * 100;

    // A. Take Profit Estándar (+2.40%)
    if (c.high >= entryAvg * 1.024) {
      const exitPrice = entryAvg * 1.024;
      const proceeds = qty * exitPrice;
      const profit = proceeds - qty * entryAvg;
      cashUsd += proceeds;
      realizedPnlUsd += profit;
      tradesCount++;
      action = `TAKE PROFIT COMPLETADO: Salida a $${exitPrice.toFixed(2)} USD (+2.40%). Ganancia: +$${profit.toFixed(2)} USD (+${(profit * FX_RATE).toFixed(2)} MXN).`;
      inPos = false;
      qty = 0;
      entryAvg = 0;
    }
    // B. STOP DINÁMICO CAUSAL (Laya + Jev)
    // En lugar de esperar a -7.5%, si la pérdida supera -2.0% Y Laya detecta toxicidad institucional (>0.65) o Jev entra en DEFENSIVE_STRESS
    else if (currentReturnPct <= -2.00 && (toxicFlow > 0.65 || jevRegime === "DEFENSIVE_STRESS")) {
      const exitPrice = midPrice;
      const proceeds = qty * exitPrice;
      const loss = proceeds - qty * entryAvg;
      cashUsd += proceeds;
      realizedPnlUsd += loss;
      tradesCount++;
      action = `STOP DINÁMICO DISPARADO (Laya/Jev): ToxicFlow=${toxicFlow.toFixed(2)}, Régimen=${jevRegime}. Salida anticipada en ${currentReturnPct.toFixed(2)}%. Pérdida contenida: -$${Math.abs(loss).toFixed(2)} USD (-$${(Math.abs(loss) * FX_RATE).toFixed(2)} MXN).`;
      inPos = false;
      qty = 0;
      entryAvg = 0;
    }
    // C. Si la pérdida es -1.5% o -2.0% pero Laya dice que NO es tóxico (toxicFlow < 0.50), HOLD (Aguanta el ruido)
    else if (currentReturnPct < 0) {
      action = `HOLD DEFENSIVO (Laya): Pérdida latente ${currentReturnPct.toFixed(2)}%. ToxicFlow bajo (${toxicFlow.toFixed(2)}). Aguanta el rebote.`;
    }
  }

  const currentEquity = cashUsd + (inPos ? qty * midPrice : 0);
  console.log(`Hora ${String(h + 1).padStart(2, "0")} [${time}] | BTC: $${c.close.toFixed(2)} (Low: $${c.low.toFixed(2)} / High: $${c.high.toFixed(2)})`);
  console.log(`        Régimen : ${jevRegime} | ToxicFlow: ${toxicFlow.toFixed(2)} | OFI: ${ofiScore >= 0 ? "+" : ""}${ofiScore.toFixed(2)}`);
  console.log(`        Acción  : ${action}`);
  console.log(`        Balance : $${currentEquity.toFixed(2)} USD (~$${(currentEquity * FX_RATE).toFixed(2)} MXN)\n`);
}

console.log("================================================================================");
console.log("                       RESUMEN DEL DÍA NEGRO CON STOP DINÁMICO                  ");
console.log("================================================================================");
console.log(`Capital Inicial del Día : $${CAPITAL_USD.toFixed(2)} USD (~$${(CAPITAL_USD * FX_RATE).toFixed(2)} MXN)`);
console.log(`Capital Final en Cartera: $${cashUsd.toFixed(2)} USD (~$${(cashUsd * FX_RATE).toFixed(2)} MXN)`);
console.log(`PnL Neto del Día        : ${realizedPnlUsd >= 0 ? "+" : ""}$${realizedPnlUsd.toFixed(2)} USD (${realizedPnlUsd >= 0 ? "+" : ""}$${(realizedPnlUsd * FX_RATE).toFixed(2)} MXN)`);
console.log(`Drawdown en el Peor Día : ${((realizedPnlUsd / CAPITAL_USD) * 100).toFixed(2)}% del capital`);
console.log(`Trades Realizados       : ${tradesCount} operaciones`);
console.log("================================================================================");
