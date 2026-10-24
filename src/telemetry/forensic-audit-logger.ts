/**
 * Registrador Forense Persistente de Auditoría (Append-Only JSONL en Disco)
 * Aislamiento Estricto 1 a 1 entre Live y Simulación.
 * Escribe inmediatamente a disco:
 * - data/audit_logs/live_audit_YYYY-MM-DD.jsonl
 * - data/audit_logs/sim_audit_YYYY-MM-DD.jsonl
 * Soporta streaming de líneas para consulta histórica con cero sobrecarga en RAM.
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { isTestEnvironment } from "../guardrails/env-guard.js";
import { computeRecordHash, GENESIS_HASH } from "./audit-chain.js";

export interface ForensicLogEvent {
  id: string;
  timestamp: string;
  mode: "LIVE" | "PAPER";
  category: "CEX" | "DEX" | "HEDGE" | "SETS" | "LAYA" | "SYS";
  trigger: string;
  asset: string;
  action: string;
  details: string;
  level: "INFO" | "WARN" | "CRITICAL";
  metrics?: Record<string, any>;
  /** Hash del registro anterior del mismo archivo (GENESIS_HASH si es el primero). */
  prevHash: string;
  /** sha256 de `${prevHash}|${canonical}`: ancla a prueba de reescritura. */
  hash: string;
}

export class ForensicAuditLogger {
  private static instances: Map<string, ForensicAuditLogger> = new Map();
  /** Maximo de bytes leidos del final del archivo para resolver el ultimo hash. */
  private static readonly TAIL_READ_BYTES = 64 * 1024;
  private logsDir: string;
  /** Ultimo hash escrito por archivo (en memoria): mantiene la cadena continua. */
  private lastHashByFile: Map<string, string> = new Map();

