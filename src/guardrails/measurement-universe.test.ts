import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyUniverseFreeze,
  freezeUniverse,
  loadUniverse,
  universeExpanded,
} from "./measurement-universe.js";

const makeTempPath = () => join(mkdtempSync(join(tmpdir(), "universe-")), "universe.json");

describe("congelamiento del universo de medicion", () => {
  test("congela activos y pools y los persiste ordenados y sin duplicados", () => {
    const path = makeTempPath();
    const { universe, created } = freezeUniverse(["SOL", "BTC", "BTC"], ["WETH-CBBTC", "AERO-CBBTC"], "2026-10-19T02:20:00Z", { path });
    expect(created).toBe(true);
    expect(universe.assets).toEqual(["BTC", "SOL"]);
    expect(universe.pools).toEqual(["AERO-CBBTC", "WETH-CBBTC"]);
    expect(loadUniverse(path)?.windowStartedAt).toBe("2026-10-19T02:20:00Z");
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("no sobreescribe un universo ya fijado (protocolo)", () => {
    const path = makeTempPath();
    freezeUniverse(["BTC"], ["P1"], "2026-10-19T02:20:00Z", { path, now: "T1" });
    const second = freezeUniverse(["ETH"], ["P2"], "2026-11-01T00:00:00Z", { path, now: "T2" });
    expect(second.created).toBe(false);
    expect(second.universe.assets).toEqual(["BTC"]);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("con force si se puede re-fijar (proposito explicito)", () => {
    const path = makeTempPath();
    freezeUniverse(["BTC"], ["P1"], null, { path });
    const forced = freezeUniverse(["ETH"], ["P2"], null, { path, force: true });
    expect(forced.universe.assets).toEqual(["ETH"]);
    rmSync(join(path, ".."), { recursive: true, force: true });
  });

  test("bloquea activos fuera del universo congelado y lo justifica", () => {
    const universe = { windowStartedAt: null, assets: ["BTC", "SOL"], pools: [], createdAt: "T", note: "" };
    const { decision, admissions } = applyUniverseFreeze(["BTC", "ETH"], universe, "ASSET");
    expect(decision.allowed).toEqual(["BTC"]);
    expect(decision.rejected).toEqual(["ETH"]);
    expect(admissions[0].allowed).toBe(false);
    expect(universeExpanded(admissions)).toBe(false);
  });

  test("bloquea pools nuevos y no marca expansion", () => {
    const universe = { windowStartedAt: null, assets: [], pools: ["WETH-CBBTC"], createdAt: "T", note: "" };
    const { decision, admissions } = applyUniverseFreeze(["WETH-CBBTC", "XDP-USDC"], universe, "POOL");
    expect(decision.rejected).toEqual(["XDP-USDC"]);
    expect(universeExpanded(admissions)).toBe(false);
  });

  test("con allowExpansion admite pero marca la ventana como expandida", () => {
    const universe = { windowStartedAt: null, assets: ["BTC"], pools: [], createdAt: "T", note: "" };
    const { decision, admissions } = applyUniverseFreeze(["BTC", "ETH"], universe, "ASSET", true);
    expect(decision.allowed).toEqual(["BTC", "ETH"]);
    expect(universeExpanded(admissions)).toBe(true);
    expect(admissions[0].reason).toContain("pre-especificada");
  });

  test("sin universo fijado no filtra nada", () => {
    const { decision, admissions } = applyUniverseFreeze(["BTC", "ETH"], null, "ASSET");
    expect(decision.allowed).toEqual(["BTC", "ETH"]);
    expect(admissions).toEqual([]);
  });

  test("archivo corrupto o ausente devuelve null", () => {
    const path = makeTempPath();
    expect(loadUniverse(path)).toBeNull();
    rmSync(join(path, ".."), { recursive: true, force: true });
  });
});
