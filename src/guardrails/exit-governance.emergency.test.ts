import { describe, expect, test } from "bun:test";
import { evaluateExitGovernance } from "./exit-governance.js";

describe("Exit Governance Structural Tests (Phase 4)", () => {
  test("EMERGENCY_DELEVERAGE no se activa en pérdidas moderadas (-1.5%) con ruido normal", async () => {
    // Si la pérdida es -1.5%, NO debe liquidar en pánico prematuro (umbral ajustado a -3.0% y toxicidad > 0.90)
    const res = await evaluateExitGovernance(
      "BTC",
      "btc_usd",
      84000,
      82740, // -1.50%
      87000,
      -0.60,
      15,
      "BALANCED_RANGE",
      0
    );

    expect(res.action).toBe("HOLD");
  });

  test("EMERGENCY_DELEVERAGE se activa exclusivamente ante pérdida severa (<= -3.0%) con colapso tóxico", async () => {
    const res = await evaluateExitGovernance(
      "BTC",
      "btc_usd",
      84000,
      81400, // -3.10%
      87000,
      -0.90, // OFI crítico
      50,
      "DEFENSIVE_STRESS",
      0
    );

    expect(res.action).toBe("EMERGENCY_DELEVERAGE");
    expect(res.fractionToClose).toBe(1.0);
  });
});