  private constructor(logsDir = "data/audit_logs") {
    this.logsDir = logsDir;
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true });
    }
  }

  /**
   * Devuelve la instancia singleton por directorio. En producción solo se usa el
   * directorio por defecto; el aislamiento por directorio garantiza que las pruebas
   * no colisionen con el estado persistente real.
   */
  public static getInstance(logsDir = "data/audit_logs"): ForensicAuditLogger {
    if (!ForensicAuditLogger.instances.has(logsDir)) {
      ForensicAuditLogger.instances.set(logsDir, new ForensicAuditLogger(logsDir));
    }
    return ForensicAuditLogger.instances.get(logsDir)!;
  }

  /**
   * Escribe un evento forense en el archivo diario correspondiente según el modo (Live vs Paper).
   */
  public logEvent(
    mode: "LIVE" | "PAPER",
    category: ForensicLogEvent["category"],
    trigger: string,
    asset: string,
    action: string,
    details: string,
    level: ForensicLogEvent["level"] = "INFO",
    metrics?: Record<string, any>
  ): ForensicLogEvent {
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const prefix = mode === "LIVE" ? "live_audit" : "sim_audit";
    const filename = `${prefix}_${dateStr}.jsonl`;
    const filePath = join(this.logsDir, filename);

    // Barrera dura: el directorio por defecto es el log forense de produccion.
    // Un test nunca debe escribir ahi (ni en LIVE ni en PAPER).
    if (this.logsDir === "data/audit_logs" && isTestEnvironment()) {
      throw new Error(
        "[FORENSIC GUARD] Escritura de test bloqueada hacia el log forense de produccion (data/audit_logs). Use un directorio temporal."
      );
    }

    const event: ForensicLogEvent = {
      id: `forensic_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: now.toISOString(),
      mode,
      category,
      trigger,
      asset,
      action,
      details,
      level,
      metrics,
      prevHash: GENESIS_HASH,
      hash: "",
    };

    // Cadena de hashes POR ARCHIVO: el hash se calcula con el mismo canonicalizador
    // que usa el verificador (claves ordenadas, sin `hash`/`prevHash`), pero solo se
    // firma el contenido del evento. El archivo se sigue escribiendo en append.
    event.prevHash = this.resolvePreviousHash(filePath);
    // El canonicalizador ignora `hash`/`prevHash` del nivel superior: firmar el
    // evento completo es estable frente al mismo calculo que hace verifyChain.
    event.hash = computeRecordHash(event as unknown as Record<string, unknown>, event.prevHash);

    try {
      appendFileSync(filePath, JSON.stringify(event) + "\n", "utf-8");
      // Solo avanzamos el eslabón cuando la escritura fue efectiva.
      this.lastHashByFile.set(filePath, event.hash);
    } catch (err) {
      console.error("[FORENSIC LOGGER ERROR] Fallo al escribir en disco:", err);
    }

    return event;
  }

  /**
   * Devuelve el hash del ultimo registro de la cadena del archivo.
   *
   * En arranque en frio (proceso nuevo sobre un archivo existente) se resuelve
   * una unica vez leyendo la ULTIMA linea del archivo (solo la cola, para no
   * cargar el log entero en memoria). Si el archivo no existe o su ultima linea
   * es pre-cadena (sin hash), la cadena arranca en GENESIS_HASH. El archivo nunca
   * se reescribe.
   */
  private resolvePreviousHash(filePath: string): string {
    const cached = this.lastHashByFile.get(filePath);
    if (cached !== undefined) return cached;

    let prev = GENESIS_HASH;
    const lastLine = this.readLastLine(filePath);
    if (lastLine) {
      try {
        const parsed = JSON.parse(lastLine) as Record<string, unknown>;
        if (parsed && typeof parsed.hash === "string" && parsed.hash.length > 0) {
          prev = parsed.hash;
        }
      } catch {}
    }

    this.lastHashByFile.set(filePath, prev);
    return prev;
  }

  /** Lee la ultima linea no vacia del archivo leyendo solo su cola. */
  private readLastLine(filePath: string): string | null {
    let fd: number | undefined;
    try {
      if (!existsSync(filePath)) return null;
      const size = statSync(filePath).size;
      if (size === 0) return null;

      const start = Math.max(0, size - ForensicAuditLogger.TAIL_READ_BYTES);
      const length = size - start;
      const buffer = Buffer.allocUnsafe(length);
      fd = openSync(filePath, "r");
      readSync(fd, buffer, 0, length, start);

      const lines = buffer.toString("utf-8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line) return line;
      }
      return null;
    } catch {
      return null;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
      }
    }
  }

  /**
   * Consulta el historial forense de un día específico con límite y filtro de categoría.
   */
  public queryHistoricalLogs(
    mode: "LIVE" | "PAPER",
    dateStr?: string,
    limit = 100,
    category?: string,
    asset?: string
  ): ForensicLogEvent[] {
    const targetDate = dateStr || new Date().toISOString().split("T")[0];
    const prefix = mode === "LIVE" ? "live_audit" : "sim_audit";
    const filename = `${prefix}_${targetDate}.jsonl`;
    const filePath = join(this.logsDir, filename);

    if (!existsSync(filePath)) {
      return [];
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n");
      const events: ForensicLogEvent[] = [];

      // Leer de las más recientes a las más antiguas
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]) continue;
        try {
          const parsed: ForensicLogEvent = JSON.parse(lines[i]);
          if (category && parsed.category !== category) continue;
          if (asset && parsed.asset !== asset && !parsed.asset?.includes(asset)) continue;
          events.push(parsed);
        } catch {}
        if (events.length >= limit) break;
      }

      return events;
    } catch {
      return [];
    }
  }

  /**
   * Lista las fechas disponibles con logs registrados.
   */
  public listAvailableDates(mode: "LIVE" | "PAPER"): string[] {
    if (!existsSync(this.logsDir)) return [];
    const prefix = mode === "LIVE" ? "live_audit" : "sim_audit";
    const files = readdirSync(this.logsDir);
    const dates: string[] = [];

    for (const f of files) {
      if (f.startsWith(prefix) && f.endsWith(".jsonl")) {
        const match = f.match(/_(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (match) dates.push(match[1]);
      }
    }

    return dates.sort().reverse();
  }
}
