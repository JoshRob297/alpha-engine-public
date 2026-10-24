/**
 * RiskGuard — Guardarraíles duros de producción (Fase 0).
 *
 * Enforce límites no negociables antes de abrir nuevas posiciones:
 *  - Pérdida realizada máxima por día (kill-switch automático).
 *  - Exposición agregada máxima (BTC+SOL correlacionados cuentan juntos).
 *  - Exposición máxima por activo.
 *  - Kill-switch manual (por API/Telegram).
 *
 * IMPORTANTE: el kill-switch BLOQUEA nuevas entradas pero NUNCA bloquea salidas.
 */

export interface RiskLimits {
  /** Pérdida realizada máxima por día en USD (kill-switch automático). */
  maxDailyLossUsd: number;
  /** Exposición agregada máxima como fracción del capital (0-1). */
  maxAggregateExposurePct: number;
  /** Exposición máxima por activo como fracción del capital (0-1). */
  maxSingleAssetExposurePct: number;
}

export interface RiskExposureInput {
  ticker: string;
  inventoryUsd: number;
}

export interface RiskEvaluationInput {
  capitalUsd: number;
  exposures: RiskExposureInput[];
  /** Trades cerrados (venue CEX) con timestamp ISO y pnlNet. */
  closedTrades: Array<{ timestamp: string; venue: string; pnlNet: number }>;
}

export interface RiskStatus {
  killed: boolean;
  killReason: string | null;
  killSource: "AUTO" | "MANUAL" | null;
  killedAt: string | null;
  dailyRealizedPnlUsd: number;
  dailyLossLimitUsd: number;
  aggregateExposureUsd: number;
  aggregateExposureLimitUsd: number;
  exposureUtilizationPct: number;
  perAssetExposure: Array<{ ticker: string; inventoryUsd: number; limitUsd: number; breached: boolean }>;
  breaches: string[];
  limits: RiskLimits;
  evaluatedAt: string;
}

function startOfUtcDay(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export class RiskGuard {
  private limits: RiskLimits;
  private manualKill = false;
  private autoKilled = false;
  private killReason: string | null = null;
  private killSource: "AUTO" | "MANUAL" | null = null;
  private killedAt: string | null = null;
  private lastStatus: RiskStatus | null = null;

  constructor(limits: Partial<RiskLimits> = {}) {
    this.limits = {
      maxDailyLossUsd: limits.maxDailyLossUsd ?? 3.0,
      maxAggregateExposurePct: limits.maxAggregateExposurePct ?? 0.70,
      maxSingleAssetExposurePct: limits.maxSingleAssetExposurePct ?? 0.50,
    };
  }

  public getLimits(): RiskLimits {
    return { ...this.limits };
  }

  public isKilled(): boolean {
    return this.manualKill || this.autoKilled;
  }

  public getStatus(): RiskStatus | null {
    return this.lastStatus;
  }

  public manualKillSwitch(reason = "Kill-switch manual activado por el operador."): void {
    this.manualKill = true;
    this.killReason = reason;
    this.killSource = "MANUAL";
    this.killedAt = new Date().toISOString();
  }

  public clearKill(): void {
    this.manualKill = false;
    this.autoKilled = false;
    this.killReason = null;
    this.killSource = null;
    this.killedAt = null;
    if (this.lastStatus) {
      this.lastStatus.killed = false;
      this.lastStatus.killReason = null;
      this.lastStatus.killSource = null;
      this.lastStatus.killedAt = null;
    }
  }

  /**
   * Evalúa el estado de riesgo. Actualiza el kill-switch automático por límite de pérdida diaria.
   */
  public evaluate(input: RiskEvaluationInput): RiskStatus {
    const capitalUsd = Math.max(input.capitalUsd, 1);
    const dayStart = startOfUtcDay();

    const dailyRealizedPnlUsd = input.closedTrades
      .filter((t) => t.venue !== "BASE_DEX")
      .filter((t) => new Date(t.timestamp).getTime() >= dayStart)
      .reduce((a, t) => a + (t.pnlNet || 0), 0);

    const aggregateExposureUsd = input.exposures.reduce((a, e) => a + e.inventoryUsd, 0);
    const aggregateExposureLimitUsd = capitalUsd * this.limits.maxAggregateExposurePct;
    const singleLimitUsd = capitalUsd * this.limits.maxSingleAssetExposurePct;

    const perAssetExposure = input.exposures.map((e) => ({
      ticker: e.ticker,
      inventoryUsd: parseFloat(e.inventoryUsd.toFixed(4)),
      limitUsd: parseFloat(singleLimitUsd.toFixed(2)),
      breached: e.inventoryUsd > singleLimitUsd,
    }));

    const breaches: string[] = [];

    // Kill-switch automático por pérdida diaria.
    if (dailyRealizedPnlUsd <= -this.limits.maxDailyLossUsd && !this.autoKilled) {
      this.autoKilled = true;
      this.killReason = `Límite de pérdida diaria excedido: $${dailyRealizedPnlUsd.toFixed(2)} <= -$${this.limits.maxDailyLossUsd.toFixed(2)} USD.`;
      this.killSource = "AUTO";
      this.killedAt = new Date().toISOString();
      console.warn(`[RISK GUARD] ${this.killReason} Nuevas entradas BLOQUEADAS.`);
    }
    if (this.autoKilled) breaches.push(`DAILY_LOSS_LIMIT: $${dailyRealizedPnlUsd.toFixed(2)}`);

    if (aggregateExposureUsd > aggregateExposureLimitUsd) {
      breaches.push(`AGGREGATE_EXPOSURE: $${aggregateExposureUsd.toFixed(2)} > $${aggregateExposureLimitUsd.toFixed(2)}`);
    }
    for (const p of perAssetExposure) {
      if (p.breached) breaches.push(`${p.ticker}_EXPOSURE: $${p.inventoryUsd.toFixed(2)} > $${p.limitUsd.toFixed(2)}`);
    }

    const status: RiskStatus = {
      killed: this.isKilled(),
      killReason: this.killReason,
      killSource: this.killSource,
      killedAt: this.killedAt,
      dailyRealizedPnlUsd: parseFloat(dailyRealizedPnlUsd.toFixed(4)),
      dailyLossLimitUsd: this.limits.maxDailyLossUsd,
      aggregateExposureUsd: parseFloat(aggregateExposureUsd.toFixed(4)),
      aggregateExposureLimitUsd: parseFloat(aggregateExposureLimitUsd.toFixed(2)),
      exposureUtilizationPct: parseFloat(((aggregateExposureUsd / aggregateExposureLimitUsd) * 100).toFixed(1)),
      perAssetExposure,
      breaches,
      limits: this.getLimits(),
      evaluatedAt: new Date().toISOString(),
    };

    this.lastStatus = status;
    return status;
  }
}
