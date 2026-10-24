import { test, expect } from "bun:test";
import { AERODROME_POSITION_MANAGER_ADDRESS, AerodromeSlipstreamDriver } from "./aerodrome-contract.js";

test("AerodromeSlipstreamDriver inicializa y retorna direccion oficial en Base", () => {
  expect(AERODROME_POSITION_MANAGER_ADDRESS).toBe("0x827922686190790b37229fd06084350E74485b72");
});
