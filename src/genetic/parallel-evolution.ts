// Motor Evolutivo Asincrono Paralelo para Compute-node (22 hilos) con Sortino Ratio
import { FAMILIES, type BotMetrics, type Genome } from "./bot.js";
import { gauss, mulberry32 } from "./rng.js";
import type { PriceSeries } from "./series.js";
import { ParallelGeneticPool } from "./workers/pool.js";
import { GENES, randomGenome, crossover, mutate, type Individual, type WalkForwardWindow } from "./evolution.js";
import type { MarketEvolutionContext } from "./workers/evaluation-worker.js";

export class ParallelEvolutionEngine {
  public s: PriceSeries;
  public candles: Array<[number, number, number, number, number, number]>;
  public r: () => number;
  public N: number;
  public E: number;
  public I: number;
  public gen: number;
  public nextId: number;
  public leader: Individual | null;
  public pop: Individual[];
  public windows: WalkForwardWindow[];
  public context?: MarketEvolutionContext;
  private pool: ParallelGeneticPool;

  constructor(
    candles: Array<[number, number, number, number, number, number]>,
    series: PriceSeries,
    { seed = 2026, pop = 128, elite = 8, immigrants = 8, numWindows = 3, threads = 22, context }: {
      seed?: number;
      pop?: number;
      elite?: number;
      immigrants?: number;
      numWindows?: number;
      threads?: number;
      context?: MarketEvolutionContext;
    } = {}
  ) {
    this.candles = candles;
    this.s = series;
    this.r = mulberry32(seed);
    this.N = pop;
    this.E = elite;
    this.I = immigrants;
    this.gen = 0;
    this.nextId = 1;
    this.leader = null;
    this.pop = [];
    this.context = context;
    this.pool = new ParallelGeneticPool(threads);

    this.windows = this._buildWalkForwardWindows(series.n, numWindows);
  }

  private _buildWalkForwardWindows(totalBars: number, numWindows: number): WalkForwardWindow[] {
    const windows: WalkForwardWindow[] = [];
    const minTrain = Math.floor(totalBars * 0.45);
    const stepSize = Math.floor((totalBars - minTrain) / numWindows);

    for (let w = 0; w < numWindows; w++) {
      const trainFrom = 50;
      const trainTo = minTrain + w * stepSize;
      const valFrom = trainTo;
      const valTo = Math.min(totalBars, valFrom + stepSize);
      windows.push({ trainFrom, trainTo, valFrom, valTo });
    }
    return windows;
  }

  public async initPopulation(): Promise<void> {
    const initialGenomes: Array<{ id: number; genome: Genome }> = [];
    for (let k = 0; k < this.N; k++) {
      initialGenomes.push({ id: this.nextId++, genome: randomGenome(this.r) });
    }

    this.pop = await this.pool.evaluateBatch(initialGenomes, this.candles, this.windows, this.context);
    this._rank();
  }

  private _rank() {
    this.pop.sort((a, b) => b.fit - a.fit);
    const passed = this.pop.filter((x) => x.passWalkForward);
    if (passed.length > 0) {
      this.leader = passed[0];
    }
  }

  private _tournament(k = 3): Individual {
    let best = this.pop[Math.floor(this.r() * this.pop.length)];
    for (let i = 1; i < k; i++) {
      const c = this.pop[Math.floor(this.r() * this.pop.length)];
      if (c.fit > best.fit) best = c;
    }
    return best;
  }

  public async step(): Promise<{ gen: number; bestFit: number; leader: Individual | null }> {
    this.gen++;
    const elites = this.pop.slice(0, this.E);
    const nextGenomes: Array<{ id: number; genome: Genome }> = [];

    // Generar cruces y mutaciones
    while (nextGenomes.length < this.N - this.E - this.I) {
      const a = this._tournament();
      const b = this._tournament();
      const child = crossover(a.genome, b.genome, this.r);
      const mutated = mutate(child, this.r);
      nextGenomes.push({ id: this.nextId++, genome: mutated });
    }

    // Inmigrantes
    for (let k = 0; k < this.I; k++) {
      nextGenomes.push({ id: this.nextId++, genome: randomGenome(this.r) });
    }

    // Evaluacion masiva en paralelo a traves de los 22 hilos
    const evaluatedBatch = await this.pool.evaluateBatch(nextGenomes, this.candles, this.windows, this.context);

    this.pop = [...elites, ...evaluatedBatch];
    this._rank();

    return {
      gen: this.gen,
      bestFit: this.pop[0].fit,
      leader: this.leader,
    };
  }
}
