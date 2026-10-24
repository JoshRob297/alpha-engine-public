/**
 * Backtest Institucional de 2 Meses Reales: Comparativa Estática vs Adaptativa (Térmica)
 * Prueba sobre 1,440 horas de Binance Spot (BTC, SOL, AERO)
 * 
 * Modos Evaluados:
 * 1. MODO ESTÁTICO (Genoma base fijo sin modulación)
 * 2. MODO ADAPTATIVO (Overlay térmico de ATR + escalado dinámico de Spacing y Stop)
 */

import { BinanceHistoricalFeeder } from "../cex/binance-history.js";
import { MarketRulesManager } from "../cex/market-rules.js";
import { MarketTemperatureMonitor } from "../guardrails/market-temperature.js";
import { GridBot, type Genome, FEE, signal } from "../genetic/bot.js";
import { readFileSync } from "node:fs";

class AdaptiveGridBot extends GridBot {
  public baseHistoricalAtr: number;
  public tickerName: string;

  constructor(genome: Genome, equity: number, tickerName: string, baseAtr: number) {
    super(genome, equity);
    this.tickerName = tickerName;
    this.baseHistoricalAtr = baseAtr;
  }

  // Sobrescribir step para incorporar la modulación térmica al abrir
  override step(s: any, i: number, toxicFlow = 0, bookState?: any) {
    if (bookState && this.checkCircuitBreaker(bookState)) return;

    if (!this.inPos && i > 14 && toxicFlow < 0.70 && !this.circuitBreakerActive) {
      const sig = signal(this.g, s, i - 1);
      if (sig.ok) {
        // Extraer ventana reciente de precios
        const priceWindow: number[] = [];
        for (let j = Math.max(0, i - 15); j <= i; j++) {
          priceWindow.push(s.close[j]);
        }
        const temp = MarketTemperatureMonitor.getTemperature(this.tickerName, priceWindow, this.baseHistoricalAtr);
        this._open(s.open[i], i, this.currentExposureCap, temp.stopMultiplier, temp.spacingMultiplier);
      }
    }

    if (this.inPos) {
      for (const L of this.levels) {
        if (!L.filled && s.low[i] <= L.price && toxicFlow < 0.85 && !this.circuitBreakerActive) {
          this._fill(L, L.price, i);
        }
      }
      this.tp = this.avg * (1 + this.g.tp);
      if (s.low[i] <= this.stop) this._close(this.stop, i, "STOP");
      else if (s.high[i] >= this.tp) this._close(this.tp, i, "TP");
    }

    const eq = this.equity(s.close[i]);
    this.peak = Math.max(this.peak, eq);
    this.maxDD = Math.max(this.maxDD, 1 - eq / this.peak);
    this.bars++;
    if (this.inPos) this.exposed++;
  }
}

