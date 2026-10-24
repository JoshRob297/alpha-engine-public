/**
 * TypeSafe AI (Jev System One) Client Driver
 * Calibra el régimen de mercado, la exposición activa (20% - 60%)
 * y el espaciado de niveles usando decisiones estructuradas tipadas.
 */

export interface JevMarketJudgment {
  regime: "AGGRESSIVE_ACCUMULATION" | "BALANCED_RANGE" | "DEFENSIVE_STRESS";
  recommendedExposurePct: number; // 0.20 a 0.60
  spacingMultiplier: number;     // 0.8 a 1.8
  isToxicFlow: boolean;
  confidence: number;
}

export async function evaluateMarketWithJev(statePayload: {
  ticker: string;
  book: string;
  midPrice: number;
  spreadBps: number;
  bidsDepthUsd: number;
  asksDepthUsd: number;
  ofiScore: number;
  depthRatio: number;
  isLiquidityEvaporating: boolean;
}): Promise<JevMarketJudgment> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    // Fallback defensivo si no hay API key en el entorno
    return {
      regime: "BALANCED_RANGE",
      recommendedExposurePct: 0.40,
      spacingMultiplier: 1.0,
      isToxicFlow: false,
      confidence: 0.5,
    };
  }

  const promptState = JSON.stringify({
    market: statePayload.book,
    ticker: statePayload.ticker,
    mid_price_usd: statePayload.midPrice,
    spread_bps: statePayload.spreadBps,
    order_flow_imbalance_score: statePayload.ofiScore,
    depth_ratio_bid_vs_ask: statePayload.depthRatio,
    bids_depth_top3_usd: statePayload.bidsDepthUsd,
    asks_depth_top3_usd: statePayload.asksDepthUsd,
    liquidity_evaporating: statePayload.isLiquidityEvaporating,
  });

  try {
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: promptState,
        model: "jev-latest",
        questions: {
          regime: {
            type: "choice",
            instructions: "Determine the quantitative accumulation regime based on order book depth, spread and OFI",
            criteria: {
              "AGGRESSIVE_ACCUMULATION": "Healthy order book, low spread (<30 bps), solid bid support and positive or neutral OFI. Safe to deploy up to 60% capital.",
              "BALANCED_RANGE": "Normal market conditions, moderate depth. Safe for standard 40% - 45% exposure.",
              "DEFENSIVE_STRESS": "High spread (>40 bps), bid liquidity evaporating, or heavy negative OFI. Must retreat to defensive 20% exposure."
            }
          },
          toxic_hazard: {
            type: "noul",
            instructions: "Is there acute toxic flow, flash-crash risk or extreme book imbalance requiring immediate freeze?"
          }
        }
      }),
      signal: AbortSignal.timeout(3000), // Timeout de 3s para evitar congelamiento del loop
    });

    if (!res.ok) {
      console.warn(`[JEV API WARN]: Status ${res.status}`);
      return {
        regime: "BALANCED_RANGE",
        recommendedExposurePct: 0.40,
        spacingMultiplier: 1.0,
        isToxicFlow: false,
        confidence: 0.5,
      };
    }

    const data = await res.json();
    const regimeAns = data.answers?.regime;
    const toxicAns = data.answers?.toxic_hazard;

    const chosenRegime = regimeAns?.choice || "BALANCED_RANGE";
    const confidence = regimeAns?.confidence ?? 0.75;
    const toxicProb = toxicAns?.noul ?? 0;

    let exposure = 0.40;
    let spacingMult = 1.0;

    if (chosenRegime === "AGGRESSIVE_ACCUMULATION") {
      exposure = 0.60;
      spacingMult = 0.85; // Ordenes mas optimizadas
    } else if (chosenRegime === "DEFENSIVE_STRESS") {
      exposure = 0.20;
      spacingMult = 1.5;  // Espaciado mas defensivo y amplio
    } else {
      exposure = 0.45;
      spacingMult = 1.0;
    }

    return {
      regime: chosenRegime,
      recommendedExposurePct: exposure,
      spacingMultiplier: spacingMult,
      isToxicFlow: toxicProb > 0.65,
      confidence,
    };
  } catch (err) {
    console.error("[JEV CLIENT ERROR]:", err);
    return {
      regime: "BALANCED_RANGE",
      recommendedExposurePct: 0.40,
      spacingMultiplier: 1.0,
      isToxicFlow: false,
      confidence: 0.5,
    };
  }
}
