/**
 * Modelo canonico de operaciones para auditar bots ajenos.
 *
 * Principio: el PnL se DERIVA de los ingredientes (precios, cantidades, costes). Lo que el
 * cliente declare como `pnlNet` es una afirmacion a verificar, no la fuente de verdad.
 * Si faltan ingredientes, el trade se marca como `reported` y la calidad del dataset baja:
 * la compuerta de suficiencia decide si el veredicto es emitible o queda NO CONCLUYENTE.
 *
 * Sin esto, cada bot tendria su propio esquema y el kit solo serviria para si mismo.
 */

export type CanonicalVenue = "CEX" | "DEX_LP" | "FUTURES" | "OTHER";
export type PnlSource = "derived" | "reported" | "mixed";

export interface CanonicalTrade {
  id?: string;
  /** ISO 8601. */
  ts: string;
  venue: CanonicalVenue;
  symbol: string;
  qty?: number;
  entryPrice?: number;
  exitPrice?: number;
  /** Nocional en USD si el par no es USD-quote. */
  notionalUsd?: number;
  /** Bruto = (exit - entry) * qty (long) si hay precios. */
  grossPnlUsd?: number;
  /** Costes en USD. 0 solo si el adaptador los conoce y son cero. */
  feesUsd?: number;
  slippageUsd?: number;
  /** Neto = bruto - fees - slippage si se pudo derivar; si no, el reportado. */
  netPnlUsd: number;
  /** Neto declarado por el cliente, conservado para comparar contra el derivado. */
  reportedNetPnlUsd?: number;
  pnlSource: PnlSource;
  /** Fila original, para trazabilidad. */
  raw?: Record<string, unknown>;
}

export interface CanonicalAccount {
  capitalUsd?: number;
  equityUsd?: number;
  currency?: string;
}

export type Sufficiency = "SUFFICIENT" | "PARTIAL" | "INSUFFICIENT";

export interface DataQuality {
  totalRows: number;
  rowsWithDerivedPnl: number;
  /** Filas con bruto conocido (derivado o mixto: falta el coste, no el PnL). */
  rowsWithGrossKnown: number;
  rowsWithReportedPnlOnly: number;
  rowsWithFees: number;
  rowsWithSlippage: number;
  /** % de filas con bruto conocido (ingredientes o bruto declarado). */
  coveragePct: number;
  sufficiency: Sufficiency;
  reasons: string[];
}

export interface CanonicalDataset {
  source: string;
  adapter: string;
  account: CanonicalAccount;
  trades: CanonicalTrade[];
  quality: DataQuality;
  issues: string[];
}

/** Deriva el PnL neto de un trade canonico. No lanza: devuelve el motivo. */
export function deriveNetPnl(
  t: Pick<CanonicalTrade, "qty" | "entryPrice" | "exitPrice" | "grossPnlUsd" | "notionalUsd" | "feesUsd" | "slippageUsd" | "netPnlUsd">
): {
  grossPnlUsd: number | null;
  netPnlUsd: number;
  source: PnlSource;
} {
  const hasPrices =
    typeof t.qty === "number" && t.qty > 0 && typeof t.entryPrice === "number" && t.entryPrice > 0 && typeof t.exitPrice === "number" && t.exitPrice > 0;
  const fees = typeof t.feesUsd === "number" && Number.isFinite(t.feesUsd) ? t.feesUsd : null;
  const slippage = typeof t.slippageUsd === "number" && Number.isFinite(t.slippageUsd) ? t.slippageUsd : 0;

  const gross = hasPrices
    ? round((t.exitPrice! - t.entryPrice!) * t.qty!)
    : typeof t.grossPnlUsd === "number"
    ? round(t.grossPnlUsd)
    : null;

  if (gross === null) {
    // Sin ingredientes: el neto es una afirmacion del cliente, no un calculo.
    return { grossPnlUsd: null, netPnlUsd: round(t.netPnlUsd), source: "reported" };
  }
  if (fees === null) {
    // Bruto conocido pero costes ausentes: el neto no es verificable.
    return { grossPnlUsd: gross, netPnlUsd: round(gross - slippage), source: "mixed" };
  }
  return { grossPnlUsd: gross, netPnlUsd: round(gross - fees - slippage), source: "derived" };
}

/**
 * Evalua la calidad del dataset. La regla es explicita y conservadora:
 *  - SUFFICIENT: >=90% de las filas con PnL derivado y costes presentes en >=90%.
 *  - PARTIAL: >=50% derivado; el veredicto se emite con advertencia.
 *  - INSUFFICIENT: <50% derivado o sin timestamps: no se emite veredicto.
 */