async function runComparativeBacktest() {
  console.log("======================================================================");
  console.log("     COMPARATIVA: MALLA ESTÁTICA VS MALLA ADAPTATIVA TÉRMICA (60 DÍAS) ");
  console.log("           Periodo: 1,440 Velas de 1h Reales de Binance Spot          ");
  console.log("======================================================================\n");

  const rulesMgr = new MarketRulesManager();
  await rulesMgr.syncSymbols(["BTCUSDT", "SOLUSDT", "AEROUSDT"]);

  const rawGenomes = JSON.parse(readFileSync("/root/proyectos/alpha-engine/data/evolved_atr_genomes.json", "utf-8"));

  const portfolioAllocations: Record<string, { capital: number; gKey: string; baseAtr: number }> = {
    BTC: { capital: 700, gKey: "bestBtc", baseAtr: 0.0054 },
    SOL: { capital: 150, gKey: "bestSol", baseAtr: 0.0092 },
    AERO: { capital: 150, gKey: "bestSui", baseAtr: 0.0120 },
  };

  const staticResults: any[] = [];
  const adaptiveResults: any[] = [];

  for (const ticker of ["BTC", "SOL", "AERO"]) {
    const symbol = `${ticker}USDT`;
    const alloc = portfolioAllocations[ticker];

    const series = await BinanceHistoricalFeeder.fetchHistoricalSeries(symbol, 1440, 1000);
    if (!series || series.close.length < 1200) continue;

    const totalBars = series.close.length;
    const splitIndex = Math.floor(totalBars / 2);
    const gData = rawGenomes[alloc.gKey] || { k_spacing: 1.0, k_tp: 3.0, k_stop: 3.5 };

    const genome: Genome = {
      family: 0,
      lookback: 24,
      entryZ: 0.8,
      levels: 3,
      spacing: alloc.baseAtr * gData.k_spacing,
      mult: 1.1,
      tp: alloc.baseAtr * gData.k_tp,
      stop: alloc.baseAtr * gData.k_stop,
    };

    // 1. Simulación Estática
    const botStaticM1 = new GridBot(genome, alloc.capital);
    for (let i = 1; i < splitIndex; i++) botStaticM1.step(series, i);
    botStaticM1.flatten(series, splitIndex - 1);

    const botStaticM2 = new GridBot(genome, alloc.capital);
    for (let i = splitIndex; i < totalBars; i++) botStaticM2.step(series, i);
    botStaticM2.flatten(series, totalBars - 1);

    const botStaticFull = new GridBot(genome, alloc.capital);
    for (let i = 1; i < totalBars; i++) botStaticFull.step(series, i);
    botStaticFull.flatten(series, totalBars - 1);

    staticResults.push({
      ticker,
      m1Pnl: botStaticM1.cash - alloc.capital,
      m2Pnl: botStaticM2.cash - alloc.capital,
      fullPnl: botStaticFull.cash - alloc.capital,
      fullPct: ((botStaticFull.cash - alloc.capital) / alloc.capital) * 100,
      trades: botStaticFull.metrics().trades,
      maxDD: botStaticFull.metrics().maxDD * 100,
      winRate: botStaticFull.metrics().winRate * 100,
    });

    // 2. Simulación Adaptativa Térmica
    const botAdaptM1 = new AdaptiveGridBot(genome, alloc.capital, ticker, alloc.baseAtr);
    for (let i = 1; i < splitIndex; i++) botAdaptM1.step(series, i);
    botAdaptM1.flatten(series, splitIndex - 1);

    const botAdaptM2 = new AdaptiveGridBot(genome, alloc.capital, ticker, alloc.baseAtr);
    for (let i = splitIndex; i < totalBars; i++) botAdaptM2.step(series, i);
    botAdaptM2.flatten(series, totalBars - 1);

    const botAdaptFull = new AdaptiveGridBot(genome, alloc.capital, ticker, alloc.baseAtr);
    for (let i = 1; i < totalBars; i++) botAdaptFull.step(series, i);
    botAdaptFull.flatten(series, totalBars - 1);

    adaptiveResults.push({
      ticker,
      m1Pnl: botAdaptM1.cash - alloc.capital,
      m2Pnl: botAdaptM2.cash - alloc.capital,
      fullPnl: botAdaptFull.cash - alloc.capital,
      fullPct: ((botAdaptFull.cash - alloc.capital) / alloc.capital) * 100,
      trades: botAdaptFull.metrics().trades,
      maxDD: botAdaptFull.metrics().maxDD * 100,
      winRate: botAdaptFull.metrics().winRate * 100,
    });
  }

  // --- REPORTE COMPARATIVO POR ACTIVO ---
  console.log("\n======================================================================");
  console.log("            COMPARATIVA DETALLADA POR ACTIVO (60 DÍAS)                ");
  console.log("======================================================================\n");

  for (let idx = 0; idx < staticResults.length; idx++) {
    const s = staticResults[idx];
    const a = adaptiveResults[idx];

    console.log(`>>> ${s.ticker}:`);
    console.log(`    ESTÁTICO:   PnL Total: ${s.fullPnl >= 0 ? "+" : ""}$${s.fullPnl.toFixed(2)} USD (${s.fullPct >= 0 ? "+" : ""}${s.fullPct.toFixed(2)}%) | WinRate: ${s.winRate.toFixed(1)}% | MaxDD: ${s.maxDD.toFixed(2)}% | Trades: ${s.trades}`);
    console.log(`    ADAPTATIVO: PnL Total: ${a.fullPnl >= 0 ? "+" : ""}$${a.fullPnl.toFixed(2)} USD (${a.fullPct >= 0 ? "+" : ""}${a.fullPct.toFixed(2)}%) | WinRate: ${a.winRate.toFixed(1)}% | MaxDD: ${a.maxDD.toFixed(2)}% | Trades: ${a.trades}`);

    const deltaPnl = a.fullPnl - s.fullPnl;
    const deltaDD = s.maxDD - a.maxDD;
    console.log(`    -> IMPACTO: ${deltaPnl >= 0 ? "+" : ""}$${deltaPnl.toFixed(2)} USD de mejora neta | Reducción de Drawdown: ${deltaDD >= 0 ? "+" : ""}${deltaDD.toFixed(2)}%\n`);
  }

  // --- REPORTE CONSOLIDADO DE CARTERA ($1,000 USD) ---
  console.log("======================================================================");
  console.log("        BALANCE CONSOLIDADO DE CARTERA ($1,000 USD)                   ");
  console.log("======================================================================\n");

  const totalStaticPnl = staticResults.reduce((acc, r) => acc + r.fullPnl, 0);
  const totalStaticPct = (totalStaticPnl / 1000) * 100;

  const totalAdaptPnl = adaptiveResults.reduce((acc, r) => acc + r.fullPnl, 0);
  const totalAdaptPct = (totalAdaptPnl / 1000) * 100;

  console.log(`- MODO ESTÁTICO (Sin Adaptación Térmica):`);
  console.log(`    Resultado Neto 60 Días: ${totalStaticPnl >= 0 ? "+" : ""}$${totalStaticPnl.toFixed(2)} USD (${totalStaticPct >= 0 ? "+" : ""}${totalStaticPct.toFixed(2)}%)`);

  console.log(`\n- MODO ADAPTATIVO (Overlay Térmico Dinámico):`);
  console.log(`    Resultado Neto 60 Días: ${totalAdaptPnl >= 0 ? "+" : ""}$${totalAdaptPnl.toFixed(2)} USD (${totalAdaptPct >= 0 ? "+" : ""}${totalAdaptPct.toFixed(2)}%)`);

  const netGainUsd = totalAdaptPnl - totalStaticPnl;
  const netGainPct = totalAdaptPct - totalStaticPct;
  console.log(`\n----------------------------------------------------------------------`);
  console.log(`MEJORA NETA TOTAL CON LA MALLA ADAPTATIVA: +$${netGainUsd.toFixed(2)} USD (+${netGainPct.toFixed(2)}% adicional sobre $1,000)`);
  console.log(`======================================================================\n`);
}

runComparativeBacktest().catch(console.error);
