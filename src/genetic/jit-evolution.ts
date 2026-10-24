/**
 * Just-In-Time (JIT) Evolutionary Engine
 * Ejecuta optimización genética en caliente sobre el histórico real de Binance
 * para generar los multiplicadores SETS (k_spacing, k_tp, k_stop)
 * y validar la viabilidad del token antes de ser admitido en el portafolio.
 */

import { GridBot, type Genome, FEE } from "./bot.js";
import { GENES, randomGenome, crossover, mutate, fitness } from "./evolution.js";
import { mulberry32 } from "./rng.js";
import type { PriceSeries } from "./series.js";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { isTestEnvironment } from "../guardrails/env-guard.js";
import { isGenomeFrozen } from "../guardrails/measurement-window.js";

export interface EvolvedAtrGenomeResult {
  ticker: string;
  symbol: string;
  genome: Genome;
  k_spacing: number;
  k_tp: number;
  k_stop: number;
  k_discount: number;
  fitness: number;
  profitFactor: number;
  winRate: number;
  maxDrawdown: number;
  dataset: string;
  isViable: boolean;
  rejectReason?: string;
}

export class JitEvolutionEngine {
  /**
   * Calcula el ATR promedio de 14 periodos en una serie de precios
   */
  public static calculateMeanAtr(s: PriceSeries, period = 14): number {
    const trs: number[] = [];
    for (let i = 1; i < s.close.length; i++) {
      const tr = Math.max(
        s.high[i] - s.low[i],
        Math.abs(s.high[i] - s.close[i - 1]),
        Math.abs(s.low[i] - s.close[i - 1])
      );
      trs.push(tr / s.close[i]);
    }
    if (trs.length === 0) return 0.005;
    return trs.reduce((a, b) => a + b, 0) / trs.length;
  }

  /**
   * Ejecuta la evolución genética rápida en caliente
   */
  public static async evolveGenomeForAsset(
    ticker: string,
    symbol: string,
    series: PriceSeries,
    populationSize = 40,
    generations = 15
  ): Promise<EvolvedAtrGenomeResult> {
    const startTime = Date.now();
    console.log(`[JIT EVOLUTION] Iniciando evolución genética para ${ticker} (${series.close.length} horas de datos)...`);

    const rand = mulberry32(42 + ticker.charCodeAt(0));
    let population: Genome[] = [];

    // Generar población inicial
    for (let i = 0; i < populationSize; i++) {
      population.push(randomGenome(rand));
    }

    let bestGenome: Genome = population[0];
    let bestFit = -999;
    let bestMetrics: any = null;

    for (let gen = 0; gen < generations; gen++) {
      const evaluated = population.map((g) => {
        const bot = new GridBot(g, 1000);
        // Simular sobre la serie con comisiones reales de Binance Spot (0.10%)
        for (let i = 1; i < series.close.length; i++) {
          bot.step(series, i);
        }
        bot.flatten(series, series.close.length - 1);
        const m = bot.metrics();
        const fit = fitness(m, bot.getTradeReturns());
        return { g, fit, m };
      });

      // Ordenar por fitness descendente
      evaluated.sort((a, b) => b.fit - a.fit);

      if (evaluated[0].fit > bestFit) {
        bestFit = evaluated[0].fit;
        bestGenome = evaluated[0].g;
        bestMetrics = evaluated[0].m;
      }

      // Selección y cruce de la siguiente generación (elitismo top 20%)
      const nextGen: Genome[] = evaluated.slice(0, Math.floor(populationSize * 0.2)).map((e) => e.g);
      while (nextGen.length < populationSize) {
        const parentA = evaluated[Math.floor(rand() * (populationSize * 0.5))].g;
        const parentB = evaluated[Math.floor(rand() * (populationSize * 0.5))].g;
        const child = crossover(parentA, parentB, rand);
        nextGen.push(mutate(child, rand));
      }
      population = nextGen;
    }

    // Calcular multiplicadores k referenciados al ATR real del token
    const meanAtr = this.calculateMeanAtr(series);
    const k_spacing = parseFloat((bestGenome.spacing / meanAtr).toFixed(2));
    const k_tp = parseFloat((bestGenome.tp / meanAtr).toFixed(2));
    const k_stop = parseFloat((bestGenome.stop / meanAtr).toFixed(2));
    const k_discount = parseFloat(((bestGenome.spacing * 2) / meanAtr).toFixed(2));

    const winRate = parseFloat(((bestMetrics?.winRate || 0) * 100).toFixed(1));
    const maxDrawdown = parseFloat(((bestMetrics?.maxDD || 0) * 100).toFixed(1));
    const profitFactor = parseFloat((bestMetrics?.payoff || 1.0).toFixed(2));

    // Criterios de admisión institucional
    let isViable = true;
    let rejectReason: string | undefined = undefined;

    if (bestMetrics.trades < 5) {
      isViable = false;
      rejectReason = `Pocos trades generados en backtest (${bestMetrics.trades} trades)`;
    } else if (winRate < 60.0) {
      isViable = false;
      rejectReason = `WinRate insuficiente (${winRate}% < 60.0% requerido)`;
    } else if (maxDrawdown > 45.0) {
      isViable = false;
      rejectReason = `Drawdown histórico excesivo (${maxDrawdown}% > 45.0% límite)`;
    } else if (profitFactor < 1.4) {
      isViable = false;
      rejectReason = `Profit Factor bajo (${profitFactor} < 1.40 requerido)`;
    }

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

    const result: EvolvedAtrGenomeResult = {
      ticker,
      symbol,
      genome: bestGenome,
      k_spacing,
      k_tp,
      k_stop,
      k_discount,
      fitness: parseFloat(bestFit.toFixed(3)),
      profitFactor,
      winRate,
      maxDrawdown,
      dataset: `${series.close.length}h Binance ${symbol}`,
      isViable,
      rejectReason,
    };

    if (isViable) {
      console.log(
        `[JIT EVOLUTION SUCCESS] ${ticker}: Genoma optimizado en ${durationSec}s | Spacing=${k_spacing}x ATR | TP=${k_tp}x ATR | Stop=${k_stop}x ATR | WinRate: ${winRate}% | MaxDD: ${maxDrawdown}%`
      );
      this.persistGenome(result);
    } else {
      console.warn(`[JIT EVOLUTION REJECT] ${ticker}: Descartado para trading algorítmico. Motivo: ${rejectReason}`);
    }

    return result;
  }

