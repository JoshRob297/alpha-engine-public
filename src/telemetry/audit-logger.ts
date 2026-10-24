/**
 * Audit Logger en Tiempo Real (Ring Buffer Circular en Memoria y Stream SSE)
 * Registra cada evento, gatillo, inferencia y decisión táctica con timestamp ISO.
 * Mantiene los últimos 500 eventos en memoria para consulta ultrarrápida en el dashboard y API.
 */

import { ForensicAuditLogger } from "./forensic-audit-logger.js";
import { isTestEnvironment } from "../guardrails/env-guard.js";

export interface SystemAuditEvent {
  id: string;
  timestamp: string;
  category: "CEX" | "DEX" | "HEDGE" | "SETS" | "LAYA" | "SYS";
  trigger: string;       // Qué causó el evento (ej. "SETS_REACTIVE_TRIGGER", "DEX_ROTATION", "GRID_FILL")
  assetOrPool: string;   // Activo o pool implicado (ej. "BTC", "SOL", "USDC-CBBTC", "ETHUSDT")
  action: string;        // Acción ejecutada (ej. "PARALLEL_EVOLVE", "TP_PARTIAL_DCA", "REBALANCE_SHORT")
  details: string;       // Descripción técnica densa
  level: "INFO" | "WARN" | "CRITICAL";
  metrics?: Record<string, any>;
}

export class RealTimeAuditLogger {
  private static instance: RealTimeAuditLogger;
  private bufferSize: number;
  private events: SystemAuditEvent[] = [];
  private eventIdCounter = 0;

  private constructor(bufferSize = 500) {
    this.bufferSize = bufferSize;
  }

  public static getInstance(): RealTimeAuditLogger {
    if (!RealTimeAuditLogger.instance) {
      RealTimeAuditLogger.instance = new RealTimeAuditLogger();
    }
    return RealTimeAuditLogger.instance;
  }

  public record(
    category: SystemAuditEvent["category"],
    trigger: string,
    assetOrPool: string,
    action: string,
    details: string,
    level: SystemAuditEvent["level"] = "INFO",
    metrics?: Record<string, any>,
    mode: "LIVE" | "PAPER" = "PAPER"
  ): SystemAuditEvent {
    this.eventIdCounter++;
    const event: SystemAuditEvent = {
      id: `audit_${Date.now()}_${this.eventIdCounter}`,
      timestamp: new Date().toISOString(),
      category,
      trigger,
      assetOrPool,
      action,
      details,
      level,
      metrics,
    };

    this.events.unshift(event);
    if (this.events.length > this.bufferSize) {
      this.events.pop();
    }

    // Persistencia forense inmediata en disco por fecha (1 a 1 sin límite).
    // En entorno de pruebas NO se escribe a disco: el buffer en memoria sigue
    // disponible para las aserciones, pero el log forense de produccion queda
    // aislado de datos sinteticos (stubs de ordenes, precios mock, orderId=1).
    if (!isTestEnvironment()) {
      try {
        ForensicAuditLogger.getInstance().logEvent(
          mode,
          category,
          trigger,
          assetOrPool,
          action,
          details,
          level,
          metrics
        );
      } catch {}
    }

    return event;
  }

  public getRecentEvents(limit = 100, category?: string): SystemAuditEvent[] {
    if (category) {
      return this.events.filter((e) => e.category === category).slice(0, limit);
    }
    return this.events.slice(0, limit);
  }

  public clear() {
    this.events = [];
  }
}
