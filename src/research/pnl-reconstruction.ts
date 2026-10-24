/**
 * Reconstruccion independiente del PnL y analisis de escalabilidad por tamano de cuenta.
 *
 * MOTIVACION
 * Hoy el ledger del motor es la UNICA fuente de verdad del PnL: `history` guarda
 * `pnlNet` tal cual lo calculo el motor y nadie lo recomputa. Este modulo aporta una
 * verificacion de coherencia INTERNA (suma de componentes por trade) y de coherencia
 * CONTABLE por slot DEX, sin depender de klines ni de datos externos.
 *
 * ALCANCE (importante, no sobrevender)
 *  - `reconcileTradesWithLedger` NO recalcula el PnL desde precios de mercado/kllines.
 *    Reconstruye el bruto implicito a partir de los propios campos del trade
 *    (`price`, `amount`, `pnlPct`) y lo compara con `pnlNet`. Es una verificacion de
 *    que los componentes del registro cuadran entre si; un ledger internamente
 *    consistente pero mal alimentado seguiria "cuadrando".
 *  - Convencion del motor (src/daemon/cex-engine.ts): `pnlNet` es PnL BRUTO
 *    (`(fill - entry) * qty`), y los costos se registran aparte en `feePaidUsd` /
 *    `slippageUsd`. El neto real = bruto - fees - slippage.
 *
 * LEY DE IMPACTO
 *  - `impactUsd = impactK * notionalUsd^2 / depthUsd`. Es una ley de impacto
 *    cuadratica estilo costo de ejecucion (Almgren-Chriss reducido): un nocional
 *    que consume una fraccion del libro se paga con un desplazamiento de precio
 *    proporcional al consumo, y el costo total escala con nocional * desplazamiento
 *    = nocional^2 / profundidad. `impactK` calibra el factor de forma (default 1.0).
 *  - `depthUsd` es la profundidad citada agregada (USD) del/los activos operados.
 */

export type TradeSide = "LONG" | "SHORT";

export interface CexTradeInput {
  entryPrice: number;
  exitPrice: number;
  qty: number;
  /** Comision total en USD (maker + taker). Default 0. */
  feesUsd?: number;
  /** Slippage observado en USD. Default 0. */
  slippageUsd?: number;
  /** Direccion de la posicion. Default LONG. */
  side?: TradeSide;
}

export interface CexPnlResult {
  /** PnL bruto = (exit - entry) * qty para LONG; (entry - exit) * qty para SHORT. */
  grossUsd: number;
  /** PnL neto = bruto - fees - slippage. */
  netUsd: number;
  /** Neto sobre nocional de entrada (|entry * qty|), en porcentaje. */
  netPct: number;
  /** Precio de salida que deja el neto exactamente en cero (con los costos dados). */
  breakevenExitPrice: number;
}

export interface LedgerTradeLike {
  timestamp?: string;
  venue?: string;
  assetOrPool?: string;
  action?: string;
  price?: number;
  amount?: number;
  pnlNet?: number;
  pnlPct?: number;
  feePaidUsd?: number;
  feeSavedOrPaid?: number;
  slippageUsd?: number;
  liquidity?: "MAKER" | "TAKER";
}

export interface LedgerMismatch {
  index: number;
  timestamp: string;
  assetOrPool: string;
  action: string;
  ledgerUsd: number;
  reconstructedUsd: number;
  diffUsd: number;
}

export interface LedgerReconciliation {
  checked: number;
  mismatches: LedgerMismatch[];
  ledgerTotalUsd: number;
  reconstructedTotalUsd: number;
  coveragePct: number;
}

export interface DexSlotLike {
  pool?: string;
  slot?: string;
  currentCapitalUsd?: number;
  initialCapitalUsd?: number;
  accumulatedFeesUsd?: number;
  impermanentLossUsd?: number;
  gasSpentUsd?: number;
}

export interface DexSlotReconciliation {
  slot: string;
  evaluable: boolean;
  reason: string;
  initialCapitalUsd: number;
  accumulatedFeesUsd: number;
  impermanentLossUsd: number;
  gasSpentUsd: number;
  currentCapitalUsd: number;
  expectedCapitalUsd: number;
  deltaUsd: number;
  coherent: boolean;
  explanation: string;
}

export interface ImpactInput {
  notionalUsd: number;
  depthUsd: number;
  /** Factor de forma de la ley cuadratica. Default 1.0. */
  impactK?: number;
}

export interface ScalingAssumptions {
  impactK: number;
  makerFeeBps: number;
  takerFeeBps: number;
  /** Nocional asumido por trade como fraccion del capital (1.0 = despliegue total). */
  deploymentRatio: number;
  /** Fraccion de trades TAKER. Si no se observa, se usa `takerShareDefault`. */
  takerShare: number;
}

