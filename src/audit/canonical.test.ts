import { describe, expect, test } from "bun:test";
import { adaptAlphaEngineState } from "./adapters/alpha-engine.js";
import { adaptGeneric } from "./adapters/generic.js";
import { assessDataQuality, buildDataset, deriveNetPnl, toAuditTrades, type CanonicalTrade } from "./canonical.js";

describe("derivacion de PnL", () => {
  test("con precios, cantidad y costes el neto es derivado", () => {
    const d = deriveNetPnl({ qty: 2, entryPrice: 100, exitPrice: 110, feesUsd: 1, slippageUsd: 0.2, netPnlUsd: 999 });
    expect(d.grossPnlUsd).toBe(20);
    expect(d.netPnlUsd).toBe(18.8);
    expect(d.source).toBe("derived");
  });

  test("bruto declarado + costes tambien es derivado", () => {
    const d = deriveNetPnl({ grossPnlUsd: 20, feesUsd: 1.5, netPnlUsd: 20 });
    expect(d.netPnlUsd).toBe(18.5);
    expect(d.source).toBe("derived");
  });

  test("solo neto declarado: reportado, no verificable", () => {
    const d = deriveNetPnl({ netPnlUsd: 5 });
    expect(d.netPnlUsd).toBe(5);
    expect(d.source).toBe("reported");
  });

  test("bruto conocido sin costes: mixto (no se afirman costes)", () => {
    const d = deriveNetPnl({ grossPnlUsd: 20, netPnlUsd: 20 });
    expect(d.netPnlUsd).toBe(20);
    expect(d.source).toBe("mixed");
  });
});

const trade = (over: Partial<CanonicalTrade> = {}): CanonicalTrade => ({
  ts: "2026-10-01T00:00:00Z",
  venue: "CEX",
  symbol: "BTC",
  grossPnlUsd: 10,
  feesUsd: 1,
  slipageUsd: 0,
  netPnlUsd: 9,
  pnlSource: "derived",
  ...over,
} as CanonicalTrade);

describe("compuerta de suficiencia", () => {
  test("dataset completo es SUFFICIENT", () => {
    const q = assessDataQuality(Array.from({ length: 10 }, () => trade()));
    expect(q.sufficiency).toBe("SUFFICIENT");
    expect(q.coveragePct).toBe(100);
  });

  test("sin costes es PARTIAL y lo explica", () => {
    const q = assessDataQuality(Array.from({ length: 10 }, () => trade({ feesUsd: undefined, pnlSource: "mixed" })));
    expect(q.sufficiency).toBe("PARTIAL");
    expect(q.reasons.join(" ")).toContain("sin costes");
  });

  test("con la mitad reportada baja a PARTIAL", () => {
    const list = [
      ...Array.from({ length: 5 }, () => trade()),
      ...Array.from({ length: 5 }, () => trade({ pnlSource: "reported", grossPnlUsd: undefined, feesUsd: undefined })),
    ];
    const q = assessDataQuality(list);
    expect(q.sufficiency).toBe("PARTIAL");
    expect(q.rowsWithReportedPnlOnly).toBe(5);
  });

  test("sin timestamps es INSUFFICIENT", () => {
    const q = assessDataQuality([trade({ ts: "no-es-fecha" })]);
    expect(q.sufficiency).toBe("INSUFFICIENT");
  });

  test("sin trades es INSUFFICIENT", () => {
    expect(assessDataQuality([]).sufficiency).toBe("INSUFFICIENT");
  });

  test("menos del 50% derivado es INSUFFICIENT", () => {
    const list = [
      ...Array.from({ length: 2 }, () => trade()),
      ...Array.from({ length: 8 }, () => trade({ pnlSource: "reported", grossPnlUsd: undefined, feesUsd: undefined })),
    ];
    expect(assessDataQuality(list).sufficiency).toBe("INSUFFICIENT");
  });
});

