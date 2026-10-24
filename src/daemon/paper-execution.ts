/**
 * Modelo de ejecucion PAPER (puro, determinista, sin red).
 *
 * Motivo: en modo PAPER el motor CEX asumia que toda orden limite se llenaba
 * integra al precio del nivel (sin cola, sin fills parciales, sin slippage), lo
 * que sesgaba a favor del motor. Este modulo modela el fill realista:
 *  - Post-only (MAKER) que cruza el libro se reclasifica a TAKER.
 *  - Cola parcial en el nivel (queueFactor) y toque efectivo del precio.
 *  - Impacto adverso de mercado para TAKER segun tamano vs profundidad.
 *  - Fill parcial cuando la orden es demasiado grande para la profundidad.
 *  - Comision segun la liquidez efectivamente obtenida (maker/taker).
 *
 * El resultado replica los campos que el ledger solo puebla en LIVE
 * (`slippageUsd`, `liquidity`, `feePaidUsd`), de modo que PAPER y LIVE comparten
 * el mismo contrato contable.
 *
 * Ninguna funcion muta estado ni usa `Math.random`.
 */

export type PaperSide = "buy" | "sell";
export type PaperIntent = "MAKER" | "TAKER";
export type PaperLiquidity = "MAKER" | "TAKER";

/** Comision Taker por defecto en Binance Spot VIP0 (0.10%). */
export const DEFAULT_TAKER_FEE_BPS = 10;
/** Comision Maker por defecto en Binance Spot VIP0 (0.10%). */
export const DEFAULT_MAKER_FEE_BPS = 10;
/** Fraccion de la profundidad asumida por delante en la cola si no se especifica. */
export const DEFAULT_QUEUE_FACTOR = 0.5;
/** Coeficiente de impacto por defecto. */
export const DEFAULT_IMPACT_K = 1.0;
/**
 * Supuesto de participacion de un taker: una orden agresiva puede barrer como
 * maximo 3x la profundidad visible antes de agotarse en el tick. Notional por
 * encima de ese multiplo se llena solo parcialmente.
 */
export const TAKER_DEPTH_PARTICIPATION_MULTIPLE = 3;

export interface PaperFillInput {
  side: PaperSide;
  intent: PaperIntent;
  /** Precio del nivel limite solicitado por el motor. */
  levelPrice: number;
  bestBid: number;
  bestAsk: number;
  qty: number;
  /** Profundidad cotizada del lado relevante, en USD. */
  depthUsd: number;
  /** Volatilidad porcentual del horizonte (reservada para modulacion externa del queueFactor). */
  volatilityPct?: number;
  /** Fraccion (0..1) de profundidad por delante en la cola. 0 = primera en la cola. */
  queueFactor?: number;
  takeFeeBps?: number;
  makeFeeBps?: number;
  /** Coeficiente de impacto: impactPct = impactK * (notionalUsd / depthUsd). */
  impactK?: number;
}

export interface PaperFillResult {
  filled: boolean;
  /** Precio efectivo del fill. 0 cuando `filled = false`. */
  fillPrice: number;
  filledQty: number;
  liquidity: PaperLiquidity;
  slippageUsd: number;
  feeUsd: number;
  reason: string;
}

