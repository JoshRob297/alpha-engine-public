#!/usr/bin/env bun
/**
 * Watcher de deposito en Base L2 para el despliegue manual del pool WETH-CBBTC
 * (Aerodrome Slipstream).
 *
 * Que hace:
 *  1. Monitorea el balance de la hot wallet (red Base) con intervalos configurables.
 *  2. Si el balance cambia, lo registra (audit log encadenado) y notifica por Telegram.
 *  3. Si supera el umbral de despliegue, avisa que hay fondos listos y termina.
 *
 * Que NO hace (por diseño):
 *  - NO firma ni envia ninguna transaccion. El minteo de la posicion es un paso manual
 *    y explicito. La clave privada solo se lee de `.env.secrets` cuando hay fondos.
 *  - NO proyecta APR en las alertas: las proyecciones no son hechos y no se mezclan con
 *    saldos reales (misma regla que el dashboard: solo numeros auditados).
 *
 * Higiene operativa:
 *  - Log solo en cambios de estado + heartbeat cada `HEARTBEAT_MS` (antes escribia una
 *    linea cada 15 s: ~5.760 lineas/dia de ruido en el journal).
 *  - Poll cada 60 s por defecto, con backoff exponencial ante errores del RPC.
 *
 * Uso:
 *   bun run scripts/deploy-pool.ts            # watcher continuo
 *   bun run scripts/deploy-pool.ts --once     # un solo chequeo (ops)
 *
 * Variables: BASE_WATCH_INTERVAL_MS (default 60000), BASE_WATCH_HEARTBEAT_MS (default 3600000),
 *            BASE_WATCH_THRESHOLD_ETH (default 0.005).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ethers } from "ethers";
import { sendTelegramAlert } from "../src/telemetry/notifier.js";
import { AERODROME_POSITION_MANAGER_ADDRESS, BASE_RPC_URL } from "../src/dex/aerodrome-contract.js";
import { RealTimeAuditLogger } from "../src/telemetry/audit-logger.js";

const SECRETS_FILE = join(homedir(), ".env.secrets");
const POLL_MS = Math.max(15_000, parseInt(process.env.BASE_WATCH_INTERVAL_MS || "60000", 10));
const HEARTBEAT_MS = Math.max(POLL_MS, parseInt(process.env.BASE_WATCH_HEARTBEAT_MS || "3600000", 10));
const THRESHOLD_ETH = parseFloat(process.env.BASE_WATCH_THRESHOLD_ETH || "0.005");
const ONCE = process.argv.includes("--once");

const WETH_ADDRESS = "0x4200000000000000000000000000000000000006";
const CBBTC_ADDRESS = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function audit(action: string, details: string, metrics: Record<string, unknown>, level: "INFO" | "WARN" = "INFO"): void {
  try {
    RealTimeAuditLogger.getInstance().record(
      "SYS",
      "CAPITAL_CONSERVATION",
      "BASE_WALLET",
      action,
      details,
      level,
      metrics,
      "PAPER"
    );
  } catch {}
}

/**
 * Resuelve la direccion a vigilar SIN retener la clave privada en el proceso.
 * Si `BASE_WALLET_ADDRESS` esta disponible (entorno o .env.secrets) se usa directo;
 * si no, se deriva de la clave una sola vez y se descarta.
 */
function resolveWatchAddress(): string | null {
  const fromEnv = process.env.BASE_WALLET_ADDRESS?.trim();
  if (fromEnv && /^0x[a-fA-F0-9]{40}$/.test(fromEnv)) return fromEnv;
  if (!existsSync(SECRETS_FILE)) {
    log(`ERROR: no existe ${SECRETS_FILE}`);
    return null;
  }
  const content = readFileSync(SECRETS_FILE, "utf-8");
  const addrMatch = content.match(/BASE_WALLET_ADDRESS=(0x[a-fA-F0-9]{40})/);
  if (addrMatch) return addrMatch[1];
  const keyMatch = content.match(/BASE_PRIVATE_KEY=(0x[a-fA-F0-9]{64})/);
  if (!keyMatch) {
    log("ERROR: no hay BASE_WALLET_ADDRESS ni BASE_PRIVATE_KEY en .env.secrets");
    return null;
  }
  const derived = new ethers.Wallet(keyMatch[1]).address;
  log("WARN: BASE_WALLET_ADDRESS no configurada; direccion derivada de la clave (agregala a .env.secrets).");
  return derived;
}

