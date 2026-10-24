// Motor Evolutivo con Walk-Forward Validation Movil (Anti-Overfitting)

import { backtest, type BotMetrics, type Genome } from "./bot.js";
import { gauss, mulberry32 } from "./rng.js";
import type { PriceSeries } from "./series.js";

export interface GeneDef {
  key: keyof Genome;
  label: string;
  min: number;
  max: number;
  int?: boolean;
}

export const GENES: GeneDef[] = [
  { key: "family", label: "FAMILY", min: 0, max: 3, int: true },
  { key: "lookback", label: "LOOKBACK", min: 10, max: 200, int: true },
  { key: "entryZ", label: "ENTRY Z", min: 0.2, max: 2.5 },
  { key: "levels", label: "GRID LEVELS", min: 2, max: 8, int: true },
  { key: "spacing", label: "SPACING", min: 0.003, max: 0.03 },
  { key: "mult", label: "SIZE MULT", min: 1, max: 2 },
  { key: "tp", label: "TAKE PROFIT", min: 0.003, max: 0.04 },
  { key: "stop", label: "STOP", min: 0.01, max: 0.12 },
];

const fix = (G: GeneDef, v: number) => {
  v = Math.min(G.max, Math.max(G.min, v));
  return G.int ? Math.round(v) : v;
};

export function randomGenome(r: () => number): Genome {
  const g: any = {};
  for (const G of GENES) {
    g[G.key] = G.int
      ? Math.min(G.max, G.min + Math.floor(r() * (G.max - G.min + 1)))
      : G.min + r() * (G.max - G.min);
  }
  return g as Genome;
}

export function crossover(a: Genome, b: Genome, r: () => number): Genome {
  const g: any = {};
  for (const G of GENES) {
    g[G.key] = r() < 0.5 ? a[G.key] : b[G.key];
  }
  return g as Genome;
}

export function mutate(g: Genome, r: () => number, p = 0.18, scale = 0.12): Genome {
  const out: any = { ...g };
  for (const G of GENES) {
    if (r() >= p) continue;
    if (G.key === "family") {
      if (r() < 0.2) out.family = Math.floor(r() * 4);
    } else {
      out[G.key] = fix(G, g[G.key] + gauss(r) * scale * (G.max - G.min));
    }
  }
  return out as Genome;
}

export function fitness(m: BotMetrics, tradeReturns: number[] = []): number {
  // Sortino Ratio Autentico: Penaliza solo la volatilidad a la baja
  const badReturns = tradeReturns.filter((r) => r < 0).map((r) => r * r);
  const downsideDev =
    badReturns.length > 0
      ? Math.sqrt(badReturns.reduce((a, b) => a + b, 0) / badReturns.length)
      : 0.0005; // Fallback con varianza minima para evitar division por cero

  const sortino = downsideDev > 0 ? m.ret / downsideDev : m.ret;
  // Componente de estabilidad + penalizacion estricta de drawdown y trades minimos
  const tradePenalty = m.trades < 3 ? 0.20 : 0;
  return sortino * 0.15 + m.ret * 0.5 - m.maxDD * 0.8 - tradePenalty;
}

export function passesGate(m: BotMetrics): boolean {
  return m.ret > 0.005 && m.maxDD < 0.06 && m.trades >= 2 && m.winRate >= 0.50 && m.payoff >= 0.80;
}

export interface WalkForwardWindow {
  trainFrom: number;
  trainTo: number;
  valFrom: number;
  valTo: number;
}

export interface Individual {
  id: number;
  genome: Genome;
  train: BotMetrics;
  valResults: BotMetrics[];
  fit: number;
  passWalkForward: boolean; // Supero la mayoria de las ventanas fuera de muestra
}

export class EvolutionEngine {
  public s: PriceSeries;
  public r: () => number;
  public N: number;
  public E: number;
  public I: number;
  public gen: number;
  public nextId: number;
  public leader: Individual | null;
  public pop: Individual[];
  public windows: WalkForwardWindow[];