function round(v: number, decimals = 8): number {
  const f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function noFill(reason: string, liquidity: PaperLiquidity = "MAKER"): PaperFillResult {
  return { filled: false, fillPrice: 0, filledQty: 0, liquidity, slippageUsd: 0, feeUsd: 0, reason };
}

/**
 * Valida los campos numericos obligatorios. Devuelve el motivo del rechazo o
 * `null` si la entrada es utilizable. No lanza: el llamador recibe `filled=false`.
 */
function validateInput(input: PaperFillInput): string | null {
  const { levelPrice, bestBid, bestAsk, qty, depthUsd } = input;
  if (!Number.isFinite(levelPrice) || levelPrice <= 0) return "levelPrice invalido (debe ser finito y > 0)";
  if (!Number.isFinite(bestBid) || bestBid <= 0) return "bestBid invalido (debe ser finito y > 0)";
  if (!Number.isFinite(bestAsk) || bestAsk <= 0) return "bestAsk invalido (debe ser finito y > 0)";
  if (!Number.isFinite(qty) || qty <= 0) return "qty invalida (debe ser finita y > 0)";
  if (!Number.isFinite(depthUsd) || depthUsd < 0) return "depthUsd invalido (debe ser finito y >= 0)";
  return null;
}

/**
 * Simula un fill PAPER para una orden limite.
 *
 * Reglas:
 *  1. MAKER post-only que cruza el libro -> se reclasifica a TAKER (motivo explicito).
 *  2. MAKER sin cruce se llena solo si el precio toco el nivel (buy: levelPrice >= bestBid,
 *     sell: levelPrice <= bestAsk); en ese caso queda la cola: filledQty = qty * (1 - queueFactor).
 *  3. TAKER: referencia = bestAsk (buy) / bestBid (sell); impactPct = impactK * notionalUsd / depthUsd
 *     aplicado siempre en contra; slippageUsd = |fillPrice - referencePrice| * filledQty.
 *  4. feeUsd = filledQty * fillPrice * feeBps / 10000 con la comision de la liquidez resultante.
 *  5. TAKER con notionalUsd > depthUsd * 3 -> fill parcial limitado a esa profundidad.
 *
 * `impactPct` es una fraccion decimal (0.01 = 1% de impacto adverso), no un porcentaje entero.
 * `volatilityPct` no altera el resultado: queda reservado para que el llamador derive el
 * `queueFactor` via `estimateQueueFillProbability`.
 */
export function computePaperFill(input: PaperFillInput): PaperFillResult {
  const invalid = validateInput(input);
  if (invalid) {
    return noFill(invalid, input.intent === "TAKER" ? "TAKER" : "MAKER");
  }

  const {
    side,
    intent,
    levelPrice,
    bestBid,
    bestAsk,
    qty,
    depthUsd,
    queueFactor = DEFAULT_QUEUE_FACTOR,
    takeFeeBps = DEFAULT_TAKER_FEE_BPS,
    makeFeeBps = DEFAULT_MAKER_FEE_BPS,
    impactK = DEFAULT_IMPACT_K,
  } = input;

  // Un buy post-only a levelPrice >= bestAsk (o un sell a levelPrice <= bestBid) cruzaria
  // el libro: no puede descansar como maker y se ejecuta como taker.
  const crossesBook = side === "buy" ? levelPrice >= bestAsk : levelPrice <= bestBid;

  if (intent === "MAKER" && !crossesBook) {
    const touched = side === "buy" ? levelPrice >= bestBid : levelPrice <= bestAsk;
    if (!touched) {
      return noFill("post-only en cola, sin toque", "MAKER");
    }

    const qf = clamp(Number.isFinite(queueFactor) ? queueFactor : DEFAULT_QUEUE_FACTOR, 0, 1);
    const filledQty = round(clamp(qty * (1 - qf), 0, qty));
    if (filledQty <= 0) {
      return noFill("post-only sin llenado: toda la profundidad por delante en la cola", "MAKER");
    }

    const fillPrice = round(levelPrice);
    const feeUsd = round((filledQty * fillPrice * makeFeeBps) / 10000, 4);
    return {
      filled: true,
      fillPrice,
      filledQty,
      liquidity: "MAKER",
      // Un maker pasivo obtiene su propio precio: sin slippage adverso.
      slippageUsd: 0,
      feeUsd,
      reason: `MAKER llenado parcial en el nivel (queueFactor=${qf})`,
    };
  }

  // Camino TAKER: por intencion explicita o por reclasificacion del cruce post-only.
  const reclassified = intent === "MAKER" && crossesBook;
  if (!Number.isFinite(depthUsd) || depthUsd <= 0) {
    return noFill("profundidad del libro insuficiente (depthUsd <= 0) para TAKER", "TAKER");
  }

  const referencePrice = side === "buy" ? bestAsk : bestBid;
  const notionalUsd = qty * referencePrice;
  const impactPct = impactK * (notionalUsd / depthUsd);
  const direction = side === "buy" ? 1 : -1;
  const fillPrice = round(referencePrice * (1 + direction * impactPct));

  let filledQty = qty;
  let partialNote = "";
  if (notionalUsd > depthUsd * TAKER_DEPTH_PARTICIPATION_MULTIPLE) {
    const maxQty = (depthUsd * TAKER_DEPTH_PARTICIPATION_MULTIPLE) / referencePrice;
    filledQty = round(clamp(Math.min(qty, maxQty), 0, qty));
    partialNote = `; llenado parcial: notional excede ${TAKER_DEPTH_PARTICIPATION_MULTIPLE}x la profundidad visible`;
  }
  if (filledQty <= 0) {
    return noFill("TAKER sin llenado: profundidad consumida", "TAKER");
  }

  const slippageUsd = round(Math.abs(fillPrice - referencePrice) * filledQty, 4);
  const feeUsd = round((filledQty * fillPrice * takeFeeBps) / 10000, 4);
  const reason = reclassified
    ? `cruce del libro: maker post-only reclasificado a TAKER (${
        side === "buy" ? "levelPrice >= bestAsk" : "levelPrice <= bestBid"
      })${partialNote}`
    : `TAKER ejecutado contra ${side === "buy" ? "bestAsk" : "bestBid"} con impacto adverso${partialNote}`;

  return { filled: true, fillPrice, filledQty, liquidity: "TAKER", slippageUsd, feeUsd, reason };
}

/**
 * Estima la probabilidad (0..1) de que un nivel pasivo a `distanceToTouchPct`
 * porcentaje del mejor precio sea alcanzado dentro del horizonte, dada la
 * volatilidad porcentual `volatilityPct` del mismo horizonte.
 *
 * Modelo de razon suavizada: p = v / (v + d). Con d = 0 devuelve 1 (el precio ya
 * esta en el nivel); con v = 0 devuelve 0 (mercado sin movimiento). Es monotona
 * decreciente en la distancia y creciente en la volatilidad. Funcion pura.
 *
 * Uso tipico: el llamador convierte `p` en un `queueFactor` (a mayor probabilidad
 * de toque, menor fraccion de profundidad por delante) antes de invocar
 * `computePaperFill`.
 */
export function estimateQueueFillProbability(distanceToTouchPct: number, volatilityPct: number): number {
  if (!Number.isFinite(distanceToTouchPct) || !Number.isFinite(volatilityPct)) return 0;
  const distance = Math.max(0, distanceToTouchPct);
  const volatility = Math.max(0, volatilityPct);
  if (distance === 0) return 1;
  if (volatility === 0) return 0;
  return round(volatility / (volatility + distance), 6);
}
