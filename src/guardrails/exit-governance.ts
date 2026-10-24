import { evaluateMarketStateLocal } from './laya-client-local';
import { appendFileSync, existsSync } from 'fs';
import { getRegimePolicy, getAssetProfile } from './regime-policy';

export interface ExitGovernanceDecision {
  action: 'HOLD' | 'TAKE_PROFIT_PARTIAL' | 'TAKE_PROFIT_STANDARD' | 'FRONT_RUN_EXIT' | 'TRAILING_EXPANSION' | 'EMERGENCY_DELEVERAGE';
  reason: string;
  fractionToClose: number; // Fracción de la posición a liquidar (ej. 0.40 para 40%, 1.0 para 100%)
  adjustedTpPrice?: number;
  confidence: number;
}

export interface DistillationRecord {
  timestamp: string;
  source: "LIVE_PRODUCTION" | "PAPER_SIMULATION" | "UNIT_TEST";
  type: string;
  ticker: string;
  book: string;
  metrics: {
    currentGainPct: number;
    ofiScore: number;
    spreadBps: number;
    alreadyPartialTakenPct: number;
  };
  layaJudgment: {
    toxicFlow: number;
    meanReversion: number;
  };
  jevRegime: string;
  exitAction: string;
  fractionToClose: number;
  exitReason: string;
  /**
   * Origen de la senal que disparo la salida. Permite atribuir en vivo si el
   * gatillo lo puso el OFI crudo (gratis) o el juicio de Laya (toxicFlow):
   * sin esto, la contribucion de Laya no se puede medir a posteriori.
   */
  triggerSource?: "OFI" | "LAYA" | "BOTH" | "OTHER";
}

const DISTILLATION_LOG_PATH = existsSync('./data')
  ? './data/laya_distillation.jsonl'
  : existsSync('/home/user/proyectos/alpha-engine/data')
  ? '/home/user/proyectos/alpha-engine/data/laya_distillation.jsonl'
  : './data/laya_distillation.jsonl';

/**
 * Registra exclusivamente muestras legítimas de ejecución, descartando
 * automáticamente ejecuciones sintéticas de tests unitarios o ambientes CI.
 */
import { isTestEnvironment } from './env-guard.js';

export function recordDistillationSample(record: Omit<DistillationRecord, "source">): void {
  // 1. Detección estricta de entorno de tests (bun test, jest, vitest o NODE_ENV=test)
  if (isTestEnvironment()) {
    // ESTRICTO: Cero contaminación sintética en el dataset de entrenamiento
    return;
  }

  // 2. Discriminación de fuente de mercado real
  const mode = (process.env.EXECUTION_MODE as "LIVE" | "PAPER") || "PAPER";
  const source = mode === "LIVE" ? "LIVE_PRODUCTION" : "PAPER_SIMULATION";

  const fullRecord: DistillationRecord = {
    ...record,
    source,
  };

  try {
    appendFileSync(DISTILLATION_LOG_PATH, JSON.stringify(fullRecord) + "\n");
  } catch {}
}

/**
 * Validador Causal de Salidas Multi-Timeframe (DCA Out + Triple-Barrier Meta-Labeling)
 * Modula las salidas del Genoma según el régimen de Jev y la microestructura de Laya.
 * 
 * Reglas de Salida:
 * 1. TP1 Parcial (+1.20% a +1.50%): Si supera comisiones y Laya ve desaceleración (OFI < +0.20),
 *    vende el 50% para asegurar ganancia en stablecoin (Free-Roll).
 * 2. TP2 Parcial (+2.00% a +2.50%): Vende otro 30% asegurando ganancias acumuladas.
 * 3. Front-Run Exit: Si en cualquier momento con ganancia > +0.75% hay flujo tóxico (OFI < -0.50 o toxicFlow > 0.50),
 *    vende de inmediato para no devolver la ganancia al mercado.
 * 4. Trailing Expansion: Si hay impulso comprador neto masivo (OFI > +0.50), deja correr el remanente.
 */
