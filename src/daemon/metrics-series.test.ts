import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeEquityDrift, appendEquitySample, readEquitySeries, type EquitySample } from "./metrics-series.js";

const tmpPath = () => join(mkdtempSync(join(tmpdir(), "equity-series-")), "series.jsonl");

const sample = (ts: string, extra: Partial<EquitySample> = {}): EquitySample => ({
  ts,
  capitalUsd: 200,
  realizedNetUsd: -2,
  deployedUsd: 100,
  capturedReserveUsd: 98,
  untradedReserveUsd: 0,
  reconciledUsd: 198,
  ...extra,
});

describe("serie de equity", () => {
  test("roundtrip de escritura y lectura", () => {
    const path = tmpPath();
    appendEquitySample(sample("2026-10-19T02:00:00Z"), { path });
    appendEquitySample(sample("2026-10-19T03:00:00Z"), { path });
    const series = readEquitySeries({ path });
    expect(series.length).toBe(2);
    expect(series[1].ts).toBe("2026-10-19T03:00:00Z");
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("rota el archivo al superar maxLines", () => {
    const path = tmpPath();
    for (let i = 0; i < 5; i++) appendEquitySample(sample(`2026-10-19T0${i}:00:00Z`), { path, maxLines: 3 });
    const series = readEquitySeries({ path });
    expect(series.length).toBeLessThanOrEqual(3);
    expect(readEquitySeries({ path: `${path}.1` }).length).toBeGreaterThan(0);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("ignora lineas corruptas", () => {
    const path = tmpPath();
    appendEquitySample(sample("2026-10-19T02:00:00Z"), { path });
    const fs = require("node:fs");
    fs.appendFileSync(path, "{no-json}\n", "utf-8");
    expect(readEquitySeries({ path }).length).toBe(1);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("serie consistente no marca anomalia", () => {
    const samples = [
      sample("2026-10-19T02:00:00Z"),
      sample("2026-10-19T03:00:00Z"),
      sample("2026-10-19T04:00:00Z", { realizedNetUsd: -2.1, reconciledUsd: 197.9 }),
    ];
    const a = analyzeEquityDrift(samples);
    expect(a.anomaly).toBe(false);
    expect(a.samples).toBe(3);
    expect(a.hoursCovered).toBeCloseTo(2, 3);
  });

  test("detecta pendiente de residuo (fuga en curso)", () => {
    // El equity 'reconciliado' se infla 1 USD por hora: residuo creciente.
    const samples = [
      sample("2026-10-19T02:00:00Z"),
      sample("2026-10-19T03:00:00Z", { capturedReserveUsd: 99, reconciledUsd: 199 }),
      sample("2026-10-19T04:00:00Z", { capturedReserveUsd: 100, reconciledUsd: 200 }),
      sample("2026-10-19T05:00:00Z", { capturedReserveUsd: 101, reconciledUsd: 201 }),
    ];
    const a = analyzeEquityDrift(samples);
    expect(a.anomaly).toBe(true);
    expect(a.lastResidualUsd).toBeCloseTo(3, 3);
    expect(a.residualSlopeUsdPerHour).toBeCloseTo(1, 2);
    expect(a.anomalyReasons.join(" ")).toContain("Pendiente del residuo");
  });

  test("marca anomalia si hay reparaciones o ventana invalida", () => {
    const a = analyzeEquityDrift([sample("2026-10-19T02:00:00Z", { repairs: 1, windowValid: false })]);
    expect(a.anomaly).toBe(true);
    expect(a.anomalyReasons.length).toBe(2);
  });

  test("reparaciones historicas anteriores a la ventana no disparan anomalia", () => {
    const samples = [
      sample("2026-10-19T02:00:00Z", { repairs: 3 }),
      sample("2026-10-19T03:00:00Z", { repairs: 3 }),
      sample("2026-10-19T04:00:00Z", { repairs: 3 }),
    ];
    const a = analyzeEquityDrift(samples);
    expect(a.anomaly).toBe(false);
  });

  test("serie vacia no rompe", () => {
    const a = analyzeEquityDrift([]);
    expect(a.samples).toBe(0);
    expect(a.anomaly).toBe(false);
  });
});
