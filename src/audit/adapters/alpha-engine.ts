/**
 * Adaptador de primera parte: estado del propio motor Alpha Engine -> dataset canonico.
 *
 * El `pnlNet` del ledger es BRUTO (verificado por `audit:pnl`); las fees y el slippage viven
 * en campos separados. Los trades anteriores a la correccion de octubre de 2026 no tienen
 * esos campos: la calidad del dataset lo refleja en vez de asumir costes.
 */

import { buildDataset, type CanonicalDataset } from "../canonical.js";

export function adaptAlphaEngineState(state: any, source = "engine_state.json"): CanonicalDataset {
  const history = Array.isArray(state?.history) ? state.history : [];
  const trades = history
    .filter((t: any) => t && t.timestamp)
    .map((t: any) => ({
      id: typeof t.id === "string" ? t.id : undefined,
      ts: String(t.timestamp),
      venue: t.venue === "BASE_DEX" ? ("DEX_LP" as const) : ("CEX" as const),
      symbol: String(t.assetOrPool ?? t.symbol ?? "UNKNOWN"),
      qty: typeof t.amount === "number" ? t.amount : undefined,
      exitPrice: typeof t.price === "number" ? t.price : undefined,
      grossPnlUsd: typeof t.pnlNet === "number" ? t.pnlNet : undefined,
      feesUsd: typeof t.feePaidUsd === "number" ? t.feePaidUsd : undefined,
      slippageUsd: typeof t.slippageUsd === "number" ? t.slippageUsd : undefined,
      netPnlUsd: typeof t.pnlNet === "number" ? t.pnlNet : 0,
    }));

  return buildDataset({
    source,
    adapter: "alpha-engine",
    account: {
      capitalUsd: typeof state?.totalCapitalUsd === "number" ? state.totalCapitalUsd : undefined,
      equityUsd: typeof state?.equity?.reconciledUsd === "number" ? state.equity.reconciledUsd : undefined,
    },
    trades,
  });
}
