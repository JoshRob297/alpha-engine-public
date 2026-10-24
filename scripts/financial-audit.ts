/**
 * Analisis Financiero y Contable de Trades Reales
 */
import { readFileSync } from "fs";

const state = JSON.parse(readFileSync("./data/engine_state.json", "utf-8"));
console.log("=== ESTADO FINANCIERO CONSOLIDADO ===");
console.log("CEX (Bitso):");
for (const [k, v] of Object.entries(state.cex || {})) {
  const d: any = v;
  const pnlMxn = d.avgPrice && d.lastPrice ? (d.lastPrice - d.avgPrice) * d.qty : 0;
  const pnlPct = d.avgPrice && d.lastPrice ? ((d.lastPrice - d.avgPrice) / d.avgPrice) * 100 : 0;
  console.log(`- ${k}: Posicion ${d.qty} ${k} | Entrada: $${d.avgPrice?.toFixed(2)} | Actual: $${d.lastPrice?.toFixed(2)} | PnL No Realizado: +$${pnlMxn.toFixed(2)} MXN (+${pnlPct.toFixed(2)}%)`);
}

console.log("\nDEX (Base L2 Aerodrome):");
for (const [k, v] of Object.entries(state.dex || {})) {
  const d: any = v;
  console.log(`- ${d.pool}: Capital $${d.currentCapitalUsd?.toFixed(2)} USD | Fees Acumulados: +$${d.accumulatedFeesUsd?.toFixed(4)} USD`);
}

console.log("\nHistorial de Operaciones Cerradas en Ledger:");
const history = state.history || [];
console.log(`Total operaciones en historial: ${history.length}`);
let wins = 0;
let losses = 0;
for (const h of history) {
  if (h.pnlNet > 0) wins++;
  else if (h.pnlNet < 0) losses++;
  console.log(`- [${h.venue}] ${h.assetOrPool} | ${h.action} | Precio: $${h.price?.toFixed(2)} | Fee: $${h.feeSavedOrPaid?.toFixed(2)}`);
}
console.log(`Win Rate de Trades Cerrados: ${history.length > 0 ? ((wins / history.length) * 100).toFixed(1) : 0}% (Actualmente en fase de acumulacion de inventario)`);