  /**
   * Guarda de forma atómica el nuevo genoma en data/evolved_atr_genomes.json
   */
  public static persistGenome(result: EvolvedAtrGenomeResult) {
    // 1. Aislamiento de pruebas: bun test no escribe en el almacen de produccion.
    if (isTestEnvironment()) {
      console.log(
        `[JIT EVOLUTION SKIP] Entorno de pruebas: genoma ${result.ticker} no persistido en el almacen de produccion.`
      );
      return;
    }

    // 2. Ventana de medicion: con genomas congelados no se re-ajustan parametros.
    if (isGenomeFrozen()) {
      JitEvolutionEngine.quarantineGenome(
        result,
        "GENOME_FREEZE activo: ventana de medicion out-of-sample en curso"
      );
      return;
    }

    // 3. Rechazo de genomas degenerados (fitness de ajuste perfecto).
    // winRate 100% / profitFactor en el cap indican fitness degenerado, no calidad:
    // producen risk/reward inservibles (ej. k_tp 0.43 vs k_stop 8.39 => 1:19.5).
    const winRate = result.winRate ?? 0;
    const profitFactor = result.profitFactor ?? 0;
    const degenerate =
      winRate >= 99.5 ||
      profitFactor >= 9.98 ||
      !Number.isFinite(result.fitness) ||
      result.k_tp <= 0 ||
      result.k_stop <= 0;
    if (degenerate) {
      JitEvolutionEngine.quarantineGenome(
        result,
        `Genoma degenerado: winRate=${winRate}% profitFactor=${profitFactor} fitness=${result.fitness}`
      );
      return;
    }

    // 4. Dataset sintetico de tests (ej. "600h Binance TESTUSDT").
    if (/test/i.test(result.dataset || "") || /test/i.test(result.ticker || "")) {
      JitEvolutionEngine.quarantineGenome(result, `Dataset/ticker de prueba: ${result.dataset}`);
      return;
    }

    const genomeFilePath = join(process.cwd(), "data", "evolved_atr_genomes.json");
    try {
      let data: Record<string, any> = {};
      if (existsSync(genomeFilePath)) {
        data = JSON.parse(readFileSync(genomeFilePath, "utf-8"));
      }

      const key = `best${result.ticker.charAt(0).toUpperCase()}${result.ticker.slice(1).toLowerCase()}`;
      data[key] = {
        k_spacing: result.k_spacing,
        k_tp: result.k_tp,
        k_stop: result.k_stop,
        k_discount: result.k_discount,
        fitness: result.fitness,
        profitFactor: result.profitFactor,
        winRate: result.winRate,
        dataset: result.dataset,
      };
      data["updatedAt"] = new Date().toISOString();

      writeFileSync(genomeFilePath, JSON.stringify(data, null, 2), "utf-8");
      console.log(`[JIT EVOLUTION PERSIST] Genoma para ${result.ticker} guardado en data/evolved_atr_genomes.json`);
    } catch (err: any) {
      console.error(`[JIT EVOLUTION SAVE ERR] Fallo guardando genoma: ${err?.message || err}`);
    }
  }

  /**
   * Aparta un genoma rechazado a un archivo de cuarentena auditable en lugar de
   * descartarlo en silencio: el rechazo tambien es evidencia.
   */
  private static quarantineGenome(result: EvolvedAtrGenomeResult, reason: string) {
    try {
      const quarantinePath = join(process.cwd(), "data", "evolved_atr_genomes_rejected.jsonl");
      const record = {
        timestamp: new Date().toISOString(),
        reason,
        ticker: result.ticker,
        dataset: result.dataset,
        k_spacing: result.k_spacing,
        k_tp: result.k_tp,
        k_stop: result.k_stop,
        k_discount: result.k_discount,
        fitness: result.fitness,
        profitFactor: result.profitFactor,
        winRate: result.winRate,
      };
      appendFileSync(quarantinePath, JSON.stringify(record) + "\n", "utf-8");
      console.warn(`[JIT EVOLUTION REJECT] ${result.ticker}: genoma apartado a cuarentena. Motivo: ${reason}`);
    } catch (err: any) {
      console.error(`[JIT EVOLUTION QUARANTINE ERR] ${err?.message || err}`);
    }
  }
}
