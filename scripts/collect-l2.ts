/**
 * Recolector de Libro de Órdenes L2 (Binance Spot, partial depth 100ms)
 *
 * Propósito: alimentar el test de poder predictivo de Laya (Fase 2).
 * Escribe un JSONL append-only por símbolo con snapshots de las top-N profundidades
 * y el mid-price, suficiente para calcular OFI, spread, depth ratio y retornos futuros.
 *
 * Uso:  bun run scripts/collect-l2.ts --symbol BTCUSDT --minutes 30
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const SYMBOL = arg("symbol", "BTCUSDT").toUpperCase();
const STREAM_SYMBOL = SYMBOL.toLowerCase();
const MINUTES = parseFloat(arg("minutes", "30"));
const OUT_DIR = arg("out", "data/l2");
const LEVELS = parseInt(arg("levels", "20"), 10);

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const FILE = join(OUT_DIR, `${SYMBOL}_${stamp}.jsonl`);

const URL = `wss://stream.binance.com:9443/ws/${STREAM_SYMBOL}@depth${LEVELS}@100ms`;
const deadline = Date.now() + MINUTES * 60_000;

let count = 0;
let lastLog = Date.now();
let ws: WebSocket | null = null;
let closing = false;

function connect() {
  if (closing || Date.now() >= deadline) return;
  ws = new WebSocket(URL);

  ws.onopen = () => console.log(`[L2] Conectado a Binance: ${STREAM_SYMBOL}@depth${LEVELS}@100ms`);

  ws.onmessage = (ev: MessageEvent) => {
    try {
      const m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      const bids: Array<[string, string]> = m.bids || [];
      const asks: Array<[string, string]> = m.asks || [];
      if (bids.length === 0 || asks.length === 0) return;
      const bid = parseFloat(bids[0][0]);
      const ask = parseFloat(asks[0][0]);
      const mid = (bid + ask) / 2;
      const line = JSON.stringify({ t: Date.now(), m: mid, b: bids, a: asks });
      appendFileSync(FILE, line + "\n");

      count++;
      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        console.log(`[L2] ${count} snapshots | ${remaining}s restantes | mid=${mid.toFixed(2)}`);
      }
      if (Date.now() >= deadline && !closing) stop();
    } catch {
      // ignorar mensajes malformados
    }
  };

  ws.onerror = () => console.warn("[L2] Error de websocket; reconectando...");
  ws.onclose = () => {
    if (!closing && Date.now() < deadline) setTimeout(connect, 1500);
  };
}

function stop() {
  closing = true;
  try { ws?.close(); } catch {}
  console.log(`\n[L2] Recolección finalizada. ${count} snapshots escritos en ${FILE}`);
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(`[L2] Recolectando ${SYMBOL} durante ${MINUTES} min -> ${FILE}`);
connect();
