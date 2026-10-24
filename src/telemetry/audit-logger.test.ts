import { test, expect } from "bun:test";
import { RealTimeAuditLogger } from "./audit-logger.js";

test("RealTimeAuditLogger instancia singleton y registra eventos en buffer circular", () => {
  const logger = RealTimeAuditLogger.getInstance();
  logger.clear();

  const event1 = logger.record(
    "CEX",
    "GRID_INITIALIZATION",
    "BTC",
    "OPEN_GRID_L1",
    "Malla desplegada a $84,332 USD",
    "INFO",
    { midPrice: 84332 }
  );

  expect(event1.id).toBeDefined();
  expect(event1.category).toBe("CEX");
  expect(event1.assetOrPool).toBe("BTC");

  const event2 = logger.record(
    "SETS",
    "REACTIVE_EVOLUTION_TRIGGER",
    "SOL",
    "MUTATE_GENOME_PARALLEL",
    "Genoma mutado en 22 hilos ante 89% toxicidad",
    "WARN"
  );

  const recent = logger.getRecentEvents(10);
  expect(recent.length).toBe(2);
  expect(recent[0].category).toBe("SETS"); // Más reciente primero
  expect(recent[1].category).toBe("CEX");

  const filteredSets = logger.getRecentEvents(10, "SETS");
  expect(filteredSets.length).toBe(1);
  expect(filteredSets[0].trigger).toBe("REACTIVE_EVOLUTION_TRIGGER");
});