export function assessDataQuality(trades: CanonicalTrade[]): DataQuality {
  const total = trades.length;
  if (total === 0) {
    return {
      totalRows: 0,
      rowsWithDerivedPnl: 0,
      rowsWithGrossKnown: 0,
      rowsWithReportedPnlOnly: 0,
      rowsWithFees: 0,
      rowsWithSlippage: 0,
      coveragePct: 0,
      sufficiency: "INSUFFICIENT",
      reasons: ["Sin operaciones: no hay nada que auditar."],
    };
  }
  const derived = trades.filter((t) => t.pnlSource === "derived").length;
  const mixed = trades.filter((t) => t.pnlSource === "mixed").length;
  const reported = trades.filter((t) => t.pnlSource === "reported").length;
  const grossKnown = derived + mixed;
  const withFees = trades.filter((t) => typeof t.feesUsd === "number").length;
  const withSlippage = trades.filter((t) => typeof t.slippageUsd === "number").length;
  const coveragePct = round((grossKnown / total) * 100, 2);

  const reasons: string[] = [];
  if (reported > 0) reasons.push(`${reported} de ${total} trades solo traen PnL reportado (no verificable contra precios).`);
  if (withFees < total) reasons.push(`${total - withFees} trades sin costes declarados: el neto no es verificable.`);
  if (trades.some((t) => !t.ts || Number.isNaN(Date.parse(t.ts)))) reasons.push("Hay trades sin timestamp valido: no se puede ordenar ni hacer walk-forward.");

  const noTimestamps = trades.filter((t) => !t.ts || Number.isNaN(Date.parse(t.ts))).length;
  let sufficiency: Sufficiency;
  if (noTimestamps > 0 || coveragePct < 50) sufficiency = "INSUFFICIENT";
  else if (coveragePct >= 90 && withFees >= total * 0.9) sufficiency = "SUFFICIENT";
  else sufficiency = "PARTIAL";

  if (sufficiency === "INSUFFICIENT" && reasons.length === 0) {
    reasons.push("Cobertura de PnL verificable por debajo del 50%.");
  }

  return {
    totalRows: total,
    rowsWithDerivedPnl: derived,
    rowsWithGrossKnown: grossKnown,
    rowsWithReportedPnlOnly: reported,
    rowsWithFees: withFees,
    rowsWithSlippage: withSlippage,
    coveragePct,
    sufficiency,
    reasons,
  };
}

/** Construye el dataset canonico aplicando la derivacion a cada trade. */
export function buildDataset(params: {
  source: string;
  adapter: string;
  account?: CanonicalAccount;
  trades: Array<Omit<CanonicalTrade, "netPnlUsd" | "pnlSource"> & { netPnlUsd?: number }>;
  issues?: string[];
}): CanonicalDataset {
  const issues = [...(params.issues ?? [])];
  const trades: CanonicalTrade[] = params.trades.map((t) => {
    const d = deriveNetPnl({
      qty: t.qty,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      grossPnlUsd: t.grossPnlUsd,
      notionalUsd: t.notionalUsd,
      feesUsd: t.feesUsd,
      slippageUsd: t.slippageUsd,
      netPnlUsd: typeof t.netPnlUsd === "number" ? t.netPnlUsd : 0,
    });
    const reported = typeof (t as any).reportedNetPnlUsd === "number" ? (t as any).reportedNetPnlUsd : undefined;
    // Si el cliente declaro un neto y ademas hay ingredientes, se compara: una discrepancia
    // grande es una bandera roja (el reportado no cuadra con precios/costes).
    if (reported !== undefined && d.source === "derived") {
      const tolerance = Math.max(0.01, Math.abs(reported) * 0.005);
      if (Math.abs(reported - d.netPnlUsd) > tolerance) {
        issues.push(
          `Discrepancia neto declarado vs derivado en ${t.symbol} (${t.ts}): declarado $${round(reported)}, derivado $${d.netPnlUsd}. Se usa el derivado.`
        );
      }
    }
    return {
      ...t,
      grossPnlUsd: d.grossPnlUsd ?? t.grossPnlUsd,
      netPnlUsd: d.netPnlUsd,
      pnlSource: d.source,
    };
  });
  return {
    source: params.source,
    adapter: params.adapter,
    account: params.account ?? {},
    trades,
    quality: assessDataQuality(trades),
    issues,
  };
}

/** Puente al pipeline estadistico existente: solo necesita timestamp y neto. */
export function toAuditTrades(dataset: CanonicalDataset): Array<{ timestamp: string; pnlNet: number; venue: string; assetOrPool: string; action: string }> {
  return dataset.trades
    .filter((t) => t.ts && !Number.isNaN(Date.parse(t.ts)))
    .map((t) => ({
      timestamp: t.ts,
      pnlNet: t.netPnlUsd,
      venue: t.venue === "DEX_LP" ? "BASE_DEX" : "BINANCE_SPOT",
      assetOrPool: t.symbol,
      action: t.venue === "DEX_LP" ? "DEX_ACTIVITY" : "TRADE_CLOSED",
    }));
}

function round(v: number, d = 4): number {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}
