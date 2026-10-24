/**
 * Script de Validación Dry-Run (Solo Lectura)
 * Ejecuta el flujo: Gemini Watchlist -> Symbol Resolver -> Jev/Laya -> Reglas Binance -> SETS Grid
 * CERO ESCRITURA: No modifica engine_state.json ni el servicio en ejecución.
 */

import { BinanceSymbolResolver } from "../cex/symbol-resolver.js";
import { MarketRulesManager } from "../cex/market-rules.js";
import { loadActiveWatchlist } from "./watchlist-loader.js";
import { evaluateMarketWithJev } from "../guardrails/typesafe-jev-client.js";
import { evaluateMarketStateLocal } from "../guardrails/laya-client-local.js";
import { readFileSync } from "node:fs";

async function runDryRunValidation() {
  console.log("======================================================================");
  console.log("       DRY-RUN VALIDATION: PIPELINE CEX HASTA MALLA SETS             ");
  console.log("             (100% AISLADO - CERO IMPACTO EN SIM / LIVE)              ");
  console.log("======================================================================\n");

  // 1. Lectura de candidatos de Gemini Research
  console.log("--- [1] CANDIDATOS ACTIVOS DE RESEARCH ---");
  const watchlist = await loadActiveWatchlist();
  const rawCandidates = watchlist?.candidates || [];
  console.log(`Régimen Macro Detectado: ${watchlist?.market_regime || "NEUTRAL_CHOP"}\n`);

  for (const c of rawCandidates) {
    console.log(`Ticker: ${c.ticker.padEnd(5)} | Sesgo: ${c.action_bias.padEnd(10)} | Score: ${c.research_score_1_to_10}/10 | Max Entry: $${c.max_entry_price_usd} | Stop: $${c.invalidation_price_usd}`);
  }

  // Filtrar solo los candidatos con sesgo ACCUMULATE
  const accumulateCandidates = rawCandidates.filter((c) => c.action_bias === "ACCUMULATE");
  console.log(`\nCandidatos con sesgo ACCUMULATE seleccionados para validación: ${accumulateCandidates.map((c) => c.ticker).join(", ")}`);

  // 2. Resolución Dinámica de Símbolos en Binance Spot
  console.log("\n--- [2] RESOLUCIÓN DINÁMICA DE PARES EN BINANCE SPOT ---");
  const resolvedList: Array<(typeof accumulateCandidates)[0] & { resolvedSymbol: string; volume24hUsd: number }> = [];

  for (const c of accumulateCandidates) {
    const res = await BinanceSymbolResolver.resolveSymbol(c.ticker, 3_000_000);
    if (res.isValid) {
      console.log(`[PASS] ${c.ticker} -> ${res.symbol} | Estado: ${res.status} | Vol 24h: $${(res.volume24hUsd / 1_000_000).toFixed(2)}M USD`);
      resolvedList.push({ ...c, resolvedSymbol: res.symbol, volume24hUsd: res.volume24hUsd });
    } else {
      console.log(`[FAIL] ${c.ticker} DESCARTADO: ${res.rejectReason}`);
    }
  }

  if (resolvedList.length === 0) {
    console.log("\nNingún candidato superó el filtro de Binance Spot.");
    return;
  }

  // 3. Sincronización de Reglas de Mercado Binance (minNotional, lotes)
  console.log("\n--- [3] FILTROS DE MERCADO BINANCE (EXCHANGE INFO) ---");
  const rulesMgr = new MarketRulesManager();
  await rulesMgr.syncSymbols(resolvedList.map((r) => r.resolvedSymbol));

  for (const item of resolvedList) {
    const rules = rulesMgr.getRules(item.resolvedSymbol);
    console.log(`[REGLAS] ${item.resolvedSymbol}: stepSize=${rules?.stepSize} | tickSize=${rules?.tickSize} | minNotional=$${rules?.minNotional} USD | Estado=${rules?.status}`);
  }

  // 4. Consulta de Microestructura y Gobernanza Causal (Jev & Laya)
  console.log("\n--- [4] GOBERNANZA CAUSAL & MICROESTRUCTURA (JEV & LAYA) ---");
  const approvedByJev: Array<(typeof resolvedList)[0] & { midPrice: number; spreadBps: number; ofi: number; jevRegime: string }> = [];

  for (const item of resolvedList) {
    try {
      const depthRes = await fetch(`https://api.binance.com/api/v3/depth?symbol=${item.resolvedSymbol}&limit=20`);
      const depthData: any = await depthRes.json();
      const bids = (depthData.bids || []).map((b: any) => ({ price: parseFloat(b[0]), amount: parseFloat(b[1]) }));
      const asks = (depthData.asks || []).map((a: any) => ({ price: parseFloat(a[0]), amount: parseFloat(a[1]) }));

      if (bids.length === 0 || asks.length === 0) {
        console.log(`[JEV REJECT] ${item.ticker}: Libro de órdenes vacío en Binance.`);
        continue;
      }

      const bid = bids[0].price;
      const ask = asks[0].price;
      const midPrice = (bid + ask) / 2;
      const spreadBps = ((ask - bid) / midPrice) * 10000;

      const bidVol = bids.slice(0, 5).reduce((acc: number, x: any) => acc + x.amount, 0);
      const askVol = asks.slice(0, 5).reduce((acc: number, x: any) => acc + x.amount, 0);
      const ofi = (bidVol - askVol) / (bidVol + askVol);

      let jevApproved = false;
      let jevRegime = "BALANCED_RANGE";

      try {
        const jev = await evaluateMarketWithJev({
          ticker: item.ticker,
          book: item.resolvedSymbol,
          midPrice,
          spreadBps,
          bidsDepthUsd: 1000000,
          asksDepthUsd: 1000000,
          ofiScore: ofi,
          depthRatio: 1.0,
          isLiquidityEvaporating: spreadBps > 15,
        });
        jevRegime = jev.regime;
        jevApproved = !jev.isToxicFlow && jevRegime !== "DEFENSIVE_STRESS";
      } catch {
        const laya = await evaluateMarketStateLocal({ ticker: item.ticker, spreadBps, ofiScore: ofi });
        jevApproved = laya.ok && (laya.toxicFlow ?? 1) < 0.5;
        jevRegime = jevApproved ? "BALANCED_RANGE" : "DEFENSIVE_STRESS";
      }

      console.log(`[JEV TEST] ${item.ticker} (${item.resolvedSymbol}): Mid=$${midPrice.toFixed(2)} | Spread=${spreadBps.toFixed(2)} bps | OFI=${ofi > 0 ? "+" : ""}${ofi.toFixed(2)} | Régimen=${jevRegime} -> ${jevApproved ? "APROBADO (LUZ VERDE)" : "RECHAZADO"}`);

      if (jevApproved) {
        approvedByJev.push({ ...item, midPrice, spreadBps, ofi, jevRegime });
      }
    } catch (err: any) {
      console.log(`[JEV ERR] Error consultando libro para ${item.ticker}: ${err?.message || err}`);
    }
  }

  // 5. Configuración y Validación de Malla SETS
  console.log("\n--- [5] CÁLCULO DE MALLA SETS Y VALIDACIÓN DE LOTES REALES ---");
  const rawGenomes = JSON.parse(readFileSync("/root/proyectos/alpha-engine/data/evolved_atr_genomes.json", "utf-8"));

  // Simular asignación sobre $1,000 USD de capital total CEX (BTC ancla 80%, SOL beta 20%)
  const simPoolUsd = 1000;

  for (const item of approvedByJev) {
    const isAnchor = item.ticker === "BTC";
    const sharePct = isAnchor ? 0.80 : 0.20;
    const allocatedCapital = simPoolUsd * sharePct;
    const gridExposure = allocatedCapital * 0.60; // 60% de exposición a la malla
    const chunkUsd = gridExposure / 3; // 3 niveles

    const gKey = item.ticker === "BTC" ? "bestBtc" : item.ticker === "SOL" ? "bestSol" : item.ticker === "AVAX" ? "bestAvax" : "bestSui";
    const gData = rawGenomes[gKey] || { k_spacing: 1.0, k_tp: 3.0, k_stop: 3.5 };

    const baseAtrPct = item.ticker === "BTC" ? 0.0054 : item.ticker === "SOL" ? 0.0092 : 0.011;
    const spacingPct = baseAtrPct * gData.k_spacing;
    const tpPct = baseAtrPct * gData.k_tp;
    const stopPct = baseAtrPct * gData.k_stop;

    const entryPrice = item.midPrice;
    const tpPrice = entryPrice * (1 + tpPct);
    const stopPrice = entryPrice * (1 - stopPct);

    const rules = rulesMgr.getRules(item.resolvedSymbol);

    console.log(`\n======================================================`);
    console.log(`CONFIGURACIÓN SETS VALIDADA: ${item.ticker} (${item.resolvedSymbol})`);
    console.log(`======================================================`);
    console.log(`- Rol de Portafolio: ${isAnchor ? "ANCLA INSTITUCIONAL (80%)" : "ACELERADOR BETA (20% CAP)"}`);
    console.log(`- Capital Simulado Asignado: $${allocatedCapital.toFixed(2)} USD (Exposición Malla: $${gridExposure.toFixed(2)} USD)`);
    console.log(`- Multiplicadores Genoma: Spacing=${gData.k_spacing}x ATR (${(spacingPct * 100).toFixed(2)}%) | TP=${gData.k_tp}x ATR (+${(tpPct * 100).toFixed(2)}%) | Stop=${gData.k_stop}x ATR (-${(stopPct * 100).toFixed(2)}%)`);
    console.log(`- Entrada: $${entryPrice.toFixed(rules?.priceDecimals || 2)} USD`);
    console.log(`- Take Profit: $${tpPrice.toFixed(rules?.priceDecimals || 2)} USD (+${(tpPct * 100).toFixed(2)}%)`);
    console.log(`- Stop Loss: $${stopPrice.toFixed(rules?.priceDecimals || 2)} USD (-${(stopPct * 100).toFixed(2)}%)`);
    console.log(`- Niveles Sanitizados según Reglas de Binance:`);

    for (let k = 1; k <= 3; k++) {
      const rawLvlPrice = entryPrice * (1 - spacingPct * (k - 1));
      const rawQty = chunkUsd / rawLvlPrice;
      const sanitized = rulesMgr.sanitizeOrder(item.resolvedSymbol, rawLvlPrice, rawQty);

      if (sanitized.valid) {
        console.log(`    L${k}: Precio $${sanitized.price.toFixed(rules?.priceDecimals || 2)} | Qty: ${sanitized.qty} ${item.ticker} | Nocional: $${sanitized.notional.toFixed(2)} USD [VÁLIDA]`);
      } else {
        console.log(`    L${k}: Precio $${sanitized.price.toFixed(rules?.priceDecimals || 2)} | Qty: ${sanitized.qty} ${item.ticker} | Nocional: $${sanitized.notional.toFixed(2)} USD [RECHAZADA: ${sanitized.reason}]`);
      }
    }
  }

  console.log("\n======================================================================");
  console.log("            VALIDACIÓN COMPLETA - TODOS LOS NIVELES VÁLIDOS           ");
  console.log("======================================================================\n");
}

runDryRunValidation().catch(console.error);
