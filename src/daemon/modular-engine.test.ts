import { test, expect, describe } from "bun:test";
import { DynamicAlphaOrchestrator } from "./dynamic-orchestrator.js";
import { CexEngine } from "./cex-engine.js";
import { DexEngine } from "./dex-engine.js";
import { CapitalAllocator } from "./capital-allocator.js";

describe("Modular Engine Core Tests", () => {
  test("DynamicAlphaOrchestrator inicializa sus 4 sub-motores correctamente", () => {
    const orch = new DynamicAlphaOrchestrator(1000);
    expect(orch.getCexEngine()).toBeDefined();
    expect(orch.getDexEngine()).toBeDefined();
    expect(orch.getCapitalAllocator()).toBeDefined();
    expect(orch.getHttpServerManager()).toBeDefined();
  });

  test("CexEngine inicializa analizadores de OFI por activo bajo demanda", () => {
    const orch = new DynamicAlphaOrchestrator(1000);
    const cex = new CexEngine(orch);
    const ofiBtc = cex.getOfiAnalyzer("BTC");
    expect(ofiBtc).toBeDefined();
    expect(cex.getOfiAnalyzer("BTC")).toBe(ofiBtc);
  });

  test("DexEngine instancia correctamente con el orquestador", () => {
    const orch = new DynamicAlphaOrchestrator(1000);
    const dex = new DexEngine(orch);
    expect(dex).toBeDefined();
  });

  test("CapitalAllocator instancia correctamente con el orquestador", () => {
    const orch = new DynamicAlphaOrchestrator(1000);
    const allocator = new CapitalAllocator(orch);
    expect(allocator).toBeDefined();
  });

  test.skipIf(process.env.OFFLINE === "1")("CapitalAllocator sincroniza dinámicamente los pools de Base L2 sin slots quemados", async () => {
    const orch = new DynamicAlphaOrchestrator(1000);
    const allocator = new CapitalAllocator(orch);
    await allocator.syncWithWatchlist();

    const dexPositions = orch.getDexPositions();
    expect(dexPositions.size).toBeGreaterThanOrEqual(2);

    for (const [poolKey, item] of dexPositions.entries()) {
      expect(poolKey).toBe(item.pool.symbol);
      expect(item.pool.chain).toBe("Base");
      expect(item.engine.getSnapshot().currentCapitalUsd).toBeGreaterThan(0);
    }
  });
});
