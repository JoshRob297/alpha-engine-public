/**
 * Submotor de Cobertura Delta-Neutral en Futuros (Simulación Paper / Live-Ready)
 * Implementa la especificación RFC-003 con Cobertura por Slot DEX 1 a 1:
 * - Cada slot del DEX (BTC, AERO, YIELD) tiene su propia posición de cobertura independiente (slotKey).
 * - Rotación atómica de contratos: Si el pool rota de un subyacente a otro (ej. BTC a ETH),
 *   se liquida y reinicializa el precio de entrada y contrato para evitar desfases de precio.
 * - Deadband Dinámico (SETS + Jev) entre 2.5% y 9.5%.
 * - Cosecha continua de Funding Rates en Binance Futures.
 * - Gobernanza de margen 1x y destrucción automática de coberturas huérfanas.
 */

import { BinanceFuturesFeeder, type FundingRateInfo } from "../cex/binance-futures-feeder.js";
import { DynamicFuturesResolver } from "../cex/futures-resolver.js";
import { MarketTemperatureMonitor } from "../guardrails/market-temperature.js";

export interface HedgePositionState {
  slotKey: string;          // Clave única del slot (ej. "BTC", "AERO", "YIELD")
  symbol: string;           // Contrato en Binance Futures (ej. "ETHUSDT", "BTCUSDT", "AEROUSDT")
  underlyingDexSlot: string;// Nombre legible del slot o pool asociado
  shortQty: number;         // Cantidad en short
  entryMarkPrice: number;   // Precio de entrada
  currentMarkPrice: number; // Precio actual de mercado
  notionalUsd: number;      // Valor nocional cubierto en USD
  unrealizedPnlUsd: number; // PnL latente del short
  accumulatedFundingUsd: number; // Ingresos cobrados por tasas de fondeo
  fundingRate: number;      // Tasa actual de 8h
  annualizedAprPct: number; // APR proyectado por funding
  marginAssignedUsd: number;// Margen asignado para colateral
  marginHealthRatio: number;// Salud de margen (> 70% seguro, < 40% requiere rebalanceo)
  liquidationPrice: number; // Precio teórico de liquidación
  totalRebalancesCount: number; // Veces que se ajustó el tamaño del Short por cambio en DEX
  dynamicDeadbandPct: number;   // Tolerancia calculada dinámicamente por SETS / Jev
  temperatureRegime: "COLD" | "BALANCED" | "HOT"; // Temperatura de mercado
  status: "ACTIVE" | "PAUSED_NEGATIVE_FUNDING" | "REBALANCING_MARGIN";
  lastPayoutTimestamp: number;
}

export class FuturesHedgeEngine {
  private positions: Map<string, HedgePositionState> = new Map();
  private totalAccumulatedFundingUsd = 0;
  private totalUnrealizedPnlUsd = 0;
  private lastGlobalDeadbandPct = 4.5;
  public executionMode: "PAPER" | "LIVE" = "PAPER";
  private warnedLiveUnsupported = false;

  constructor() {}

  public calculateDynamicDeadband(
    ticker: string,
    priceHistory: number[] = [],
    macroRegime = "BALANCED_RANGE"
  ): { deadbandPct: number; tempRegime: "COLD" | "BALANCED" | "HOT" } {
    const temp = MarketTemperatureMonitor.getTemperature(ticker, priceHistory);
    const tempMultiplier = temp.spacingMultiplier;

    let regimeMultiplier = 1.0;
    if (macroRegime === "AGGRESSIVE_ACCUMULATION") {
      regimeMultiplier = 0.80;
    } else if (macroRegime === "DEFENSIVE_STRESS") {
      regimeMultiplier = 1.40;
    }

    const rawDeadband = 4.5 * tempMultiplier * regimeMultiplier;
    const deadbandPct = parseFloat(Math.min(9.5, Math.max(2.5, rawDeadband)).toFixed(2));

    this.lastGlobalDeadbandPct = deadbandPct;
    return { deadbandPct, tempRegime: temp.regime };
  }

