import { describe, expect, test } from "bun:test";
import { AerodromeSlipstreamDriver } from "./aerodrome-contract.js";

describe("Aerodrome Slipstream RPC Integration", () => {
  test("getPositionCount consulta balanceOf correctamente en Base RPC", async () => {
    const driver = new AerodromeSlipstreamDriver();
    // Consultar dirección oficial conocida (<wallet-address>)
    const count = await driver.getPositionCount("<wallet-address>");
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test("estimateGas retorna estimación razonable para mint o fallback seguro", async () => {
    const driver = new AerodromeSlipstreamDriver();
    const gas = await driver.estimateGas(
      "<wallet-address>",
      "0x88316456"
    );
    expect(typeof gas).toBe("number");
    expect(gas).toBeGreaterThanOrEqual(50_000);
  });
});