export interface ScalingPoint {
  capitalUsd: number;
  notionalUsd: number;
  /** Expectativa bruta observada por unidad de nocional (libre de impacto). */
  grossEdgePerNotional: number;
  grossEdgeUsd: number;
  feeUsd: number;
  impactUsd: number;
  expectancyUsd: number;
  expectancyPct: number;
  depthUsd: number;
  breakevenCapitalUsd: number;
  assumptions: ScalingAssumptions;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round6 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : v);

/**
 * Reconstruye el PnL de un trade CEX de forma independiente al ledger.
 * No requiere red ni klines: solo precios de entrada/salida, cantidad y costos.
 */
export function reconstructCexTradePnl(input: CexTradeInput): CexPnlResult {
  const side: TradeSide = input?.side === "SHORT" ? "SHORT" : "LONG";
  const entry = num(input?.entryPrice);
  const exit = num(input?.exitPrice);
  const qty = num(input?.qty);
  const fees = num(input?.feesUsd);
  const slippage = num(input?.slippageUsd);

  const grossUsd = side === "SHORT" ? (entry - exit) * qty : (exit - entry) * qty;
  const netUsd = grossUsd - fees - slippage;
  const notional = Math.abs(entry * qty);
  const netPct = notional > 0 ? (netUsd / notional) * 100 : 0;
  const costPerUnit = qty !== 0 ? (fees + slippage) / qty : 0;
  const breakevenExitPrice = side === "SHORT" ? entry - costPerUnit : entry + costPerUnit;

  return {
    grossUsd: round6(grossUsd),
    netUsd: round6(netUsd),
    netPct: round6(netPct),
    breakevenExitPrice: round6(breakevenExitPrice),
  };
}

/**
 * Verificacion de coherencia INTERNA del ledger: para cada trade CEX elegible se
 * infiere el precio de entrada implicito a partir de `pnlPct`
 * (`pnlPct = (price / entry - 1) * 100`), se reconstruye el bruto
 * `(price - entry) * amount` y se compara contra el `pnlNet` registrado.
 *
 * - No es un recalculo desde klines: es una suma de componentes autorreferencial.
 * - Los trades DEX (`venue === "BASE_DEX"`) y los de `amount <= 0` se excluyen
 *   porque su `pnlNet` es una comision cobrada, no un movimiento de precio;
 *   eso baja la cobertura de forma legitima (cobertura parcial).
 * - `pnlPct` y `pnlNet` se persistieron redondeados a 2 decimales. El redondeo de
 *   `pnlPct` induce un error proporcional al nocional (~0.005% del nocional), por lo
 *   que la tolerancia efectiva es `max(toleranceUsd, nocional * 5e-5)`.
 */
export function reconcileTradesWithLedger(
  trades: LedgerTradeLike[],
  toleranceUsd = 0.01
): LedgerReconciliation {
  const list = Array.isArray(trades) ? trades : [];
  const mismatches: LedgerMismatch[] = [];
  let checked = 0;
  let ledgerTotalUsd = 0;
  let reconstructedTotalUsd = 0;

  list.forEach((t, index) => {
    const venue = String(t?.venue || "").toUpperCase();
    const price = num(t?.price);
    const amount = num(t?.amount);
    const eligible = venue !== "BASE_DEX" && price > 0 && amount > 0;
    if (!eligible) return;

    checked++;
    const pnlNet = num(t?.pnlNet);
    const pnlPct = num(t?.pnlPct);
    const entryImplied = pnlPct !== -100 ? price / (1 + pnlPct / 100) : price;
    const reconstructedUsd = (price - entryImplied) * amount;

    const quantizationError = Math.abs(price * amount) * (0.005 / 100);
    const effectiveTolerance = Math.max(num(toleranceUsd), quantizationError);
    const diffUsd = pnlNet - reconstructedUsd;

    ledgerTotalUsd += pnlNet;
    reconstructedTotalUsd += reconstructedUsd;

    if (Math.abs(diffUsd) > effectiveTolerance) {
      mismatches.push({
        index,
        timestamp: String(t?.timestamp || ""),
        assetOrPool: String(t?.assetOrPool || ""),
        action: String(t?.action || ""),
        ledgerUsd: round6(pnlNet),
        reconstructedUsd: round6(reconstructedUsd),
        diffUsd: round6(diffUsd),
      });
    }
  });

  const coveragePct = list.length > 0 ? (checked / list.length) * 100 : 0;

  return {
    checked,
    mismatches,
    ledgerTotalUsd: round6(ledgerTotalUsd),
    reconstructedTotalUsd: round6(reconstructedTotalUsd),
    coveragePct: round6(coveragePct),
  };
}

