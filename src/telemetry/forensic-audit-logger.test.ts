import { test, expect } from "bun:test";
import { ForensicAuditLogger } from "./forensic-audit-logger.js";
import { existsSync, rmSync } from "node:fs";

test("ForensicAuditLogger persiste eventos en disco separados por modo Live y Paper", () => {
  const testDir = "/tmp/opencode/test_audit_logs";
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });

  const logger = ForensicAuditLogger.getInstance(testDir);

  const paperEv = logger.logEvent(
    "PAPER",
    "CEX",
    "GRID_FILL",
    "BTC",
    "FILL_L1",
    "Llenado simulado de L1",
    "INFO",
    { price: 84332 }
  );

  const liveEv = logger.logEvent(
    "LIVE",
    "CEX",
    "ORDER_PLACED",
    "BTC",
    "POST_ONLY_MAKER",
    "Orden real colocada en Binance",
    "INFO",
    { price: 84332 }
  );

  expect(paperEv.mode).toBe("PAPER");
  expect(liveEv.mode).toBe("LIVE");

  const paperHistory = logger.queryHistoricalLogs("PAPER", undefined, 10);
  expect(paperHistory.length).toBe(1);
  expect(paperHistory[0].trigger).toBe("GRID_FILL");

  const liveHistory = logger.queryHistoricalLogs("LIVE", undefined, 10);
  expect(liveHistory.length).toBe(1);
  expect(liveHistory[0].trigger).toBe("ORDER_PLACED");
});