  public async syncWithDexPositions(
    dexPositionsMap: Map<string, any> | Record<string, any>,
    availableCashReserveUsd: number,
    macroRegime = "BALANCED_RANGE",
    priceHistories: Record<string, number[]> = {}
  ) {
    // GUARDIA ESTRICTA: La cobertura de futuros no tiene ejecución real conectada.
    if (this.executionMode === "LIVE" && !this.warnedLiveUnsupported) {
      this.warnedLiveUnsupported = true;
      console.warn(
        "[FUTURES LIVE GUARD] La cobertura delta-neutral de Binance Futures opera en SIMULACIÓN. " +
        "No hay envío de órdenes reales a /fapi. El funding y el PnL del short son sombra."
      );
    }

    const entries = dexPositionsMap instanceof Map ? Array.from(dexPositionsMap.entries()) : Object.entries(dexPositionsMap);
    const activeSlotsInDex = new Set<string>();

    for (const [slotKey, item] of entries) {
      const poolSymbol = typeof item.pool === "string" ? item.pool : (item.pool?.symbol || slotKey);
      const snap = typeof item.engine?.getSnapshot === "function" ? item.engine.getSnapshot() : item.positionSnapshot;
      const capital = snap?.currentCapitalUsd || item.currentCapitalUsd || 0;
      const status = snap?.status || item.status || "ACTIVE";

      if (capital <= 0 || status === "FLATTENED" || status === "CLOSED") continue;

      // Resolución 100% dinámica del contrato de futuros correspondiente al pool DEX
      const resolvedHedge = await DynamicFuturesResolver.resolveHedgeForPool(poolSymbol);
      if (!resolvedHedge || !resolvedHedge.hedgeSymbol) {
        continue;
      }

      const hedgeSymbol = resolvedHedge.hedgeSymbol;
      activeSlotsInDex.add(slotKey);

      const exposedRatio = 0.50; // Fracción estimada expuesta al activo volátil en el pool
      const targetNotionalUsd = capital * exposedRatio;
      const hist = priceHistories[slotKey] || priceHistories[hedgeSymbol.replace("USDT", "")] || [];
      const dynamicDb = this.calculateDynamicDeadband(slotKey, hist, macroRegime);

      await this.rebalanceOrInitHedgePosition(
        slotKey,
        hedgeSymbol,
        poolSymbol,
        targetNotionalUsd,
        availableCashReserveUsd,
        dynamicDb.deadbandPct,
        dynamicDb.tempRegime
      );
    }

    // DESTRUCCIÓN DE COBERTURAS HUÉRFANAS POR SLOT
    for (const [slotKey, pos] of this.positions.entries()) {
      if (!activeSlotsInDex.has(slotKey)) {
        console.log(`[FUTURES HEDGE CLOSE] Destruyendo cobertura para ${pos.symbol} (Slot DEX ${slotKey} cerrado).`);
        this.positions.delete(slotKey);
      }
    }
  }