export async function evaluateExitGovernance(
  ticker: string,
  book: string,
  entryAvgPrice: number,
  currentPrice: number,
  targetTpPrice: number,
  ofiScore: number,
  spreadBps: number,
  jevRegime: string = 'BALANCED_RANGE',
  alreadyPartialTakenPct: number = 0 // Cuánto porcentaje de la posición ya se cerró en parciales
): Promise<ExitGovernanceDecision> {
  const currentGainPct = ((currentPrice / entryAvgPrice) - 1) * 100;

  // 1. Consulta de microestructura ultrarrápida a Laya Local en Compute-node (< 1 ms)
  const layaJudgment = await evaluateMarketStateLocal({
    ticker,
    book,
    current_gain_pct: currentGainPct,
    ofi_score: ofiScore,
    spread_bps: spreadBps,
    jev_regime: jevRegime
  }, 1000);

  // En tests o si Laya no está en localhost, usamos el OFI puro sin detonar fail-safe falso
  const toxicFlow = layaJudgment.ok && layaJudgment.toxicFlow !== null ? layaJudgment.toxicFlow : (ofiScore < -0.50 ? 0.85 : 0.10);
  const meanReversion = layaJudgment.ok && layaJudgment.meanReversion !== null ? layaJudgment.meanReversion : 0.5;

  /**
   * Clasifica quien puso el gatillo de microestructura: OFI crudo (publico y gratis)
   * o el juicio de Laya (toxicFlow). Necesario para atribuir la contribucion real
   * de cada senal en el analisis posterior.
   */
  const classifyTriggerSource = (
    ofiThreshold: number,
    toxicThreshold: number
  ): "OFI" | "LAYA" | "BOTH" | "OTHER" => {
    const byOfi = ofiScore <= ofiThreshold;
    const byLaya = toxicFlow >= toxicThreshold;
    if (byOfi && byLaya) return "BOTH";
    if (byOfi) return "OFI";
    if (byLaya) return "LAYA";
    return "OTHER";
  };

  // ESCENARIO 0: EMERGENCY DELEVERAGE ANTE COLAPSO DE LIBRO
  // Solo se detona en caso de auténtico colapso sistémico / barreamiento institucional,
  // evitando cortar prematuramente operaciones en ruido normal (-1.5% cortaba micro-rebotes)
  if (currentGainPct <= -3.00 && (toxicFlow >= 0.90 || ofiScore <= -0.85)) {
    const exitAction = 'EMERGENCY_DELEVERAGE';
    const exitReason = `Emergency deleverage triggered (Loss: ${currentGainPct.toFixed(2)}%, Toxic: ${toxicFlow.toFixed(2)}, OFI: ${ofiScore.toFixed(2)})`;
    recordDistillationSample({
      timestamp: new Date().toISOString(),
      type: 'EXIT_GOVERNANCE_DECISION',
      ticker,
      book,
      metrics: { currentGainPct, ofiScore, spreadBps, alreadyPartialTakenPct },
      layaJudgment: { toxicFlow, meanReversion },
      jevRegime,
      exitAction,
      fractionToClose: 1.0,
      exitReason,
      triggerSource: classifyTriggerSource(-0.85, 0.90),
    });

    return {
      action: exitAction,
      reason: exitReason,
      fractionToClose: 1.0,
      adjustedTpPrice: currentPrice,
      confidence: 0.95
    };
  }

  // Consulta de la política institucional diferenciada por perfil de activo (ANCHOR, BETA, FIAT)
  const policy = getRegimePolicy(jevRegime, ticker);

  // NUEVA GOBERNANZA CAUSAL: EVALUACIÓN DE POSICIONES EN PÉRDIDA (STOP DINÁMICO LAYA/JEV)
  // Si la posición va en pérdida, ya no se espera a ciegas al Hard Stop (-7.5% / -8.5%)
  if (currentGainPct < 0) {
    const profile = getAssetProfile(ticker);
    const dynamicStopLimit = profile === "ANCHOR" ? -2.20 : profile === "BETA" ? -3.20 : -0.80;

    // Si la pérdida perfora el umbral dinámico Y hay toxicidad institucional real o estrés macro:
    if (currentGainPct <= dynamicStopLimit && (toxicFlow > 0.65 || jevRegime === "DEFENSIVE_STRESS" || ofiScore < -0.55)) {
      return {
        action: "EMERGENCY_DELEVERAGE",
        reason: `Stop Dinámico Laya/Jev disparado (Pérdida: ${currentGainPct.toFixed(2)}%, ToxicFlow: ${toxicFlow.toFixed(2)}, Régimen: ${jevRegime})`,
        fractionToClose: 1.0, // Liquidar al 100% para cortar la hemorragia
        adjustedTpPrice: currentPrice,
        confidence: 0.95,
      };
    }

    // Si la pérdida es leve o Laya confirma que no hay toxicidad, HOLD DEFENSIVO (Aguanta el ruido)
    return {
      action: "HOLD",
      reason: `Hold Defensivo Laya (Pérdida: ${currentGainPct.toFixed(2)}%, ToxicFlow bajo: ${toxicFlow.toFixed(2)})`,
      fractionToClose: 0,
      confidence: 0.90,
    };
  }

  // Si no está en ganancia neta mínima para cubrir comisiones Maker/Taker, HOLD
  // En perfil FIAT (stablecoin), el roundtrip maker es 1.20%, umbral mínimo de ganancia = 1.25%
  const minGainThreshold = policy.frontRunMin > 1.0 ? policy.frontRunMin : 0.60;
  if (currentGainPct < minGainThreshold) {
    return { action: "HOLD", reason: `Below minimum fee-adjusted gain threshold (${minGainThreshold.toFixed(2)}%)`, fractionToClose: 0, confidence: 1.0 };
  }

  let exitAction: ExitGovernanceDecision["action"] = "HOLD";
  let exitReason = "Normal holding";
  let fractionToClose = 0;
  let adjustedTp = targetTpPrice;

  // ESCENARIO 1: FRONT_RUN EXIT ANTE FLUJO TÓXICO / MURO DE VENTA
  // Si tenemos ganancia suficiente (según policy.frontRunMin) y el libro se descompone bruscamente (OFI < -0.50 o toxicFlow > 0.50)
  if (currentGainPct >= policy.frontRunMin && (ofiScore < -0.50 || toxicFlow > 0.50)) {
    exitAction = 'FRONT_RUN_EXIT';
    exitReason = `Front-running orderbook toxic dump (Gain: +${currentGainPct.toFixed(2)}%, OFI: ${ofiScore.toFixed(2)}, Toxic: ${toxicFlow.toFixed(2)})`;
    fractionToClose = 1.0; // Cerrar el 100% de lo que queda de inmediato
    adjustedTp = currentPrice;
  }
  // ESCENARIO 2: TAKE PROFIT PARCIAL 1 (DCA OUT 1 - CALIBRADO POR RÉGIMEN)
  // Supera el umbral de régimen (1.80% en AGGRESSIVE, 1.40% en BALANCED, 1.20% en DEFENSIVE)
  else if (currentGainPct >= policy.tp1Threshold && alreadyPartialTakenPct < 0.50) {
    // Si hay euforia compradora masiva (OFI > 0.60 y régimen agresivo), dejamos correr sin vender aún
    if (ofiScore > 0.60 && toxicFlow < 0.20 && jevRegime === 'AGGRESSIVE_ACCUMULATION') {
      exitAction = 'TRAILING_EXPANSION';
      exitReason = `Aggressive momentum (OFI: +${ofiScore.toFixed(2)}). Deferring partial exit to let run.`;
      fractionToClose = 0;
      adjustedTp = currentPrice * 1.025;
    } else {
      exitAction = 'TAKE_PROFIT_PARTIAL';
      exitReason = `TP1 Partial secured at +${currentGainPct.toFixed(2)}% (Free-Roll locked, Target: +${policy.tp1Threshold.toFixed(2)}%)`;
      fractionToClose = 0.50; // Vender 50% del total para mejorar ratio beneficio/riesgo
      adjustedTp = currentPrice;
    }
  }
  // ESCENARIO 3: TAKE PROFIT PARCIAL 2 (DCA OUT 2 - CALIBRADO POR RÉGIMEN)
  else if (currentGainPct >= policy.tp2Threshold && alreadyPartialTakenPct < 0.70) {
    exitAction = 'TAKE_PROFIT_PARTIAL';
    exitReason = `TP2 Partial secured at +${currentGainPct.toFixed(2)}% (Target: +${policy.tp2Threshold.toFixed(2)}%)`;
    fractionToClose = 0.50; // Vender el 50% del remanente restante
    adjustedTp = currentPrice;
  }
  // ESCENARIO 4: META SUPERIOR DEL GENOMA ALCANZADA (+3.5% a +3.8%) O TRAILING
  else if (currentPrice >= targetTpPrice && targetTpPrice > 0) {
    if (ofiScore > 0.50 && toxicFlow < 0.20) {
      exitAction = 'TRAILING_EXPANSION';
      exitReason = `Genome target reached but high buy pressure (OFI: +${ofiScore.toFixed(2)}). Expanding target.`;
      fractionToClose = 0;
      adjustedTp = currentPrice * 1.02;
    } else {
      exitAction = 'TAKE_PROFIT_STANDARD';
      exitReason = `Full TP reached at +${currentGainPct.toFixed(2)}%`;
      fractionToClose = 1.0; // Cerrar el 100% de la posición restante
      adjustedTp = currentPrice;
    }
  }

  // Registro en el dataset de destilación causal (RLCD)
  if (exitAction !== 'HOLD') {
    recordDistillationSample({
      timestamp: new Date().toISOString(),
      type: 'EXIT_GOVERNANCE_DECISION',
      ticker,
      book,
      metrics: { currentGainPct, ofiScore, spreadBps, alreadyPartialTakenPct },
      layaJudgment: { toxicFlow, meanReversion },
      jevRegime,
      exitAction,
      fractionToClose,
      exitReason,
      triggerSource: classifyTriggerSource(-0.50, 0.50),
    });
  }

  return {
    action: exitAction,
    reason: exitReason,
    fractionToClose,
    adjustedTpPrice: adjustedTp,
    confidence: layaJudgment.ok ? 0.95 : 0.75
  };
}
