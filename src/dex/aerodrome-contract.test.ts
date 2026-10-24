import { describe, expect, test } from "bun:test";
import { AerodromeSlipstreamDriver, type MintParams } from "./aerodrome-contract.js";

describe("Aerodrome Slipstream Driver", () => {
  test("encodeMintCall empaqueta calldata con selector oficial y parámetros ABI estándar", () => {
    const driver = new AerodromeSlipstreamDriver();
    const params: MintParams = {
      token0: "0x4200000000000000000000000000000000000006", // WETH en Base
      token1: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", // cbBTC en Base
      tickSpacing: 200,
      tickLower: -887200,
      tickUpper: 887200,
      amount0Desired: "1000000000000000000", // 1 WETH
      amount1Desired: "50000000",             // 0.5 cbBTC (8 decimals)
      amount0Min: "0",
      amount1Min: "0",
      recipient: "0x1111111111111111111111111111111111111111",
      deadline: 1800000000,
    };

    const calldata = driver.encodeMintCall(params);

    // Debe comenzar con el function selector oficial de mint (0x88316456)
    expect(calldata.startsWith("0x88316456")).toBe(true);

    // Longitud esperada: selector (10 chars = '0x' + 8 hex) + 11 palabras de 64 hex (704 chars) = 714 chars
    expect(calldata.length).toBe(714);

    // Verificar que token0 empacado contiene la dirección limpia sin prefijo 0x
    expect(calldata.includes("4200000000000000000000000000000000000006")).toBe(true);
    // Verificar que recipient empacado contiene la hot wallet
    expect(calldata.includes("1111111111111111111111111111111111111111")).toBe(true);
  });
});
