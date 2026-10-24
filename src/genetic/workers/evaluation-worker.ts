// Worker individual para evaluar un lote de genomas en paralelo
import { parentPort } from "node:worker_threads";
import { backtest, type BotMetrics, type Genome } from "../bot.js";
import { passesGate, type WalkForwardWindow } from "../evolution.js";
import { makeSeries, type PriceSeries } from "../series.js";

export interface MarketEvolutionContext {
  regime?: string; // DEFENSIVE_STRESS | BALANCED_RANGE | AGGRESSIVE_ACCUMULATION
  fundingRatePct?: number; // Tasa de fondeo de futuros en %
  ofiScore?: number; // Order Flow Imbalance (-1.0 a +1.0)
}

function downsideDeviation(returns: number[], target = 0): number {
  const badReturns = returns.filter((r) => r < target).map((r) => Math.pow(r - target, 2));
  if (badReturns.length === 0) return 0.0005;
  return Math.sqrt(badReturns.reduce((a, b) => a + b, 0) / badReturns.length);
}

/**
 * Calculo de Sortino Ratio autentico con inyeccion de contexto macro/micro (OFI, Funding, Regimen Jev)
 */
function calculateSortinoFitness(
  m: BotMetrics,
  returns: number[],
  family: number,
  ctx?: MarketEvolutionContext
): number {
  const dd = downsideDeviation(returns, 0);
  const sortino = dd > 0 ? m.ret / dd : m.ret;
  const tradePenalty = m.trades < 3 ? 0.20 : 0;

  let baseFit = sortino * 0.15 + m.ret * 0.5 - m.maxDD * 0.8 - tradePenalty;

  // Moduladores de Contexto Institucional:
  if (ctx) {
    // 1. Modulador de Regimen Jev
    if (ctx.regime === "DEFENSIVE_STRESS") {
      // En estres defensivo, castigar con rigor el drawdown para evitar pérdidas asimétricas
      // y exigir un Payoff >= 1.20 para filtrar genomas de micro-ganancias con pérdidas grandes
      baseFit -= m.maxDD * 1.5;
      if (m.payoff < 1.20) baseFit -= 0.40;
    } else if (ctx.regime === "AGGRESSIVE_ACCUMULATION") {
      // En acumulacion agresiva, premiar genomas con alto winRate y captura de tendencia
      baseFit += m.winRate * 0.10;
    }

    // 2. Modulador de Tasa de Fondeo (Apalancamiento de Derivados)
    if (ctx.fundingRatePct && ctx.fundingRatePct > 0.03) {
      // Sobre-apalancamiento al alza (Long Crowded): penalizar fuertemente familias MOMENTUM (0) y VOL BREAKOUT (2)
      if (family === 0 || family === 2) {
        baseFit -= 0.15; // Desincentiva perseguir rupturas alcistas vulnerables a liquidacion masiva
      }
    } else if (ctx.fundingRatePct && ctx.fundingRatePct < -0.02) {
      // Short Squeeze potencial: favorecer entradas de reversion a la media o rotura
      if (family === 1) {
        baseFit += 0.08;
      }
    }

    // 3. Modulador de Order Flow Imbalance (Laya Microstructure)
    if (ctx.ofiScore !== undefined) {
      if (ctx.ofiScore > 0.40) {
        // Presion compradora sostenida: premiar retorno total
        baseFit += m.ret * 0.2;
      } else if (ctx.ofiScore < -0.40) {
        // Presion vendedora: penalizar exposicion prolongada
        baseFit -= m.exposure * 0.15;
      }
    }
  }

  return baseFit;
}

if (parentPort) {
  parentPort.on("message", (msg: {
    genomes: Array<{ id: number; genome: Genome }>;
    candles: Array<[number, number, number, number, number, number]>;
    windows: WalkForwardWindow[];
    context?: MarketEvolutionContext;
  }) => {
    const series = makeSeries(msg.candles);
    const results = [];

    for (const item of msg.genomes) {
      const primaryWindow = msg.windows[0];
      const { metrics: train, tradeReturns } = backtest(item.genome, series, primaryWindow.trainFrom, primaryWindow.trainTo);

      const valResults: BotMetrics[] = [];
      let passedCount = 0;

      for (const win of msg.windows) {
        const { metrics: val } = backtest(item.genome, series, win.valFrom, win.valTo);
        valResults.push(val);
        if (passesGate(val)) passedCount++;
      }

      const passWalkForward = passedCount >= Math.ceil(msg.windows.length / 2);
      const fit = calculateSortinoFitness(train, tradeReturns, item.genome.family, msg.context);

      results.push({
        id: item.id,
        genome: item.genome,
        train,
        valResults,
        fit,
        passWalkForward,
      });
    }

    parentPort!.postMessage(results);
  });
}
