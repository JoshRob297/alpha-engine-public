/**
 * Adaptador generico: cualquier bot/export que se pueda mapear a un contrato explicito.
 *
 * Acepta JSON (array de objetos), JSONL o CSV/TSV, y un mapeo de campos:
 *
 *   {
 *     "ts": "open_time",              // clave o ruta con puntos
 *     "symbol": "symbol",
 *     "qty": "lots",                  // opcional
 *     "entryPrice": "open_price",
 *     "exitPrice": "close_price",
 *     "pnlNet": "profit",             // PnL declarado (se verifica, no se confia)
 *     "fees": "commission",
 *     "slippage": "slippage",
 *     "venue": "market"
 *   }
 *
 * Reglas:
 *  - Timestamps: ISO, epoch en segundos o milisegundos, o "YYYY-MM-DD HH:mm:ss"
 *    (sin zona se interpreta UTC y se registra como supuesto).
 *  - Si `fees` no esta mapeado o falta en la fila, el trade queda "mixed"/"reported"
 *    y la calidad del dataset baja: el kit no inventa costes.
 *  - Filas sin timestamp valido se descartan y se cuentan en `issues`.
 *
 * Este adaptador es la respuesta a "cada bot hace lo suyo": no hay formato universal,
 * hay un contrato canonico y un mapeo declarado por fuente.
 */

import { buildDataset, type CanonicalDataset, type CanonicalVenue } from "../canonical.js";

export interface GenericMapping {
  ts: string;
  symbol: string;
  qty?: string;
  entryPrice?: string;
  exitPrice?: string;
  pnlNet?: string;
  fees?: string;
  /** Costes adicionales a sumar a `fees` (p. ej. MT4: ["swap"]). */
  extraCosts?: string[];
  /**
   * Convencion de signo de los costes:
   *  - "positive" (default): el campo ya es un coste positivo.
   *  - "negative": el broker reporta costes con signo (MT4/MT5: commission=-1.2, swap=-0.3).
   */
  costSign?: "positive" | "negative";
  slippage?: string;
  venue?: string;
  notional?: string;
  /**
   * Naturaleza del campo de PnL mapeado. NO hay default util: si no se declara se trata como
   * "unknown" (no verificable) y el dataset baja a INSUFFICIENT.
   *  - "gross": el campo es bruto y los costes vienen aparte (MT4/MT5, Binance).
   *  - "net": el campo ya descuenta costes; se conserva como afirmacion y se contrasta.
   *  - "unknown" (default): se usa como neto declarado, sin verificacion.
   */
  pnlKind?: "gross" | "net" | "unknown";
}

export interface GenericAdapterOptions {
  mapping: GenericMapping;
  source: string;
  format?: "json" | "jsonl" | "csv";
  /** Delimitador CSV. Si se omite, se autodetecta del encabezado (; , o tab). */
  delimiter?: string;
  /** Prefijo de venue para filas sin columna de venue. */
  defaultVenue?: CanonicalVenue;
  capitalUsd?: number;
}

