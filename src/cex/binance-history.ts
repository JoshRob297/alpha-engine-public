/**
 * Binance Historical Kline Feeder
 * Descarga de forma eficiente y paginada hasta 2 años (17,520 velas de 1h)
 * de datos históricos reales de Binance Spot para alimentar el motor evolutivo.
 */

import { makeSeries, type PriceSeries } from "../genetic/series.js";

export class BinanceHistoricalFeeder {
  /**
   * Descarga velas de 1h hacia atrás desde el momento actual.
   * @param symbol Par de Binance (ej. "BTCUSDT", "NEARUSDT")
   * @param targetHours Cantidad de horas a descargar (default 17,520 = 2 años)
   * @param minRequiredHours Mínimo absoluto para considerar viable la optimización (default 2,160h = 90 días)
   */
  public static async fetchHistoricalSeries(
    symbol: string,
    targetHours = 17_520,
    minRequiredHours = 2_160
  ): Promise<PriceSeries | null> {
    const cleanSymbol = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    console.log(`[HISTORICAL FEEDER] Iniciando descarga de histórico para ${cleanSymbol} (Objetivo: ${targetHours}h)...`);

    const open: number[] = [];
    const high: number[] = [];
    const low: number[] = [];
    const close: number[] = [];
    const volume: number[] = [];

    // Cada llamada a Binance /api/v3/klines entrega máximo 1000 velas
    let endTime: number | undefined = undefined;
    const batchSize = 1000;
    let totalFetched = 0;

    const rawKlines: Array<{
      openTime: number;
      o: number;
      h: number;
      l: number;
      c: number;
      v: number;
    }> = [];

    const startTime = Date.now();

    while (totalFetched < targetHours) {
      const remaining = targetHours - totalFetched;
      const limit = Math.min(batchSize, remaining);

      let url = `https://api.binance.com/api/v3/klines?symbol=${cleanSymbol}&interval=1h&limit=${limit}`;
      if (endTime) {
        url += `&endTime=${endTime}`;
      }

      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) {
          console.warn(`[HISTORICAL FEEDER] Error en lote para ${cleanSymbol} (${res.status})`);
          break;
        }

        const data: any[][] = await res.json();
        if (!Array.isArray(data) || data.length === 0) {
          // Ya no hay velas más antiguas (token recién listado)
          break;
        }

        for (const k of data) {
          rawKlines.push({
            openTime: k[0],
            o: parseFloat(k[1]),
            h: parseFloat(k[2]),
            l: parseFloat(k[3]),
            c: parseFloat(k[4]),
            v: parseFloat(k[5]),
          });
        }

        totalFetched += data.length;
        // El nuevo endTime debe ser 1ms antes de la vela más antigua de este lote
        endTime = data[0][0] - 1;

        if (data.length < limit) {
          // Llegamos al origen del activo en Binance
          break;
        }

        // Breve pausa para respetar rate limit de Binance API pública
        await new Promise((resolve) => setTimeout(resolve, 80));
      } catch (err: any) {
        console.warn(`[HISTORICAL FEEDER] Excepción descargando lote para ${cleanSymbol}: ${err?.message || err}`);
        break;
      }
    }

    if (rawKlines.length < minRequiredHours) {
      console.warn(
        `[HISTORICAL FEEDER REJECT] ${cleanSymbol} solo cuenta con ${rawKlines.length} horas de datos en Binance (Mínimo requerido: ${minRequiredHours}h = 90 días).`
      );
      return null;
    }

    // Ordenar cronológicamente (las llamadas regresivas devuelven en reversa)
    rawKlines.sort((a, b) => a.openTime - b.openTime);

    const candles: Array<[number, number, number, number, number, number]> = [];
    const seen = new Set<number>();
    for (const k of rawKlines) {
      if (!seen.has(k.openTime)) {
        seen.add(k.openTime);
        candles.push([k.openTime, k.o, k.h, k.l, k.c, k.v]);
      }
    }

    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(
      `[HISTORICAL FEEDER SUCCESS] ${cleanSymbol}: Descargadas ${candles.length} horas de datos reales de Binance en ${durationSec}s.`
    );

    return makeSeries(candles);
  }
}
