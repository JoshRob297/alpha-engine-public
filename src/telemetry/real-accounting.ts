/**
 * Registro Contable Forense de Depósitos y Custodia Real
 * Audita en vivo los saldos de Binance Spot y Base L2 Hot Wallet.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AerodromeSlipstreamDriver } from "../dex/aerodrome-contract.js";
import { BinanceLiveDriver } from "../cex/binance-live-driver.js";

export const REAL_LEDGER_FILE = "data/real_accounting_ledger.json";
export interface DepositEvent {
  id: string;
  timestamp: string;
  source: string;
  amountUsd: number;
}

export interface RealNftPosition {
  tokenId: number;
  pool: string;
  lowerPrice: number;
  upperPrice: number;
  liquidity: string;
}

export interface RealAccountingState {
  initialCapitalDepositUsd: number;
  totalDepositedUsd: number;
  deposits: DepositEvent[];
  binanceLive: {
    usdt: number;
    bnb: number;
    totalUsdEquivalent: number;
    status: "CONNECTED" | "NOT_CONFIGURED" | "AWAITING_FUNDS";
  };
  baseL2Live: {
    address: string;
    ethBalance: number;
    usdEquivalent: number;
    status: "WAITING_DEPOSIT" | "FUNDED" | "NO_WALLET";
    basescanUrl: string;
  };
  activeNfts: RealNftPosition[];
  pnlRealSummary: {
    grossCurrentUsd: number;
    netProfitUsd: number;
    roiPct: number;
  };
  lastAuditTimestamp: string;
}

export class RealAccountingLedger {
  private state: RealAccountingState;
  private filePath: string;

  constructor(filePath = REAL_LEDGER_FILE) {
    this.filePath = filePath;
    this.state = this.loadState();
  }

  private loadState(): RealAccountingState {
    const defaultState: RealAccountingState = {
      initialCapitalDepositUsd: 0.0,
      totalDepositedUsd: 0.0,
      deposits: [],
      binanceLive: { usdt: 0.0, bnb: 0.00015742, totalUsdEquivalent: 0.09, status: "AWAITING_FUNDS" },
      baseL2Live: {
        address: "<wallet-address>",
        ethBalance: 0,
        usdEquivalent: 0,
        status: "WAITING_DEPOSIT",
        basescanUrl: "https://basescan.org/address/<wallet-address>",
      },
      activeNfts: [],
      pnlRealSummary: {
        grossCurrentUsd: 0.0,
        netProfitUsd: 0.0,
        roiPct: 0.0,
      },
      lastAuditTimestamp: new Date().toISOString(),
    };

    if (!existsSync(this.filePath)) {
      return defaultState;
    }

    try {
      const raw = readFileSync(this.filePath, "utf-8");
      return { ...defaultState, ...JSON.parse(raw) };
    } catch {
      return defaultState;
    }
  }

  public getState(): RealAccountingState {
    return { ...this.state };
  }

  public saveAtomic() {
    try {
      const tmp = `${this.filePath}.tmp.${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf-8");
      if (existsSync(tmp)) {
        writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
      }
    } catch (err) {
      console.error("[REAL ACCOUNTING] Error guardando estado:", err);
    }
  }

  /**
   * Auditoría en vivo de balances en Binance Spot y Base L2
   */
  public async auditLiveHoldings(): Promise<RealAccountingState> {
    // 1. Auditoría Binance Spot
    try {
      const binanceDriver = new BinanceLiveDriver();
      if (binanceDriver.isConfigured()) {
        const balances = await binanceDriver.getAccountBalances();
        if (balances) {
          const getFree = (asset: string) =>
            parseFloat(balances.find((b) => b.asset === asset)?.free || "0") || 0;
          const usdt = getFree("USDT");
          const bnb = getFree("BNB");
          const btc = getFree("BTC");
          const sol = getFree("SOL");
          const totalUsd = usdt + (bnb * 580) + (btc * 83400) + (sol * 118);

          this.state.binanceLive = {
            usdt: parseFloat(usdt.toFixed(2)),
            bnb: parseFloat(bnb.toFixed(6)),
            totalUsdEquivalent: parseFloat(totalUsd.toFixed(2)),
            status: totalUsd > 0.5 ? "CONNECTED" : "AWAITING_FUNDS",
          };
        }
      } else {
        this.state.binanceLive.status = "NOT_CONFIGURED";
      }
    } catch {
      this.state.binanceLive.status = "AWAITING_FUNDS";
    }

    // 2. Base L2 Hot Wallet Live RPC
    try {
      const aeroDriver = new AerodromeSlipstreamDriver();
      const ethBal = await aeroDriver.getEthBalance(this.state.baseL2Live.address);
      this.state.baseL2Live.ethBalance = parseFloat(ethBal.toFixed(6));
      this.state.baseL2Live.usdEquivalent = parseFloat((ethBal * 2650).toFixed(2));
      this.state.baseL2Live.status = ethBal >= 0.002 ? "FUNDED" : "WAITING_DEPOSIT";
    } catch {
      this.state.baseL2Live.status = "WAITING_DEPOSIT";
    }

    // 3. PnL Real Consolidado en USD
    const totalCurrentUsd = this.state.binanceLive.totalUsdEquivalent + this.state.baseL2Live.usdEquivalent;
    const netProfitUsd = totalCurrentUsd - this.state.totalDepositedUsd;
    const roiPct = this.state.totalDepositedUsd > 0 ? (netProfitUsd / this.state.totalDepositedUsd) * 100 : 0;

    this.state.pnlRealSummary = {
      grossCurrentUsd: parseFloat(totalCurrentUsd.toFixed(2)),
      netProfitUsd: parseFloat(netProfitUsd.toFixed(2)),
      roiPct: parseFloat(roiPct.toFixed(2)),
    };

    this.state.lastAuditTimestamp = new Date().toISOString();
    this.saveAtomic();

    return this.getState();
  }
}
