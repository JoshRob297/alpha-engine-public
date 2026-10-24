/**
 * AUDITOR FORENSE DE PÉRDIDAS EN CEX (BTC Y SOL)
 * Analiza las 8,760 horas para identificar exactamente:
 * 1. Fechas y horas de cada uno de los 30 stops de BTC y 55 stops de SOL.
 * 2. Cuánto dinero se perdió en cada evento.
 * 3. Los 3 peores "Clusters de Sangrado" que destrozaron el PnL de Bitcoin.
 */

import { readFileSync, writeFileSync } from "node:fs";

const RAW_DIR = "/mnt/storage/alpha-backtest/raw";
const FX_RATE = 17.72;

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function auditCexLosses(ticker: "BTC" | "SOL", profile: "ANCHOR" | "BETA", initialCapitalUsd: number) {
  const file = `${RAW_DIR}/${ticker.toLowerCase()}_1h.json`;
  const candles: Candle[] = JSON.parse(readFileSync(file, "utf-8"));
  console.log(`\n================================================================================`);
  console.log(`   AUDITORÍA FORENSE DE STOPS Y PÉRDIDAS PARA ${ticker} (${candles.length} HORAS)`);
  console.log(`   Capital Asignado: $${initialCapitalUsd.toFixed(2)} USD (~$${(initialCapitalUsd * FX_RATE).toFixed(2)} MXN)`);
  console.log(`================================================================================\n`);

  const tpPct = profile === "ANCHOR" ? 0.0145 : 0.034;
  const stopLossPct = profile === "ANCHOR" ? 0.075 : 0.085;
  const gridSpacing = profile === "ANCHOR" ? 0.008 : 0.015;

  let inPos = false;
  let qty = 0;
  let entryAvg = 0;
  let tpPrice = 0;
  let stopPrice = 0;
  let cash = initialCapitalUsd;
  const stopEvents: any[] = [];
  const winEvents: any[] = [];

  let gridPrice = candles[0].open * (1 - gridSpacing);
  let gridUsd = initialCapitalUsd * 0.40;

  for (let t = 0; t < candles.length; t++) {
    const c = candles[t];
    const midPrice = (c.open + c.close) / 2;

    // Compra
    if (!inPos && c.low <= gridPrice) {
      inPos = true;
      qty = gridUsd / gridPrice;
      entryAvg = gridPrice;
      tpPrice = entryAvg * (1 + tpPct);
      stopPrice = entryAvg * (1 - stopLossPct);
      cash -= gridUsd;
    }

    // Posición viva
    if (inPos) {
      // 1. ¿Stop Loss?
      if (c.low <= stopPrice) {
        const exitPrice = stopPrice;
        const proceeds = qty * exitPrice;
        const lossUsd = proceeds - qty * entryAvg;
        const lossMxn = lossUsd * FX_RATE;
        cash += proceeds;

        stopEvents.push({
          index: t,
          timestamp: c.timestamp,
          date: new Date(c.timestamp).toISOString(),
          entryPrice: parseFloat(entryAvg.toFixed(2)),
          exitPrice: parseFloat(exitPrice.toFixed(2)),
          lossUsd: parseFloat(lossUsd.toFixed(2)),
          lossMxn: parseFloat(lossMxn.toFixed(2)),
          lossPct: parseFloat(((exitPrice / entryAvg - 1) * 100).toFixed(2)),
          candleLow: c.low,
          candleHigh: c.high,
        });

        inPos = false;
        qty = 0;
        entryAvg = 0;
        // Esperar 12 horas tras el stop para recomprar
        gridPrice = midPrice * (1 - gridSpacing);
      }
      // 2. ¿Take Profit?
      else if (c.high >= tpPrice) {
        const exitPrice = tpPrice;
        const proceeds = qty * exitPrice;
        const profitUsd = proceeds - qty * entryAvg;
        const profitMxn = profitUsd * FX_RATE;
        cash += proceeds;

        winEvents.push({
          date: new Date(c.timestamp).toISOString(),
          profitMxn,
        });

        inPos = false;
        qty = 0;
        entryAvg = 0;
        gridPrice = midPrice * (1 - gridSpacing);
      }
    }
  }

  // Ordenar los peores stops por impacto en pesos
  stopEvents.sort((a, b) => a.lossMxn - b.lossMxn);

  console.log(`Total Victorias (TPs): ${winEvents.length}`);
  console.log(`Total Derrotas (Stops): ${stopEvents.length}`);
  const totalLossMxn = stopEvents.reduce((acc, s) => acc + s.lossMxn, 0);
  const totalProfitMxn = winEvents.reduce((acc, w) => acc + w.profitMxn, 0);
  console.log(`Ganancia Bruta Acumulada: +$${totalProfitMxn.toFixed(2)} MXN`);
  console.log(`Pérdida Bruta Acumulada  : -$${Math.abs(totalLossMxn).toFixed(2)} MXN`);
  console.log(`PnL Neto Final           : ${totalProfitMxn + totalLossMxn >= 0 ? "+" : ""}$${(totalProfitMxn + totalLossMxn).toFixed(2)} MXN\n`);

  console.log(`--- LOS 5 PEORES DESPLOMES (CLUSTERS DE SANGRADO) EN ${ticker} ---`);
  stopEvents.slice(0, 5).forEach((s, idx) => {
    console.log(`${idx + 1}. Fecha: ${s.date} (Vela #${s.index})`);
    console.log(`   Entrada: $${s.entryPrice} -> Salida Stop: $${s.exitPrice} (${s.lossPct}%)`);
    console.log(`   Pérdida del Evento: -$${Math.abs(s.lossMxn).toFixed(2)} MXN (-$${Math.abs(s.lossUsd).toFixed(2)} USD)\n`);
  });

  return { ticker, stopEvents, winEvents };
}

// 1. Auditar Bitcoin ($258.75 USD asignados en el reporte)
const btcAudit = auditCexLosses("BTC", "ANCHOR", 258.75);

// 2. Auditar Solana ($41.25 USD asignados en el reporte)
const solAudit = auditCexLosses("SOL", "BETA", 41.25);