/** Tolerancia por defecto de coherencia contable de un slot DEX (USD). */
export const DEX_SLOT_TOLERANCE_USD = 0.05;

/**
 * Coherencia contable del tramo DEX de un slot:
 *   initialCapitalUsd + accumulatedFeesUsd - impermanentLossUsd - gasSpentUsd  ==  currentCapitalUsd
 * El delta = currentCapitalUsd - esperado; |delta| <= tolerancia => coherente.
 * Si falta algun campo numerico, el slot NO es evaluable (no se marca como incoherente).
 */
export function reconcileDexSlot(
  slot: DexSlotLike,
  toleranceUsd = DEX_SLOT_TOLERANCE_USD
): DexSlotReconciliation {
  const tolerance = num(toleranceUsd);
  const slotName = String(slot?.pool || slot?.slot || "?");
  const has = (k: keyof DexSlotLike): boolean =>
    !!slot && typeof (slot as Record<string, unknown>)[k as string] === "number" &&
    Number.isFinite((slot as Record<string, unknown>)[k as string] as number);

  const required: Array<keyof DexSlotLike> = [
    "initialCapitalUsd",
    "accumulatedFeesUsd",
    "impermanentLossUsd",
    "gasSpentUsd",
    "currentCapitalUsd",
  ];
  const missing = required.filter((k) => !has(k));

  const base = {
    slot: slotName,
    initialCapitalUsd: num(slot?.initialCapitalUsd),
    accumulatedFeesUsd: num(slot?.accumulatedFeesUsd),
    impermanentLossUsd: num(slot?.impermanentLossUsd),
    gasSpentUsd: num(slot?.gasSpentUsd),
    currentCapitalUsd: num(slot?.currentCapitalUsd),
  };

  if (!slot || missing.length > 0) {
    return {
      ...base,
      evaluable: false,
      reason: `faltan campos numericos: ${missing.join(", ") || "slot invalido"}`,
      expectedCapitalUsd: NaN,
      deltaUsd: NaN,
      coherent: false,
      explanation: "Slot pre-correccion: no registra IL/gas/initialCapital, no se puede reconciliar.",
    };
  }

  const expectedCapitalUsd =
    base.initialCapitalUsd +
    base.accumulatedFeesUsd -
    base.impermanentLossUsd -
    base.gasSpentUsd;
  const deltaUsd = base.currentCapitalUsd - expectedCapitalUsd;
  const coherent = Math.abs(deltaUsd) <= tolerance;

  const explanation = coherent
    ? `Cuadra: capital actual = inicial + fees - IL - gas (delta $${deltaUsd.toFixed(4)} <= $${tolerance.toFixed(2)}).`
    : `Desvio $${deltaUsd.toFixed(4)}: el capital del slot no se explica por inicial + fees - IL - gas. ` +
      `Revisar si hubo inyeccion de capital sin registrar, IL/gas no contabilizados o fees no cobradas.`;

  return {
    ...base,
    evaluable: true,
    reason: "",
    expectedCapitalUsd: round6(expectedCapitalUsd),
    deltaUsd: round6(deltaUsd),
    coherent,
    explanation,
  };
}

/**
 * Impacto de mercado modelado como ley cuadratica:
 *   impactUsd = impactK * notionalUsd^2 / depthUsd
 * Devuelve 0 si el nocional es 0; Infinity si hay nocional pero profundidad nula.
 */
export function estimateImpactUsd({ notionalUsd, depthUsd, impactK = 1.0 }: ImpactInput): number {
  const notional = Math.max(0, num(notionalUsd));
  const depth = num(depthUsd);
  const k = num(impactK);
  if (notional <= 0) return 0;
  if (depth <= 0) return Number.POSITIVE_INFINITY;
  return (k * notional * notional) / depth;
}

export interface ScalingOptions {
  impactK?: number;
  makerFeeBps?: number;
  takerFeeBps?: number;
  deploymentRatio?: number;
  /** Fraccion TAKER a usar si el historial no trae el campo `liquidity`. Default 0.5. */
  takerShareDefault?: number;
}

