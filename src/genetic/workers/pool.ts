// Pool de Worker Threads que distribuye la evaluacion genetica entre los hilos de CPU
import { Worker } from "node:worker_threads";
import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Genome } from "../bot.js";
import type { Individual, WalkForwardWindow } from "../evolution.js";
import type { MarketEvolutionContext } from "./evaluation-worker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_PATH = join(__dirname, "evaluation-worker.ts");

export class ParallelGeneticPool {
  private threadCount: number;

  constructor(threads?: number) {
    // Detecta los 22 hilos en compute-node o usa los disponibles
    this.threadCount = threads || Math.max(1, Math.min(cpus().length, 22));
  }

  public async evaluateBatch(
    genomes: Array<{ id: number; genome: Genome }>,
    candles: Array<[number, number, number, number, number, number]>,
    windows: WalkForwardWindow[],
    context?: MarketEvolutionContext
  ): Promise<Individual[]> {
    if (genomes.length === 0) return [];

    const numWorkers = Math.min(this.threadCount, genomes.length);
    const chunkSize = Math.ceil(genomes.length / numWorkers);
    const workers: Worker[] = [];
    const promises: Promise<Individual[]>[] = [];

    for (let i = 0; i < numWorkers; i++) {
      const chunk = genomes.slice(i * chunkSize, (i + 1) * chunkSize);
      if (chunk.length === 0) continue;

      const workerPromise = new Promise<Individual[]>((resolve, reject) => {
        const worker = new Worker(WORKER_PATH);
        workers.push(worker);

        worker.on("message", (res: Individual[]) => {
          worker.terminate();
          resolve(res);
        });

        worker.on("error", (err) => {
          worker.terminate();
          reject(err);
        });

        worker.postMessage({
          genomes: chunk,
          candles,
          windows,
          context,
        });
      });

      promises.push(workerPromise);
    }

    const resultsArray = await Promise.all(promises);
    return resultsArray.flat();
  }
}
