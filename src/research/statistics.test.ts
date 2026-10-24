import { describe, expect, test } from "bun:test";
import {
  binomialBelowBreakevenPValue,
  binomialTwoSidedPValue,
  blockBootstrapMean,
  createSeededRandom,
  describeRiskProfile,
  effectiveSampleSize,
  estimateDaysToTarget,
  evaluateStopRule,
  lag1Autocorrelation,
  suggestBlockSize,
} from "./statistics.js";

describe("PRNG y autocorrelacion", () => {
  test("el PRNG sembrado es reproducible", () => {
    const a = createSeededRandom(42);
    const b = createSeededRandom(42);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).toEqual(seqB);
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  test("serie iid tiene autocorrelacion cercana a cero", () => {
    const rand = createSeededRandom(7);
    const x = Array.from({ length: 4000 }, () => rand() - 0.5);
    expect(Math.abs(lag1Autocorrelation(x))).toBeLessThan(0.06);
  });

  test("serie AR(1) con rho alto se detecta", () => {
    const rand = createSeededRandom(11);
    const x: number[] = [0];
    for (let i = 1; i < 2000; i++) x.push(0.8 * x[i - 1] + (rand() - 0.5));
    const rho = lag1Autocorrelation(x);
    expect(rho).toBeGreaterThan(0.7);
    expect(effectiveSampleSize(2000, rho)).toBeLessThan(400);
  });

  test("el tamano de bloque crece con la persistencia", () => {
    expect(suggestBlockSize(200, 0)).toBeLessThan(suggestBlockSize(200, 0.8));
  });
});

describe("bootstrap por bloques", () => {
  test("el IC contiene la media muestral", () => {
    const pnls = [-3.6, 0.5, 0.6, -3.4, 0.4, 0.7, -3.7, 0.3, 0.55, -3.5];
    const r = blockBootstrapMean(pnls, { iterations: 1500, seed: 1 });
    expect(r.meanUsd).toBeCloseTo(pnls.reduce((a, v) => a + v, 0) / pnls.length, 5);
    expect(r.ci95LowUsd).toBeLessThanOrEqual(r.meanUsd);
    expect(r.ci95HighUsd).toBeGreaterThanOrEqual(r.meanUsd);
  });

  test("con media claramente negativa el IC95% excluye cero", () => {
    const pnls = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? -4 : 0.6));
    const r = blockBootstrapMean(pnls, { iterations: 2000, seed: 3 });
    expect(r.ci95HighUsd).toBeLessThan(0);
    expect(r.significant).toBe(true);
  });

  test("la autocorrelacion ensancha el IC respecto de iid", () => {
    const rand = createSeededRandom(99);
    const correlated: number[] = [0];
    for (let i = 1; i < 300; i++) correlated.push(0.85 * correlated[i - 1] + (rand() - 0.5));
    const shuffled = [...correlated].sort(() => rand() - 0.5);
    const bsCorr = blockBootstrapMean(correlated, { iterations: 2000, seed: 5 });
    const bsIid = blockBootstrapMean(shuffled, { iterations: 2000, seed: 5 });
    const widthCorr = bsCorr.ci95HighUsd - bsCorr.ci95LowUsd;
    const widthIid = bsIid.ci95HighUsd - bsIid.ci95LowUsd;
    expect(widthCorr).toBeGreaterThan(widthIid);
  });

  test("muestra vacia no rompe", () => {
    const r = blockBootstrapMean([]);
    expect(r.meanUsd).toBe(0);
    expect(r.significant).toBe(false);
  });
});

describe("test binomial exacto", () => {
  test("p=0.5 con 5 de 10 no es significativo", () => {
    expect(binomialTwoSidedPValue(5, 10, 0.5)).toBeGreaterThan(0.9);
  });

  test("10 de 10 con p=0.5 es significativo", () => {
    expect(binomialTwoSidedPValue(10, 10, 0.5)).toBeLessThan(0.01);
  });

  test("win rate por debajo del breakeven con n grande da p bajo", () => {
    // Caso real de referencia: 93W/112 con breakeven 90.9%.
    const p = binomialBelowBreakevenPValue(93, 112, 90.9);
    expect(p).toBeLessThan(0.02);
  });

  test("win rate por encima del breakeven no rechaza", () => {
    const p = binomialBelowBreakevenPValue(110, 112, 90.9);
    expect(p).toBeGreaterThan(0.5);
  });
});

describe("perfil de riesgo", () => {
  test("detecta el perfil bimodal real y marca el t-test como inapropiado", () => {
    const pnls = [...Array(93).fill(0.58), ...Array(19).fill(-3.6)];
    const r = describeRiskProfile(pnls);
    expect(r.n).toBe(112);
    expect(r.winRatePct).toBeCloseTo(83.04, 1);
    expect(r.tTestUnsuitable).toBe(true);
    expect(r.unsuitabilityReasons.length).toBeGreaterThan(0);
    expect(r.payoffRatio).toBeGreaterThan(5);
  });

  test("perfil simetrico no marca inidoneidad", () => {
    const rand = createSeededRandom(3);
    const pnls = Array.from({ length: 200 }, () => rand() - 0.5);
    const r = describeRiskProfile(pnls);
    expect(r.tTestUnsuitable).toBe(false);
  });
});

describe("regla de parada", () => {
  const bootstrapNegative: any = { meanUsd: -0.018, ci95LowUsd: -0.037, ci95HighUsd: -0.001, significant: true, blockSize: 3, iterations: 4000, seed: 1 };

  test("con muestra corta no emite lectura", () => {
    const r = evaluateStopRule({ n: 12, expectancyUsd: -0.02, bootstrap: bootstrapNegative, binomialPValue: 0.01, minClosedForReading: 30 });
    expect(r.action).toBe("CONTINUE");
  });

  test("expectancy negativa con IC bajo cero y WR bajo breakeven significativo refuta", () => {
    const r = evaluateStopRule({ n: 112, expectancyUsd: -0.0179, bootstrap: bootstrapNegative, binomialPValue: 0.004, minClosedForReading: 30 });
    expect(r.action).toBe("REFUTED");
    expect(r.reasons.length).toBe(2);
  });

  test("expectancy negativa con IC bajo cero pero sin rechazo del WR recomienda parar", () => {
    const r = evaluateStopRule({ n: 112, expectancyUsd: -0.0179, bootstrap: bootstrapNegative, binomialPValue: 0.4, minClosedForReading: 30 });
    expect(r.action).toBe("STOP_RECOMMENDED");
  });

  test("IC que cruza cero mantiene la continuidad", () => {
    const mixed: any = { meanUsd: -0.01, ci95LowUsd: -0.03, ci95HighUsd: 0.01, significant: false, blockSize: 3, iterations: 4000, seed: 1 };
    const r = evaluateStopRule({ n: 60, expectancyUsd: -0.01, bootstrap: mixed, binomialPValue: 0.2, minClosedForReading: 30 });
    expect(r.action).toBe("CONTINUE");
  });
});

describe("ETA al objetivo", () => {
  test("calcula ritmo y fecha", () => {
    const e = estimateDaysToTarget(112, 24.17, 191);
    expect(e.ratePerDay).toBeCloseTo(4.63, 1);
    expect(e.daysNeeded).toBeGreaterThan(10);
    expect(e.etaIso).toBeTruthy();
  });

  test("sin cierres no estima", () => {
    expect(estimateDaysToTarget(0, 3, 191).etaIso).toBeNull();
  });
});
