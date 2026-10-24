import { describe, it, expect } from "bun:test";
import { BinanceSymbolResolver } from "../cex/symbol-resolver.js";
import { BinanceHistoricalFeeder } from "../cex/binance-history.js";
import { JitEvolutionEngine } from "../genetic/jit-evolution.js";
import { makeSeries } from "../genetic/series.js";

describe.skipIf(process.env.OFFLINE === "1")("JIT Discovery & Auto-Evolution Pipeline Tests", () => {
  it("Resuelve dinámicamente símbolos líquidos en Binance Spot", async () => {
    // Probar activo no pre-configurado (ej. NEAR)
    const resolved = await BinanceSymbolResolver.resolveSymbol("NEAR");
    expect(resolved.isValid).toBe(true);
    expect(resolved.symbol).toBe("NEARUSDT");
    expect(resolved.status).toBe("TRADING");
    expect(resolved.volume24hUsd).toBeGreaterThan(1_000_000);
  });

  it("Rechaza tokens ficticios o inexistentes en Binance", async () => {
    const fake = await BinanceSymbolResolver.resolveSymbol("FAKEINEXISTENTTOKEN999");
    expect(fake.isValid).toBe(false);
    expect(fake.status).toBe("NOT_FOUND");
  });

  it("Descarga lote de velas de 1h de Binance y valida integridad", async () => {
    // Descargar muestra de 250 horas para test rápido
    const series = await BinanceHistoricalFeeder.fetchHistoricalSeries("NEARUSDT", 250, 100);
    expect(series).not.toBeNull();
    expect(series!.close.length).toBeGreaterThanOrEqual(100);
    expect(series!.open.length).toBe(series!.close.length);
    expect(series!.high.length).toBe(series!.close.length);
    expect(series!.low.length).toBe(series!.close.length);
    expect(series!.volume.length).toBe(series!.close.length);
  });

  it("Evoluciona genoma JIT para activo nuevo y calcula parámetros SETS", async () => {
    // Generar serie sintética de 600 barras para prueba unitaria
    const candles: Array<[number, number, number, number, number, number]> = [];
    let prev = 10.0;
    const now = Date.now() - 600 * 3600 * 1000;

    for (let i = 0; i < 600; i++) {
      const delta = (Math.sin(i * 0.1) * 0.02 + 0.001) * prev;
      const c = prev + delta;
      const h = Math.max(prev, c) * 1.005;
      const l = Math.min(prev, c) * 0.995;
      const v = 1000 + Math.random() * 500;
      candles.push([now + i * 3600 * 1000, prev, h, l, c, v]);
      prev = c;
    }

    const testSeries = makeSeries(candles);
    const evo = await JitEvolutionEngine.evolveGenomeForAsset("TESTTOKEN", "TESTUSDT", testSeries, 15, 5);

    expect(evo).toBeDefined();
    expect(evo.k_spacing).toBeGreaterThan(0);
    expect(evo.k_tp).toBeGreaterThan(0);
    expect(evo.k_stop).toBeGreaterThan(0);
    expect(evo.dataset).toContain("TESTUSDT");
  });
});
