import { test, expect } from "bun:test";
import { ParallelGeneticPool } from "./pool.js";
import { makeSeries } from "../series.js";
import { randomGenome } from "../evolution.js";
import { mulberry32 } from "../rng.js";

test("ParallelGeneticPool reparte y evalua genomas correctamente", async () => {
  const dummyCandles: Array<[number, number, number, number, number, number]> = [];
  let p = 100;
  for (let i = 0; i < 200; i++) {
    p += (Math.random() - 0.49) * 2;
    dummyCandles.push([i * 3600000, p, p + 1, p - 1, p, 1000]);
  }

  const windows = [
    { trainFrom: 20, trainTo: 100, valFrom: 100, valTo: 150 },
    { trainFrom: 20, trainTo: 150, valFrom: 150, valTo: 200 },
  ];

  const r = mulberry32(42);
  const genomes = [
    { id: 1, genome: randomGenome(r) },
    { id: 2, genome: randomGenome(r) },
    { id: 3, genome: randomGenome(r) },
    { id: 4, genome: randomGenome(r) },
  ];

  const pool = new ParallelGeneticPool(4);
  const results = await pool.evaluateBatch(genomes, dummyCandles, windows);

  expect(results.length).toBe(4);
  expect(typeof results[0].fit).toBe("number");
  expect(typeof results[0].passWalkForward).toBe("boolean");
});