  private async rebalanceOrInitHedgePosition(
    slotKey: string,
    symbol: string,
    poolSymbol: string,
    targetNotionalUsd: number,
    reserveUsd: number,
    deadbandPct: number,
    tempRegime: "COLD" | "BALANCED" | "HOT"
  ) {
    const fundingInfo = await BinanceFuturesFeeder.fetchCurrentFundingRate(symbol);
    const markPrice = fundingInfo?.markPrice || (symbol.includes("BTC") ? 83500 : symbol.includes("ETH") ? 2650 : 0.81);
    const fundingRate = fundingInfo?.fundingRate || 0.0001;
    const aprPct = fundingInfo?.aprAnnualizedPct || 10.95;

    let pos = this.positions.get(slotKey);

    // Si la posición no existe O cambió de contrato de futuros (por rotación del pool DEX de BTC a ETH o viceversa):
    // Reinicializar limpiamente para no comparar el precio de entrada de Bitcoin contra el precio actual de Ethereum
    if (!pos || pos.symbol !== symbol) {
      const shortQty = markPrice > 0 ? targetNotionalUsd / markPrice : 0;
      const marginAssigned = targetNotionalUsd * 1.0; // 1x colateral 1:1
      const liquidationPrice = markPrice * 1.90; // Liquidación teórica al +90%
      const prevFunding = pos?.accumulatedFundingUsd || 0; // Preservar funding cobrado previamente

      pos = {
        slotKey,
        symbol,
        underlyingDexSlot: `${slotKey} (${poolSymbol})`,
        shortQty,
        entryMarkPrice: markPrice,
        currentMarkPrice: markPrice,
        notionalUsd: targetNotionalUsd,
        unrealizedPnlUsd: 0,
        accumulatedFundingUsd: prevFunding,
        fundingRate,
        annualizedAprPct: aprPct,
        marginAssignedUsd: marginAssigned,
        marginHealthRatio: 0.95,
        liquidationPrice,
        totalRebalancesCount: 0,
        dynamicDeadbandPct: deadbandPct,
        temperatureRegime: tempRegime,
        status: "ACTIVE",
        lastPayoutTimestamp: Date.now(),
      };
      this.positions.set(slotKey, pos);
    } else {
      // 2. AJUSTE DINÁMICO POR REBALANCEO (Mismo contrato de futuros)
      pos.underlyingDexSlot = `${slotKey} (${poolSymbol})`;
      pos.currentMarkPrice = markPrice;
      pos.fundingRate = fundingRate;
      pos.annualizedAprPct = aprPct;
      pos.dynamicDeadbandPct = deadbandPct;
      pos.temperatureRegime = tempRegime;

      const deltaNotionalUsd = Math.abs(targetNotionalUsd - pos.notionalUsd);
      const relativeChangePct = (pos.notionalUsd > 0 ? deltaNotionalUsd / pos.notionalUsd : 1.0) * 100;

      if (relativeChangePct > deadbandPct) {
        const newShortQty = markPrice > 0 ? targetNotionalUsd / markPrice : 0;
        pos.shortQty = newShortQty;
        pos.notionalUsd = targetNotionalUsd;
        pos.totalRebalancesCount++;
      }

      pos.unrealizedPnlUsd = (pos.entryMarkPrice - markPrice) * pos.shortQty;

      // 3. GOBERNANZA DE MÁRGENES
      const equity = pos.marginAssignedUsd + pos.unrealizedPnlUsd;
      pos.marginHealthRatio = pos.notionalUsd > 0 ? Math.max(0.1, equity / pos.notionalUsd) : 1.0;

      if (pos.marginHealthRatio < 0.40 && reserveUsd > 10) {
        const topUp = pos.notionalUsd * 0.35;
        pos.marginAssignedUsd += topUp;
        pos.liquidationPrice = markPrice * 1.85;
        pos.status = "REBALANCING_MARGIN";
      } else if (pos.fundingRate < -0.0005) {
        pos.status = "PAUSED_NEGATIVE_FUNDING";
      } else {
        pos.status = "ACTIVE";
      }
    }
  }

  public stepHour(currentTimestamp = Date.now()) {
    let currentUnrealized = 0;
    let currentFunding = 0;

    for (const [, pos] of this.positions.entries()) {
      if (pos.status === "ACTIVE") {
        const hourlyPayout = (pos.notionalUsd * pos.fundingRate) / 8;
        pos.accumulatedFundingUsd += hourlyPayout;
      }
      currentUnrealized += pos.unrealizedPnlUsd;
      currentFunding += pos.accumulatedFundingUsd;
    }

    this.totalUnrealizedPnlUsd = currentUnrealized;
    this.totalAccumulatedFundingUsd = currentFunding;
  }

  public restorePositions(savedPositions: HedgePositionState[]) {
    if (!Array.isArray(savedPositions)) return;
    for (const p of savedPositions) {
      if (p.slotKey) {
        this.positions.set(p.slotKey, { ...p });
      }
    }
  }

  public getSummary() {
    const list: HedgePositionState[] = [];
    for (const [, pos] of this.positions.entries()) {
      list.push({ ...pos });
    }

    return {
      totalHedgePositions: list.length,
      totalNotionalUsd: list.reduce((acc, p) => acc + p.notionalUsd, 0),
      totalUnrealizedPnlUsd: parseFloat(this.totalUnrealizedPnlUsd.toFixed(4)),
      totalAccumulatedFundingUsd: parseFloat(this.totalAccumulatedFundingUsd.toFixed(4)),
      netHedgeBenefitUsd: parseFloat((this.totalUnrealizedPnlUsd + this.totalAccumulatedFundingUsd).toFixed(4)),
      averageDeadbandPct: this.lastGlobalDeadbandPct,
      positions: list,
    };
  }
}