  constructor(
    series: PriceSeries,
    { seed = 2026, pop = 64, elite = 6, immigrants = 6, numWindows = 3 } = {}
  ) {
    this.s = series;
    this.r = mulberry32(seed);
    this.N = pop;
    this.E = elite;
    this.I = immigrants;
    this.gen = 0;
    this.nextId = 1;
    this.leader = null;
    this.pop = [];

    // PUNTO CIEGO 1 CORREGIDO: Construir 3 ventanas deslizantes Walk-Forward
    this.windows = this._buildWalkForwardWindows(series.n, numWindows);

    for (let k = 0; k < this.N; k++) {
      this.pop.push(this._make(randomGenome(this.r)));
    }
    this._rank();
  }

  /**
   * Genera ventanas deslizantes Walk-Forward sobre las velas
   */
  _buildWalkForwardWindows(totalBars: number, numWindows: number): WalkForwardWindow[] {
    const windows: WalkForwardWindow[] = [];
    const minTrain = Math.floor(totalBars * 0.45);
    const stepSize = Math.floor((totalBars - minTrain) / numWindows);

    for (let w = 0; w < numWindows; w++) {
      const trainFrom = 50; // Warmup de indicadores
      const trainTo = minTrain + w * stepSize;
      const valFrom = trainTo;
      const valTo = Math.min(totalBars, valFrom + stepSize);

      windows.push({ trainFrom, trainTo, valFrom, valTo });
    }
    return windows;
  }

  _make(genome: Genome): Individual {
    // Entrenar en la ventana base
    const primaryWindow = this.windows[0];
    const { metrics: train, tradeReturns } = backtest(genome, this.s, primaryWindow.trainFrom, primaryWindow.trainTo);

    // Validar en TODAS las ventanas Walk-Forward (Out-of-sample rodante)
    const valResults: BotMetrics[] = [];
    let passedCount = 0;

    for (const win of this.windows) {
      const { metrics: val } = backtest(genome, this.s, win.valFrom, win.valTo);
      valResults.push(val);
      if (passesGate(val)) {
        passedCount++;
      }
    }

    // Regla de rigor: Debe haber pasado al menos 2 de 3 ventanas fuera de muestra
    const passWalkForward = passedCount >= Math.ceil(this.windows.length / 2);

    return {
      id: this.nextId++,
      genome,
      train,
      valResults,
      fit: fitness(train, tradeReturns),
      passWalkForward,
    };
  }

  _rank() {
    this.pop.sort((a, b) => b.fit - a.fit);
    // El lider SOLO puede ser un individuo que paso el Walk-Forward
    const passed = this.pop.filter((x) => x.passWalkForward);
    if (passed.length > 0) {
      this.leader = passed[0];
    }
  }

  _tournament(k = 3): Individual {
    let best = this.pop[Math.floor(this.r() * this.pop.length)];
    for (let i = 1; i < k; i++) {
      const c = this.pop[Math.floor(this.r() * this.pop.length)];
      if (c.fit > best.fit) best = c;
    }
    return best;
  }

  step(): { gen: number; bestFit: number; leader: Individual | null } {
    this.gen++;
    const elites = this.pop.slice(0, this.E);
    const offspring: Individual[] = [];

    while (offspring.length < this.N - this.E - this.I) {
      const a = this._tournament();
      const b = this._tournament();
      const child = crossover(a.genome, b.genome, this.r);
      const mutated = mutate(child, this.r);
      offspring.push(this._make(mutated));
    }

    const immigrants: Individual[] = [];
    for (let k = 0; k < this.I; k++) {
      immigrants.push(this._make(randomGenome(this.r)));
    }

    this.pop = [...elites, ...offspring, ...immigrants];
    this._rank();

    return {
      gen: this.gen,
      bestFit: this.pop[0].fit,
      leader: this.leader,
    };
  }
}