/**
 * Curva de escalado por tamano de cuenta.
 *
 * Modelo (todos los supuestos quedan expuestos en el resultado):
 *  - Edge bruto observado por unidad de nocional: `grossEdgePerNotional = sum(pnlNet) / sum(price*amount)`
 *    sobre los trades CEX elegibles. Se asume que el tamano observado es lo bastante
 *    pequeno como para que el impacto sea despreciable ("edge libre de impacto").
 *  - Nocional proporcional al capital: `notional = capitalUsd * deploymentRatio`.
 *  - Costo de fees por tamano: `feeUsd = notional * feeMixBps / 1e4`, con
 *    `feeMixBps = takerShare * takerFeeBps + (1 - takerShare) * makerFeeBps`.
 *  - Impacto solo en la porcion TAKER: `impactUsd = takerShare * impactK * notional^2 / depthTotal`.
 *  - `expectancyUsd = grossEdge - fee - impact`; `expectancyPct = expectancyUsd / capitalUsd * 100`.
 *
 * `breakevenCapitalUsd` es el capital donde la expectativa por trade cruza 0:
 *   N_be = (grossEdgePerNotional - feeMix) * depthTotal / (takerShare * impactK)
 *   C_be = N_be / deploymentRatio
 * Devuelve 0 si la ventaja ya es negativa antes de impacto, e Infinity si no hay
 * impacto (profundidad nula o 0% taker) y la ventaja es positiva.
 */
export function scalingCurve(
  trades: LedgerTradeLike[],
  capitalUsd: number,
  depthByAssetUsd: Record<string, number>,
  opts: ScalingOptions = {}
): ScalingPoint {
  const impactK = opts.impactK ?? 1.0;
  const makerFeeBps = opts.makerFeeBps ?? 10;
  const takerFeeBps = opts.takerFeeBps ?? 10;
  const deploymentRatio = opts.deploymentRatio ?? 1.0;

  const list = (Array.isArray(trades) ? trades : []).filter(
    (t) =>
      String(t?.venue || "").toUpperCase() !== "BASE_DEX" &&
      num(t?.price) > 0 &&
      num(t?.amount) > 0
  );

  let sumNotional = 0;
  let sumGross = 0;
  let takerCount = 0;
  let liquidityKnown = 0;
  for (const t of list) {
    const notional = num(t.price) * num(t.amount);
    sumNotional += notional;
    sumGross += num(t.pnlNet);
    if (t.liquidity) {
      liquidityKnown++;
      if (String(t.liquidity).toUpperCase() === "TAKER") takerCount++;
    }
  }
  const grossEdgePerNotional = sumNotional > 0 ? sumGross / sumNotional : 0;
  const takerShare =
    liquidityKnown > 0 ? takerCount / liquidityKnown : opts.takerShareDefault ?? 0.5;

  const depthTotal = Object.values(depthByAssetUsd || {}).reduce(
    (a, v) => a + Math.max(0, num(v)),
    0
  );

  const capital = Math.max(0, num(capitalUsd));
  const notionalUsd = capital * deploymentRatio;
  const feeMixBps = takerShare * takerFeeBps + (1 - takerShare) * makerFeeBps;
  const grossEdgeUsd = grossEdgePerNotional * notionalUsd;
  const feeUsd = (notionalUsd * feeMixBps) / 10000;
  const impactUsd = takerShare <= 0 ? 0 : estimateImpactUsd({ notionalUsd, depthUsd: depthTotal, impactK });
  const boundedImpact = Number.isFinite(impactUsd) ? impactUsd : Number.POSITIVE_INFINITY;
  const expectancyUsd = grossEdgeUsd - feeUsd - boundedImpact;
  const expectancyPct = capital > 0 ? (expectancyUsd / capital) * 100 : 0;

  const edgeRate = grossEdgePerNotional - feeMixBps / 10000;
  const impactPerNotional = depthTotal > 0 ? (takerShare * impactK) / depthTotal : Number.POSITIVE_INFINITY;
  let breakevenCapitalUsd: number;
  if (edgeRate <= 0) {
    breakevenCapitalUsd = 0; // sin ventaja: muere en cualquier tamano
  } else if (!Number.isFinite(impactPerNotional) || impactPerNotional <= 0) {
    breakevenCapitalUsd = Number.POSITIVE_INFINITY; // ventaja sin impacto modelado
  } else {
    const notionalBreakeven = edgeRate / impactPerNotional;
    breakevenCapitalUsd = notionalBreakeven / deploymentRatio;
  }

  return {
    capitalUsd: round6(capital),
    notionalUsd: round6(notionalUsd),
    grossEdgePerNotional: round6(grossEdgePerNotional),
    grossEdgeUsd: round6(grossEdgeUsd),
    feeUsd: round6(feeUsd),
    impactUsd: round6(boundedImpact),
    expectancyUsd: round6(expectancyUsd),
    expectancyPct: round6(expectancyPct),
    depthUsd: round6(depthTotal),
    breakevenCapitalUsd: Number.isFinite(breakevenCapitalUsd)
      ? round6(breakevenCapitalUsd)
      : breakevenCapitalUsd,
    assumptions: {
      impactK,
      makerFeeBps,
      takerFeeBps,
      deploymentRatio,
      takerShare: round6(takerShare),
    },
  };
}
