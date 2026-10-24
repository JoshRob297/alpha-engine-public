import { test, expect } from "bun:test";
import { MemorySentinel } from "./memory-sentinel.js";

test("MemorySentinel evalúa la memoria y respeta el umbral de 160 MB", () => {
  const sentinel = MemorySentinel.getInstance(160);
  const status = sentinel.getStatus();

  expect(status.thresholdMb).toBe(160);
  expect(status.rssMb).toBeGreaterThan(0);
  expect(status.status).toBe("OPTIMAL");

  const audit = sentinel.checkAndCompact();
  expect(audit.cleanupsTriggered).toBeGreaterThanOrEqual(0);
  expect(["OPTIMAL", "COMPACTED"]).toContain(audit.status);
});
