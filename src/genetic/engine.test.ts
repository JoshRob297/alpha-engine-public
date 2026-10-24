import { test, expect } from "bun:test";
import { GridBot } from "./bot.js";
import { makeSeries } from "./series.js";
import { EvolutionEngine } from "./evolution.js";

test("GridBot respeta limite dinamico de exposicion hasta el 60%", () => {
  const genome = {
    family: 3,
    lookback: 20,
    entryZ: 1.5,
    levels: 3,
    spacing: 0.01,
    mult: 1.2,
    tp: 0.03,
    stop: 0.05,
  };

  const initialCash = 10000;
  const bot = new GridBot(genome, initialCash);
  bot._open(100, 0, 0.60);

  // La exposicion total de la malla nunca debe superar el 60% del equity inicial
  const totalGridExposure = bot.levels.reduce((acc, lvl) => acc + lvl.usd, 0);
  expect(totalGridExposure).toBeLessThanOrEqual(initialCash * 0.6001);
});

test("EvolutionEngine genera ventanas Walk-Forward validas", () => {
  const dummyCandles: Array<[number, number, number, number, number, number]> = [];
  let p = 100;
  for (let i = 0; i < 300; i++) {
    p += (Math.random() - 0.49) * 2;
    dummyCandles.push([i * 3600000, p, p + 1, p - 1, p, 1000]);
  }

  const series = makeSeries(dummyCandles);
  const engine = new EvolutionEngine(series, {
    pop: 10,
    elite: 2,
    immigrants: 2,
    numWindows: 3,
  });

  expect(engine.windows.length).toBe(3);
  expect(engine.windows[0].trainTo).toBeLessThan(engine.windows[1].trainTo);
});
