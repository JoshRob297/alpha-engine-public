import { test, expect } from "bun:test";
import {
  sanitizeCleanUi,
  renderDashboardView,
  renderLiveView,
  renderSimView,
  renderCexDetailView,
  renderDexDetailView,
  renderHedgeDetailView,
  renderFlattenConfirmView,
} from "./telegram-bot.js";

test("sanitizeCleanUi elimina emojis decorativos y mantiene texto limpio", () => {
  const dirty = "Alerta OK 🚀 Fuego 🔥 Ganancia 💰 Advertencia Peligro Neutro";
  const cleaned = sanitizeCleanUi(dirty);

  expect(cleaned).not.toContain("🚀");
  expect(cleaned).not.toContain("🔥");
  expect(cleaned).not.toContain("💰");
  expect(cleaned).toContain("Alerta OK");
});

test("renderDashboardView genera la terminal Canvas sobria sin semaforos", () => {
  const mockStatus = {
    lastUpdated: new Date().toISOString(),
    pulseCount: 150,
    macroAllocation: { predominantRegime: "BALANCED_RANGE" },
    realState: { binanceLive: { usdt: 0.0, bnb: 0.000157 }, baseL2Live: { ethBalance: 0.0 } },
    paperMetrics: { pfSignal: "GREEN" },
    cex: { BTC: { status: "ACTIVE" } },
    dex: { BTC: { status: "ACTIVE", accumulatedFeesUsd: 0.05 } },
    futuresHedge: { totalAccumulatedFundingUsd: 0.12 },
  };

  const { text, replyMarkup } = renderDashboardView(mockStatus);

  expect(text).toContain("ALPHA ENGINE v1.0.0");
  expect(text).toContain("[TERMINAL]");
  expect(text).toContain("[ESPACIO LIVE]");
  expect(text).toContain("[ESPACIO SIMULACION]");
  expect(text).not.toContain("🟢");
  expect(text).not.toContain("🔴");
  expect(replyMarkup.inline_keyboard.length).toBe(5);
  expect(replyMarkup.inline_keyboard[0][0].text).toBe("Espacio Live");
  expect(replyMarkup.inline_keyboard[0][1].text).toBe("Espacio Simulacion");
});

test("renderLiveView renderiza balances auditados limpios de Binance y Base L2", () => {
  const mockStatus = {
    realState: {
      binanceLive: { status: "CONNECTED", usdt: 100.5, bnb: 0.02 },
      baseL2Live: { ethBalance: 0.005, status: "FUNDED" },
    },
  };

  const { text, replyMarkup } = renderLiveView(mockStatus);
  expect(text).toContain("CUSTODIA REAL Y BILLETERAS");
  expect(text).toContain("[LIVE]");
  expect(text).toContain("100.50 USDT");
  expect(text).toContain("<wallet-address>");
  expect(text).not.toContain("🟢");
  expect(replyMarkup.inline_keyboard[1][0].text).toContain("Volver");
});

test("renderSimView renderiza métricas sin semáforos", () => {
  const mockStatus = {
    totalCapitalUsd: 200,
    macroAllocation: { predominantRegime: "AGGRESSIVE_ACCUMULATION" },
    paperMetrics: { pfSignal: "GREEN", totalTrades: 5, winRatePct: 80.0 },
    cex: { BTC: { unrealizedPnlUsd: 0.25 } },
    dex: { BTC: { accumulatedFeesUsd: 0.15 } },
    futuresHedge: { totalAccumulatedFundingUsd: 0.35 },
  };

  const { text, replyMarkup } = renderSimView(mockStatus);
  expect(text).toContain("CARTERA DE SIMULACION EN TIEMPO REAL");
  expect(text).toContain("[SIM]");
  expect(text).toContain("AGGRESSIVE_ACCUMULATION");
  expect(text).toContain("Comisiones DEX");
  expect(text).toContain("Cosecha de Fondeo");
  expect(text).not.toContain("🟢");
  expect(replyMarkup.inline_keyboard[0][0].text).toContain("Bots CEX");
});

test("renderHedgeDetailView muestra posiciones sin semáforos", () => {
  const mockStatus = {
    futuresHedge: {
      averageDeadbandPct: 4.5,
      totalAccumulatedFundingUsd: 0.05,
      positions: [
        {
          symbol: "AEROUSDT",
          underlyingDexSlot: "AERO",
          notionalUsd: 5.0,
          fundingRate: 0.0001,
          annualizedAprPct: 10.95,
          accumulatedFundingUsd: 0.02,
          dynamicDeadbandPct: 4.7,
          temperatureRegime: "COLD",
          marginHealthRatio: 0.95,
          liquidationPrice: 1.55,
        },
      ],
    },
  };

  const { text, replyMarkup } = renderHedgeDetailView(mockStatus);
  expect(text).toContain("COBERTURA DELTA-NEUTRAL EN DERIVADOS");
  expect(text).toContain("[BINANCE FUTURES]");
  expect(text).toContain("AEROUSDT");
  expect(text).toContain("Deadband Dinamico");
  expect(text).not.toContain("🟢");
  expect(replyMarkup.inline_keyboard[1][0].text).toContain("Volver");
});

test("renderFlattenConfirmView contiene opciones de control", () => {
  const { text, replyMarkup } = renderFlattenConfirmView();
  expect(text).toContain("PANEL DE SEGURIDAD Y CONTROL OPERATIVO");
  expect(text).not.toContain("🔴");
  expect(replyMarkup.inline_keyboard[0][0].text).toContain("Pausar");
  expect(replyMarkup.inline_keyboard[1][0].text).toContain("Flatten");
  expect(replyMarkup.inline_keyboard[2][0].text).toContain("Volver");
});
