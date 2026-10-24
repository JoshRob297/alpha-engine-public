import { test, expect } from "bun:test";
import { AerodromeSlipstreamDriver, AERODROME_POSITION_MANAGER_ADDRESS } from "./aerodrome-contract.js";

test("AerodromeSlipstreamDriver consulta balance en Base RPC", async () => {
  const driver = new AerodromeSlipstreamDriver();
  // Consultar balance del propio contrato de Aerodrome como sanity check del RPC
  const bal = await driver.getEthBalance(AERODROME_POSITION_MANAGER_ADDRESS);
  expect(typeof bal).toBe("number");
  expect(bal).toBeGreaterThanOrEqual(0);
});
