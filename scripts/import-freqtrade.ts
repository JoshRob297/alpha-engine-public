#!/usr/bin/env bun
/**
 * Importador de backtests de Freqtrade -> trades canonicos para `alpha-audit`.
 *
 * Freqtrade exporta `backtest-result-*.json` con `strategy.<Nombre>.trades[]`. Este importador
 * calcula los costes desde `fee_open`/`fee_close` (Freqtrade reporta `profit_abs` NETO, pero
 * deja las fees como tasas) y emite un JSON listo para el adaptador generico, junto con el
 * mapeo exacto a usar.
 *
 * Advertencia que imprime el propio importador: un backtest es IN-SAMPLE. La auditoria mide
 * robustez interna (bootstrap, walk-forward, costes), no evidencia out-of-sample.
 *
 * Uso:
 *   bun run scripts/import-freqtrade.ts --file backtest-result.json [--strategy Nombre] \
 *     [--out trades.json] [--mapping mapping.json] [--json]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { adaptFreqtradeBacktest } from "../src/audit/adapters/freqtrade.js";

const get = (flag: string, def?: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const file = get("--file");
const wanted = get("--strategy");
const out = get("--out");
const mappingOut = get("--mapping");
const asJson = process.argv.includes("--json");

if (!file || !existsSync(file)) {
  console.error("Uso: --file <backtest-result.json> [--strategy Nombre] [--out trades.json] [--mapping mapping.json] [--json]");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(file, "utf-8"));

let adapted;
try {
  adapted = adaptFreqtradeBacktest(raw, wanted, file);
} catch (err: any) {
  console.error(`[IMPORT] ${err?.message || err}`);
  process.exit(2);
}

const { strategy, strategies, meta, dataset } = adapted;
const trades = dataset.trades.map((t) => ({
  ts: t.ts,
  symbol: t.symbol,
  qty: t.qty,
  entryPrice: t.entryPrice,
  exitPrice: t.exitPrice,
  feesUsd: t.feesUsd,
  grossPnlUsd: t.grossPnlUsd,
  netPnlUsd: t.netPnlUsd,
}));

const mapping = {
  ts: "ts",
  symbol: "symbol",
  qty: "qty",
  entryPrice: "entryPrice",
  exitPrice: "exitPrice",
  fees: "feesUsd",
  pnlNet: "netPnlUsd",
  pnlKind: "net",
};

const payload = {
  source: file,
  strategy,
  strategies,
  tradesCount: trades.length,
  window: { from: meta.from, to: meta.to },
  math: { grossUsd: meta.grossUsd, feesUsd: meta.feesUsd, netUsd: meta.netUsd, wins: meta.wins, losses: meta.losses },
  reported: {
    profitAbs: meta.reportedProfitAbs,
    profitFactor: meta.reportedProfitFactor,
    winrate: meta.reportedWinrate,
    maxDrawdownAccount: meta.reportedMaxDrawdown,
    startingBalance: meta.startingBalance,
    currency: meta.currency,
  },
  quality: dataset.quality,
  warning: "Backtest IN-SAMPLE: mide robustez interna, no evidencia out-of-sample.",
  trades,
};

if (out) writeFileSync(out, JSON.stringify(payload, null, 2), "utf-8");
if (mappingOut) writeFileSync(mappingOut, JSON.stringify(mapping, null, 2), "utf-8");

if (asJson) {
  console.log(JSON.stringify({ ...payload, mapping }, null, 2));
} else {
  console.log(`=== IMPORT FREQTRADE ===`);
  console.log(`Estrategia: ${strategy} | trades cerrados: ${trades.length} | disponibles: ${strategies.join(", ")}`);
  console.log(`Ventana: ${payload.window.from} -> ${payload.window.to}`);
  console.log(`Matematica: bruto $${meta.grossUsd} - fees $${meta.feesUsd} = NETO $${meta.netUsd} (${meta.wins}W/${meta.losses}L)`);
  console.log(`Clave: ${payload.warning}`);
  if (out) console.log(`Trades canonicos: ${out}`);
  if (mappingOut) console.log(`Mapeo: ${mappingOut}`);
  console.log("");
  console.log("Siguiente paso:");
  console.log(
    `  alpha-audit --file ${out ?? "<trades.json>"} --adapter generic --mapping ${mappingOut ?? "<mapping.json>"} --capital 1000 --label freqtrade-${strategy.toLowerCase()}`
  );
}
