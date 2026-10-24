/**
 * Centinela de Memoria por Umbral No Invasivo (Alpha Engine)
 * Monitorea el Resident Set Size (RSS) del proceso en Bun runtime.
 * Cero limpiezas por reloj; solo interviene con Bun.gc(true) si la RAM
 * sobrepasa el umbral de seguridad de 160 MB.
 */

export interface MemoryAuditStatus {
  rssBytes: number;
  rssMb: number;
  heapUsedMb: number;
  thresholdMb: number;
  cleanupsTriggered: number;
  lastCleanupTimestamp: string | null;
  status: "OPTIMAL" | "COMPACTED";
}

export class MemorySentinel {
  private static instance: MemorySentinel;
  private thresholdBytes: number;
  private cleanupsCount = 0;
  private lastCleanupTs: string | null = null;
  private lastStatus: "OPTIMAL" | "COMPACTED" = "OPTIMAL";

  private constructor(thresholdMb = 160) {
    this.thresholdBytes = thresholdMb * 1024 * 1024;
  }

  public static getInstance(thresholdMb = 160): MemorySentinel {
    if (!MemorySentinel.instance) {
      MemorySentinel.instance = new MemorySentinel(thresholdMb);
    }
    return MemorySentinel.instance;
  }

  /**
   * Evalúa la memoria del proceso. Si supera el umbral, ejecuta compactación pasiva.
   */
  public checkAndCompact(): MemoryAuditStatus {
    const mem = process.memoryUsage();
    const currentRss = mem.rss;

    if (currentRss > this.thresholdBytes) {
      if (globalThis.Bun && typeof (globalThis.Bun as any).gc === "function") {
        (globalThis.Bun as any).gc(true); // Compactación profunda
      }
      this.cleanupsCount++;
      this.lastCleanupTs = new Date().toISOString();
      this.lastStatus = "COMPACTED";
    } else {
      this.lastStatus = "OPTIMAL";
    }

    const updatedMem = process.memoryUsage();
    return {
      rssBytes: updatedMem.rss,
      rssMb: parseFloat((updatedMem.rss / (1024 * 1024)).toFixed(2)),
      heapUsedMb: parseFloat((updatedMem.heapUsed / (1024 * 1024)).toFixed(2)),
      thresholdMb: parseFloat((this.thresholdBytes / (1024 * 1024)).toFixed(0)),
      cleanupsTriggered: this.cleanupsCount,
      lastCleanupTimestamp: this.lastCleanupTs,
      status: this.lastStatus,
    };
  }

  public getStatus(): MemoryAuditStatus {
    const mem = process.memoryUsage();
    return {
      rssBytes: mem.rss,
      rssMb: parseFloat((mem.rss / (1024 * 1024)).toFixed(2)),
      heapUsedMb: parseFloat((mem.heapUsed / (1024 * 1024)).toFixed(2)),
      thresholdMb: parseFloat((this.thresholdBytes / (1024 * 1024)).toFixed(0)),
      cleanupsTriggered: this.cleanupsCount,
      lastCleanupTimestamp: this.lastCleanupTs,
      status: this.lastStatus,
    };
  }
}
