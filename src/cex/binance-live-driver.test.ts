import { test, expect } from "bun:test";
import { BinanceLiveDriver } from "./binance-live-driver.js";

test("BinanceLiveDriver detecta cuando no esta configurado", () => {
  const driver = new BinanceLiveDriver("", "");
  expect(driver.isConfigured()).toBe(false);
});

test("BinanceLiveDriver detecta credenciales configuradas", () => {
  const driver = new BinanceLiveDriver("test_key", "test_secret");
  expect(driver.isConfigured()).toBe(true);
});

test("BinanceLiveDriver firma queries con timestamp, recvWindow y signature valida", () => {
  const driver = new BinanceLiveDriver("fake_key", "fake_secret");
  const signMethod = (driver as any).signQuery.bind(driver);

  const query = signMethod({ symbol: "BTCUSDT", side: "BUY", quantity: 0.01 });
  expect(query).toContain("symbol=BTCUSDT");
  expect(query).toContain("side=BUY");
  expect(query).toContain("quantity=0.01");
  expect(query).toContain("timestamp=");
  expect(query).toContain("recvWindow=5000");
  expect(query).toContain("signature=");
});

test("BinanceLiveDriver rechaza peticiones firmadas sin credenciales de forma segura", async () => {
  const driver = new BinanceLiveDriver("", "");
  expect(driver.getAccountBalances()).rejects.toThrow("no configurados");
});
