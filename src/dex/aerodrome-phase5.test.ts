import { describe, expect, test } from "bun:test";
import { AerodromeSlipstreamDriver } from "./aerodrome-contract.js";

describe("Aerodrome Slipstream Phase 5 ABI & Integration Tests", () => {
  const driver = new AerodromeSlipstreamDriver();
  const testAddress = "<wallet-address>";

  test("encodeDecreaseLiquidityCall genera selector oficial 0x0c49ccbe y longitud de 330 chars", () => {
    const calldata = driver.encodeDecreaseLiquidityCall(42, "1000000000", 1800000000);
    expect(calldata.startsWith("0x0c49ccbe")).toBe(true);
    // Selector (10 chars = '0x' + 8 hex) + 5 palabras ABI de 64 hex (320 chars) = 330 chars
    expect(calldata.length).toBe(330);
  });

  test("encodeCollectCall genera selector oficial 0xfc6f7865 y longitud de 266 chars", () => {
    const calldata = driver.encodeCollectCall(42, testAddress);
    expect(calldata.startsWith("0xfc6f7865")).toBe(true);
    // Selector (10 chars = '0x' + 8 hex) + 4 palabras ABI de 64 hex (256 chars) = 266 chars
    expect(calldata.length).toBe(266);
    expect(calldata.includes(testAddress.toLowerCase().replace(/^0x/, ""))).toBe(true);
  });

  test("getTokenOfOwnerByIndex responde sin romper en Base RPC para cuenta sin NFTs", async () => {
    const tokenId = await driver.getTokenOfOwnerByIndex(testAddress, 0);
    // Si la cartera no tiene NFTs aún, debe retornar null limpiamente sin arrojar error
    expect(tokenId === null || typeof tokenId === "number").toBe(true);
  });
});