export function adaptGeneric(input: string | Array<Record<string, unknown>>, opts: GenericAdapterOptions): CanonicalDataset {
  const issues: string[] = [];
  let records: Array<Record<string, unknown>>;

  if (Array.isArray(input)) {
    records = input;
  } else {
    const format = opts.format ?? detectFormat(input);
    const delimiter = opts.delimiter ?? detectDelimiter(input);
    if (opts.delimiter === undefined && format === "csv") issues.push(`Delimitador CSV autodetectado: "${delimiter}".`);
    records = parseRecords(input, format, delimiter, issues);
  }

  const trades = [];
  let droppedNoTs = 0;

  for (const rec of records) {
    const tsRaw = pick(rec, opts.mapping.ts);
    const ts = normalizeTimestamp(tsRaw, issues);
    if (!ts) {
      droppedNoTs++;
      continue;
    }
    const symbol = String(pick(rec, opts.mapping.symbol) ?? "").trim();
    if (!symbol) {
      issues.push(`Fila sin simbolo descartada (ts=${ts}).`);
      continue;
    }

    const num = (key?: string): number | undefined => {
      if (!key) return undefined;
      const raw = pick(rec, key);
      if (raw === undefined || raw === null || raw === "") return undefined;
      const n = typeof raw === "number" ? raw : parseFloat(String(raw).replace(/[, ]/g, ""));
      return Number.isFinite(n) ? n : undefined;
    };

    // MT4/MT5 y varios brokers separan `commission` y `swap`: ambos son coste.
    const baseFees = num(opts.mapping.fees);
    const extra = (opts.mapping.extraCosts ?? []).reduce((acc, k) => acc + (num(k) ?? 0), 0);
    const rawCosts = baseFees === undefined && extra === 0 ? undefined : (baseFees ?? 0) + extra;
    const fees = rawCosts === undefined ? undefined : opts.mapping.costSign === "negative" ? -rawCosts : rawCosts;
    const slippage = num(opts.mapping.slippage);
    const venueRaw = opts.mapping.venue ? String(pick(rec, opts.mapping.venue) ?? "").toLowerCase() : "";
    const venue: CanonicalVenue = venueRaw.includes("dex") || venueRaw.includes("lp")
      ? "DEX_LP"
      : venueRaw.includes("fut")
      ? "FUTURES"
      : opts.defaultVenue ?? "CEX";

    trades.push({
      id: String(pick(rec, "ticket") ?? pick(rec, "id") ?? `${symbol}-${ts}`),
      ts,
      venue,
      symbol,
      qty: num(opts.mapping.qty),
      entryPrice: num(opts.mapping.entryPrice),
      exitPrice: num(opts.mapping.exitPrice),
      notionalUsd: num(opts.mapping.notional),
      grossPnlUsd:
        opts.mapping.pnlNet && (opts.mapping.pnlKind ?? "unknown") === "gross" ? num(opts.mapping.pnlNet) : undefined,
      feesUsd: fees,
      slippageUsd: slippage,
      netPnlUsd: num(opts.mapping.pnlNet) ?? 0,
      reportedNetPnlUsd:
        opts.mapping.pnlNet && (opts.mapping.pnlKind ?? "unknown") === "net" ? num(opts.mapping.pnlNet) : undefined,
      raw: rec,
    });
  }

  if (droppedNoTs > 0) issues.push(`${droppedNoTs} fila(s) sin timestamp valido descartadas.`);
  // Si solo vino un PnL declarado y hay costes aparte, el "neto" del campo es bruto:
  // se corrige restringiendo grossPnlUsd y dejando que la derivacion reste costes.
  return buildDataset({
    source: opts.source,
    adapter: "generic",
    account: { capitalUsd: opts.capitalUsd },
    trades,
    issues,
  });
}

export function detectFormat(text: string): "json" | "jsonl" | "csv" {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return "csv";
  // JSON completo (incluye objetos pretty-printed de varias lineas).
  try {
    JSON.parse(trimmed);
    return "json";
  } catch {}
  // Fallback: JSONL (una linea = un objeto).
  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length > 1 && lines.every((l) => l.trim().startsWith("{"))) return "jsonl";
  return "json";
}

function parseRecords(
  text: string,
  format: "json" | "jsonl" | "csv",
  delimiter: string,
  issues: string[]
): Array<Record<string, unknown>> {
  if (format === "json") {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      // Acepta { trades: [...] } y { data: [...] } como envoltorios comunes.
      if (parsed && Array.isArray(parsed.trades)) return parsed.trades;
      if (parsed && Array.isArray(parsed.data)) return parsed.data;
      return [parsed];
    } catch (err: any) {
      issues.push(`JSON invalido: ${err?.message || err}`);
      return [];
    }
  }
  if (format === "jsonl") {
    const out: Array<Record<string, unknown>> = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        issues.push("Linea JSONL invalida descartada.");
      }
    }
    return out;
  }
  const rows = parseCsv(text, delimiter);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => {
      const rec: Record<string, unknown> = {};
      header.forEach((h, i) => (rec[h] = r[i]?.trim() ?? ""));
      return rec;
    });
}

/** Detecta el delimitador por frecuencia en la primera linea (no vacia). */
export function detectDelimiter(text: string): string {
  const header = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const candidates = [";", ",", "\t", "|"];
  let best = ",";
  let bestCount = 0;
  for (const c of candidates) {
    const count = header.split(c).length - 1;
    if (count > bestCount) {
      best = c;
      bestCount = count;
    }
  }
  return bestCount === 0 ? "," : best;
}

function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function pick(rec: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  if (path in rec) return rec[path];
  return path.split(".").reduce<any>((acc, key) => (acc == null ? undefined : acc[key]), rec);
}

function normalizeTimestamp(raw: unknown, issues: string[]): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw === "number" || /^\d+$/.test(String(raw))) {
    const n = Number(raw);
    // epoch en segundos si es menor a 3e10, si no milisegundos
    const ms = n < 3e10 ? n * 1000 : n;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(raw).trim();
  const direct = new Date(s);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  // "YYYY-MM-DD HH:mm:ss" sin zona: se asume UTC (se registra)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}Z`;
    issues.push(`Timestamp sin zona asumido UTC: "${s}".`);
    return iso;
  }
  return null;
}
