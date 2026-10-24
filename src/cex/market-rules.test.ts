import { describe, it, expect, beforeAll } from "bun:test";
import { MarketRulesManager } from "./market-rules.js";

describe("MarketRulesManager - Binance Exchange Info & Filter Validation", () => {
  let rulesMgr: MarketRulesManager;

  beforeAll(async () => {
    rulesMgr = new MarketRulesManager();
    await rulesMgr.syncSymbols(["BTCUSDT", "SOLUSDT", "AVAXUSDT", "SUIUSDT"]);
  });

  it("Sincroniza y extrae reglas reales de Binance para los 4 pares", () => {
    const btc = rulesMgr.getRules("BTCUSDT");
    const sol = rulesMgr.getRules("SOLUSDT");
    const avax = rulesMgr.getRules("AVAXUSDT");
    const sui = rulesMgr.getRules("SUIUSDT");

    expect(btc).toBeDefined();
    expect(sol).toBeDefined();
    expect(avax).toBeDefined();
    expect(sui).toBeDefined();

    expect(btc?.stepSize).toBe(0.00001);
    expect(btc?.minNotional).toBe(5);
    expect(sol?.stepSize).toBe(0.001);
    expect(sui?.stepSize).toBe(0.1);
  });

  it("Sanitiza correctamente orden válida de BTC cumpliendo minNotional", () => {
    // 0.001 BTC a $65,432.12 = $65.43 USD (> $5 USD)
    const res = rulesMgr.sanitizeOrder("BTCUSDT", 65432.128, 0.001054321);
    expect(res.valid).toBe(true);
    expect(res.price).toBe(65432.13); // Redondeado a tickSize 0.01
    expect(res.qty).toBe(0.00105); // Truncado a stepSize 0.00001
    expect(res.notional).toBeGreaterThanOrEqual(5.0);
  });

  it("Rechaza orden inferior a minNotional ($5 USD)", () => {
    // 0.00001 BTC a $60,000 = $0.60 USD (< $5 USD)
    const res = rulesMgr.sanitizeOrder("BTCUSDT", 60000, 0.00001);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("Valor nocional de la orden");
  });

  it("Rechaza cantidad inferior al lote mínimo (minQty)", () => {
    // SOL minQty es 0.001
    const res = rulesMgr.sanitizeOrder("SOLUSDT", 150, 0.0005);
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("inferior al lote mínimo");
  });

  it("Ajusta correctamente decimales para SUI (stepSize 0.1)", () => {
    // 15.48 SUI a $1.8543 = $28.55 USD (> $5)
    const res = rulesMgr.sanitizeOrder("SUIUSDT", 1.85432, 15.48);
    expect(res.valid).toBe(true);
    expect(res.qty).toBe(15.4); // Truncado a stepSize 0.1
    expect(res.price).toBe(1.8543); // Tick size 0.0001
  });
});
