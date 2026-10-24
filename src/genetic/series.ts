// Series de precios causales y rolling stats

export interface PriceSeries {
  readonly n: number;
  readonly time: Float64Array;
  readonly open: Float64Array;
  readonly high: Float64Array;
  readonly low: Float64Array;
  readonly close: Float64Array;
  readonly volume: Float64Array;
  readonly _cache: Map<number, { mean: Float64Array; std: Float64Array; hh: Float64Array }>;
}

export function makeSeries(candles: Array<[number, number, number, number, number, number]>): PriceSeries {
  const n = candles.length;
  const s: PriceSeries = {
    n,
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
    _cache: new Map(),
  };
  candles.forEach((c, i) => {
    s.time[i] = c[0];
    s.open[i] = c[1];
    s.high[i] = c[2];
    s.low[i] = c[3];
    s.close[i] = c[4];
    s.volume[i] = c[5];
  });
  return s;
}

export function rolling(s: PriceSeries, L: number) {
  let r = s._cache.get(L);
  if (r) return r;
  const { n, close, high } = s;
  const mean = new Float64Array(n).fill(NaN);
  const std = new Float64Array(n).fill(NaN);
  const hh = new Float64Array(n).fill(NaN);
  let sum = 0;
  let sum2 = 0;

  for (let j = 0; j < n; j++) {
    sum += close[j];
    sum2 += close[j] * close[j];
    if (j >= L) {
      sum -= close[j - L];
      sum2 -= close[j - L] * close[j - L];
    }
    if (j >= L - 1) {
      const m = sum / L;
      mean[j] = m;
      std[j] = Math.sqrt(Math.max(0, sum2 / L - m * m));
    }
  }

  const dq: number[] = [];
  for (let j = 0; j < n; j++) {
    if (j >= L) hh[j] = high[dq[0]];
    while (dq.length && high[dq[dq.length - 1]] <= high[j]) dq.pop();
    dq.push(j);
    while (dq[0] <= j - L) dq.shift();
  }

  r = { mean, std, hh };
  s._cache.set(L, r);
  return r;
}

export function zscore(s: PriceSeries, L: number, j: number): number {
  const r = rolling(s, L);
  const sd = r.std[j];
  return sd > 0 ? (s.close[j] - r.mean[j]) / sd : 0;
}