describe("adaptador generico (formato de terceros)", () => {
  const csv = [
    "ticket;open_time;symbol;type;lots;open_price;close_price;commission;swap;profit",
    "1;2026-09-01 10:00:00;BTCUSD;buy;0.1;80000;80800;-1.2;-0.3;80",
    "2;2026-09-02 11:00:00;SOLUSD;buy;2;100;98;-1.5;0;-4",
  ].join("\n");

  test("parsea CSV con punto y coma, timestamps sin zona y costes separados", () => {
    const ds = adaptGeneric(csv, {
      source: "mt4.csv",
      format: "csv",
      delimiter: ";",
      mapping: {
        ts: "open_time",
        symbol: "symbol",
        qty: "lots",
        entryPrice: "open_price",
        exitPrice: "close_price",
        pnlNet: "profit",
        pnlKind: "gross",
        fees: "commission",
        extraCosts: ["swap"],
        costSign: "negative",
      },
    });
    expect(ds.trades.length).toBe(2);
    // MT4 reporta `profit` BRUTO: el neto resta commission + swap
    expect(ds.trades[0].netPnlUsd).toBeCloseTo(80 - 1.2 - 0.3, 4);
    expect(ds.trades[1].netPnlUsd).toBeCloseTo(-4 - 1.5, 4);
    expect(ds.trades[0].ts).toBe("2026-09-01T10:00:00.000Z");
    expect(ds.quality.sufficiency).toBe("SUFFICIENT");
  });

  test("PnL declarado como neto: se conserva como afirmacion y se contrasta", () => {
    const json = JSON.stringify([
      { time: 1767225600, pair: "BTCUSDT", qty: 1, buy: 100, sell: 110, fee: 2, net: 8 },
      { time: 1767225600, pair: "BTCUSDT", qty: 1, buy: 100, sell: 110, fee: 2, net: 7.9 },
    ]);
    const ds = adaptGeneric(json, {
      source: "bot.json",
      mapping: { ts: "time", symbol: "pair", qty: "qty", entryPrice: "buy", exitPrice: "sell", fees: "fee", pnlNet: "net", pnlKind: "net" },
    });
    expect(ds.trades[0].netPnlUsd).toBeCloseTo(8, 4); // derivado: 10 - 2
    expect(ds.issues.some((i) => i.includes("Discrepancia"))).toBe(true); // el segundo declara 7.9
  });

  test("JSON pretty-printed de varias lineas se detecta como json (no jsonl)", () => {
    const pretty = JSON.stringify([{ t: "2026-10-01T00:00:00Z", s: "BTC", pnl: 1, fee: 0.1 }], null, 2);
    const ds = adaptGeneric(pretty, {
      source: "pretty.json",
      mapping: { ts: "t", symbol: "s", pnlNet: "pnl", pnlKind: "gross", fees: "fee" },
    });
    expect(ds.trades.length).toBe(1);
    expect(ds.issues).toEqual([]);
  });

  test("JSONL y mapeo de venue", () => {
    const jsonl = [
      JSON.stringify({ t: "2026-10-01T00:00:00Z", s: "AERO", pnl: 1.5, fee: 0.1, market: "dex" }),
      JSON.stringify({ t: "2026-10-02T00:00:00Z", s: "AERO", pnl: -0.5, fee: 0.1, market: "dex" }),
    ].join("\n");
    const ds = adaptGeneric(jsonl, {
      source: "x.jsonl",
      mapping: { ts: "t", symbol: "s", pnlNet: "pnl", pnlKind: "gross", fees: "fee", venue: "market" },
    });
    expect(ds.trades.length).toBe(2);
    expect(ds.trades[0].venue).toBe("DEX_LP");
    expect(ds.trades[0].netPnlUsd).toBeCloseTo(1.4, 4);
  });

  test("filas sin timestamp se descartan y se reportan", () => {
    const ds = adaptGeneric(JSON.stringify([{ s: "BTC", pnl: 1 }, { t: "2026-10-01T00:00:00Z", s: "BTC", pnl: 2, fee: 0 }]), {
      source: "y.json",
      mapping: { ts: "t", symbol: "s", pnlNet: "pnl", pnlKind: "gross", fees: "fee" },
    });
    expect(ds.trades.length).toBe(1);
    expect(ds.issues.join(" ")).toContain("sin timestamp");
  });
});

describe("adaptador del motor propio y puente al pipeline", () => {
  test("mapea el estado y respeta costes ausentes en trades viejos", () => {
    const state = {
      totalCapitalUsd: 200,
      equity: { reconciledUsd: 195.9 },
      history: [
        { id: "a", timestamp: "2026-10-20T00:00:00Z", venue: "BINANCE_SPOT", assetOrPool: "BTCUSDT", action: "TAKE_PROFIT", price: 81000, amount: 0.001, pnlNet: 1.2, feePaidUsd: 0.16, slippageUsd: 0.02 },
        { id: "b", timestamp: "2026-10-21T00:00:00Z", venue: "BASE_DEX", assetOrPool: "WETH-CBBTC", action: "DEX_ACTIVITY", price: 0.03, amount: 10, pnlNet: 0.5 },
      ],
    };
    const ds = adaptAlphaEngineState(state);
    expect(ds.trades.length).toBe(2);
    expect(ds.trades[0].netPnlUsd).toBeCloseTo(1.02, 4);
    expect(ds.quality.rowsWithFees).toBe(1);
    expect(ds.quality.sufficiency).toBe("PARTIAL"); // el trade DEX no trae costes
    expect(ds.account.capitalUsd).toBe(200);
  });

  test("el puente produce timestamp y PnL neto para el pipeline estadistico", () => {
    const ds = buildDataset({
      source: "s",
      adapter: "generic",
      trades: [{ ts: "2026-10-01T00:00:00Z", venue: "CEX", symbol: "BTC", grossPnlUsd: 10, feesUsd: 1, netPnlUsd: 10 }],
    });
    const bridged = toAuditTrades(ds);
    expect(bridged[0].pnlNet).toBe(9);
    expect(bridged[0].timestamp).toBe("2026-10-01T00:00:00Z");
  });
});