async function main(): Promise<void> {
  const address = resolveWatchAddress();
  if (!address) process.exit(1);
  const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);

  log("=== WATCHER DE DEPOSITO BASE L2 ===");
  log(`Wallet: ${address}`);
  log(`Umbral de despliegue: ${THRESHOLD_ETH} ETH | Poll: ${POLL_MS} ms | Heartbeat: ${HEARTBEAT_MS} ms`);
  log("Sin firma de transacciones: el minteo de la posicion es un paso manual.");

  let lastBalanceEth: number | null = null;
  let lastHeartbeat = 0;
  let errorStreak = 0;

  while (true) {
    let balanceEth: number | null = null;
    try {
      const balanceWei = await provider.getBalance(address);
      balanceEth = parseFloat(ethers.formatEther(balanceWei));
      errorStreak = 0;
    } catch (err: any) {
      errorStreak++;
      const backoffMs = Math.min(15 * 60_000, POLL_MS * Math.pow(2, Math.min(errorStreak, 5)));
      log(`WARN lectura de balance fallida (${errorStreak}): ${err?.message || err}. Reintento en ${Math.round(backoffMs / 1000)} s`);
      if (errorStreak === 5) {
        audit("BASE_WALLET_RPC_UNREACHABLE", `5 fallos consecutivos leyendo el balance de ${address}.`, { errorStreak }, "WARN");
        await sendTelegramAlert(
          `[ALPHA ENGINE] WATCHER BASE: 5 fallos consecutivos leyendo el balance de ${address.slice(0, 6)}...${address.slice(-4)}. Revisar RPC.`
        );
      }
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }

    const now = Date.now();
    const changed = lastBalanceEth === null || Math.abs(balanceEth - lastBalanceEth) > 1e-9;

    if (changed) {
      log(`Balance: ${balanceEth.toFixed(6)} ETH${lastBalanceEth !== null ? ` (antes ${lastBalanceEth.toFixed(6)})` : ""}`);
      audit(
        "BASE_WALLET_BALANCE_CHANGED",
        `Balance de la hot wallet Base: ${balanceEth.toFixed(6)} ETH (antes ${lastBalanceEth === null ? "n/d" : lastBalanceEth.toFixed(6)}).`,
        { address, balanceEth, previousEth: lastBalanceEth }
      );
      lastBalanceEth = balanceEth;
      lastHeartbeat = now;
    } else if (now - lastHeartbeat >= HEARTBEAT_MS) {
      log(`Heartbeat: balance sin cambios (${balanceEth.toFixed(6)} ETH). Watcher activo.`);
      lastHeartbeat = now;
    }

    if (balanceEth >= THRESHOLD_ETH) {
      log("FONDOS DETECTADOS: el despliegue es MANUAL (este watcher no firma transacciones).");
      log(`Capital disponible: ${balanceEth.toFixed(6)} ETH | Reserva sugerida de gas: 0.001 ETH`);
      log(`PositionManager: ${AERODROME_POSITION_MANAGER_ADDRESS}`);
      log(`Par: WETH (${WETH_ADDRESS.slice(0, 10)}...) / cbBTC (${CBBTC_ADDRESS.slice(0, 10)}...)`);
      audit(
        "BASE_WALLET_FUNDED",
        `Fondos detectados para despliegue manual: ${balanceEth.toFixed(6)} ETH en ${address}. No se firmo ninguna transaccion.`,
        { address, balanceEth, thresholdEth: THRESHOLD_ETH, positionManager: AERODROME_POSITION_MANAGER_ADDRESS }
      );
      await sendTelegramAlert(
        `[ALPHA ENGINE] FONDOS EN BASE L2\nAddress: ${address.slice(0, 6)}...${address.slice(-4)}\nBalance: ${balanceEth.toFixed(6)} ETH\nSiguiente paso: MANUAL. Este watcher no firma transacciones.`
      );
      log("Watcher finalizado: requiere reinicio manual para volver a vigilar.");
      return;
    }

    if (ONCE) {
      log("Modo --once: chequeo unico completado.");
      return;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error("[WATCHER ERROR]", err);
  process.exit(1);
});
