import { describe, expect, test } from "bun:test";
import { buildDataset } from "./canonical.js";
import { runAudit } from "./audit-run.js";

function makeTrades(n: number, winRate: number, winPct: number, lossPct: number, notional = 250, feesPct = 0.002) {
  const trades = [];
  // Intercalado determinista (LCG): si se agrupan todas las victorias primero, el
  // bootstrap por bloques reporta --correctamente-- una incertidumbre enorme.
  let state = 7919;
  const next = () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
  for (let i = 0; i < n; i++) {
    const isWin = next() < winRate;
    const pnlPct = isWin ? winPct : -lossPct;
    const gross = (notional * pnlPct) / 100;
    trades.push({
      ts: new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString(),
      venue: "CEX" as const,
      symbol: "BTCUSDT",
      grossPnlUsd: Math.round(gross * 100) / 100,
      feesUsd: Math.round(notional * feesPct * 100) / 100,
      netPnlUsd: 0,
    });
  }
  return trades;
}

const dataset = (trades: any[]) => buildDataset({ source: "test", adapter: "generic", account: { capitalUsd: 1000 }, trades });

describe("runAudit", () => {
  test("estrategia sin edge -> REFUTADO", () => {
    // 80% WR con payoff 1:10: el breakeven es ~96%, el binomial rechaza.
    const r = runAudit(dataset(makeTrades(160, 0.8, 0.45, 4.5)), { capitalUsd: 1000 });
    expect(r.verdict).toBe("REFUTADO");
    expect(r.inference!.binomialPValue).toBeLessThan(0.05);
    expect(r.inference!.bootstrap.ci95HighUsd).toBeLessThan(0);
    expect(r.sample!.deficitPp).toBeGreaterThan(5);
  });

  test("estrategia con edge -> NO REFUTADO", () => {
    const r = runAudit(dataset(makeTrades(250, 0.55, 2.0, 1.0)), { capitalUsd: 1000 });
    expect(r.verdict).toBe("NO REFUTADO");
    expect(r.inference!.bootstrap.ci95LowUsd).toBeGreaterThan(0);
    expect(r.walkForward!.positiveFolds).toBeGreaterThanOrEqual(3);
  });

  test("datos insuficientes -> NO AUDITABLE (sin veredicto)", () => {
    const trades = Array.from({ length: 20 }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString(),
      venue: "CEX" as const,
      symbol: "BTC",
      netPnlUsd: 5,
    }));
    const r = runAudit(dataset(trades), { capitalUsd: 1000 });
    expect(r.verdict).toBe("NO AUDITABLE");
    expect(r.sample).toBeNull();
    expect(r.limitations.join(" ")).toContain("solo traen PnL reportado");
  });

  test("calidad PARTIAL se declara en las limitaciones y se emite veredicto", () => {
    const trades = makeTrades(120, 0.8, 0.45, 4.5).map((t, i) => (i % 3 === 0 ? { ...t, feesUsd: undefined, grossPnlUsd: t.grossPnlUsd } : t));
    const r = runAudit(dataset(trades), { capitalUsd: 1000 });
    expect(r.dataQuality.sufficiency).toBe("PARTIAL");
    expect(r.limitations.join(" ")).toContain("PARTIAL");
    expect(r.verdict).not.toBe("NO AUDITABLE");
  });

  test("ventana OOS filtra la muestra", () => {
    const trades = makeTrades(200, 0.8, 0.45, 4.5);
    const r = runAudit(dataset(trades), { capitalUsd: 1000, oosStart: trades[100].ts });
    expect(r.sample!.closed).toBeLessThan(200);
    expect(r.sample!.closed).toBeGreaterThan(50);
  });

  test("sin trades posteriores al OOS -> NO AUDITABLE", () => {
    const trades = makeTrades(50, 0.8, 0.45, 4.5);
    const r = runAudit(dataset(trades), { capitalUsd: 1000, oosStart: "2030-01-01T00:00:00Z" });
    expect(r.verdict).toBe("NO AUDITABLE");
  });

  test("incluye escalado y limitaciones cuando hay capital", () => {
    const r = runAudit(dataset(makeTrades(160, 0.8, 0.45, 4.5)), { capitalUsd: 1000 });
    expect(r.scaling).not.toBeNull();
    expect(r.scaling!.points.length).toBe(5);
    expect(r.limitations.join(" ")).toContain("profundidad asumida");
  });
});
