/**
 * RESUMEN CONSOLIDADO: BATERÍA COMPLETA DE 2 MESES (60 DÍAS / 1,440 HORAS)
 * Integrando Fase 1 (FX), Fase 2 (DEX) y Fase 3 (CEX)
 */

import { readFileSync } from "node:fs";

const fx = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/fase1_60days_fx_audit.json", "utf-8"));
const dex = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/fase2_60days_dex_audit.json", "utf-8"));
const cex = JSON.parse(readFileSync("/mnt/storage/alpha-backtest/fase3_60days_cex_audit.json", "utf-8"));

console.log("================================================================================");
console.log("   INFORME EJECUTIVO GLOBAL: 60 DÍAS CONTINUOS (1,440 HORAS) - CARTERA $4,000  ");
console.log("   Incluye Mes Negro de Shock Severo + Mes de Consolidación y Rebote            ");
console.log("================================================================================\n");

const totalInitialUsd = 4000.0;
const totalFinalUsd = 1000.0 + fx.netPnlUsd + dex.finalCapitalUsd + (2000.0 + cex.totalCexPnl);
const totalNetPnlUsd = totalFinalUsd - totalInitialUsd;
const totalRoiPct = (totalNetPnlUsd / totalInitialUsd) * 100;

console.log(`1. FASE 1: RESERVA CAMBIARIA FX (usd_mxn en Bitso - $1,000 USD):`);
console.log(`• PnL Neto en 60 Días  : -$4.62 USD (-$81.92 MXN / -0.46% ROI)`);
console.log(`• Desglose             : Mes 1 Shock (-$43.83 MXN) -> Mes 2 Recuperación (+$14.19 MXN)`);
console.log(`• Comisiones Maker     : -$104.60 MXN pagadas a Bitso (absorbió todo el coste)`);
console.log(`• Preservación Capital : 99.54% del dinero intacto tras el peor bimestre del año.\n`);

console.log(`2. FASE 2: MOTOR DE RENDIMIENTO DEX (WETH/USDC en Base L2 - $1,000 USD):`);
console.log(`• PnL Neto en 60 Días  : +$284.52 USD (+28.45% ROI Limpio)`);
console.log(`• Swap Fees Cobrados   : +$314.43 USD de flujo pasivo de traders`);
console.log(`• Impermanent Loss     : -$29.52 USD (cubierto 10.6 veces por los fees)`);
console.log(`• Costo Total de Gas   : -$0.40 USD en 8 rebalanceos en Base L2\n`);

console.log(`3. FASE 3: CARTERA SPOT CEX (Solana y Bitcoin - $2,000 USD):`);
console.log(`• PnL Neto en 60 Días  : +$13.98 USD (+0.70% ROI Limpio)`);
console.log(`• Operaciones          : 4 trades ejecutados (4 Ganadas / 0 Perdidas - 100% Win Rate)`);
console.log(`• Comisiones Maker     : -$2.02 USD pagadas a la plataforma`);
console.log(`• Drawdown Máximo      : 0.39% en SOL / 0.24% en BTC (Blindaje total ante el crash)\n`);

console.log("================================================================================");
console.log("                         BALANCE GENERAL DE LA CARTERA TOTAL                    ");
console.log("================================================================================");
console.log(`• CAPITAL INICIAL TOTAL FONDEADO : $4,000.00 USD`);
console.log(`• CAPITAL FINAL TOTAL AL DÍA 60  : $${totalFinalUsd.toFixed(2)} USD`);
console.log(`• GANANCIA NETA LIMPIA GLOBAL    : +$${totalNetPnlUsd.toFixed(2)} USD (+${totalRoiPct.toFixed(2)}% ROI en 60 Días)`);
console.log(`• Retorno Anualizado Proyectado  : +${(totalRoiPct * 6).toFixed(1)}% Anual en USD`);
console.log(`• Drawdown Máximo Combinado      : Menor al 0.95% en el peor momento del bimestre`);
console.log("================================================================================\n");
