/**
 * Conector dinamico de Watchlist para el Daemon
 */

import { existsSync, readFileSync } from "node:fs";

export interface ResearchCandidate {
  ticker: string;
  name: string;
  action_bias: "ACCUMULATE" | "NEUTRAL" | "REDUCE" | "AVOID";
  timeframe_days: number;
  max_entry_price_usd: number;
  invalidation_price_usd: number;
  current_mc_usd: number;
  fdv_usd: number;
  unlock_pressure_next_90d_pct: number;
  real_yield_pct: number;
  primary_catalyst: string;
  biggest_risk: string;
  research_score_1_to_10: number;
}

export interface ResearchWatchlist {
  timestamp: string;
  market_regime: string;
  market_leverage_state?: string;
  candidates: ResearchCandidate[];
}

export function loadActiveWatchlist(filePath = "./data/research_watchlist.json"): ResearchWatchlist | null {
  const candidatePaths = [
    filePath,
    "/home/user/proyectos/alpha-engine/data/research_watchlist.json",
    "/root/proyectos/alpha-engine/data/research_watchlist.json",
  ];

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8");
        return JSON.parse(raw);
      } catch (err) {
        console.error("Error leyendo research_watchlist.json:", err);
      }
    }
  }
  return null;
}
