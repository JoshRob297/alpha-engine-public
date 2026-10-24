/**
 * Binance Spot Live Driver (Alpha Engine)
 * Firma criptográfica nativa HMAC-SHA256 para Binance Spot API v3.
 *
 * Especificaciones de autenticación de Binance:
 * - Header: "X-MBX-APIKEY: <apiKey>"
 * - Firma: signature = HMAC-SHA256(queryString, apiSecret)
 * - Timestamp y recvWindow (5000ms por defecto) incluidos en el query
 * - Soporte POST_ONLY institucional nativo usando type: "LIMIT_MAKER"
 */

import { createHmac } from "node:crypto";
import { MarketRulesManager, type SymbolMarketRules } from "./market-rules.js";

export interface BinanceBalancePayload {
  asset: string;
  free: string;
  locked: string;
}

export interface BinanceOrderResult {
  symbol: string;
  orderId: number;
  clientOrderId: string;
  transactTime: number;
  price: string;
  origQty: string;
  executedQty: string;
  status: "NEW" | "PARTIALLY_FILLED" | "FILLED" | "CANCELED" | "REJECTED" | "EXPIRED";
  timeInForce: string;
  type: string;
  side: "BUY" | "SELL";
}

export interface BinanceAccountInfo {
  makerCommission: number;
  takerCommission: number;
  buyerCommission: number;
  sellerCommission: number;
  canTrade: boolean;
  canWithdraw: boolean;
  canDeposit: boolean;
  balances: BinanceBalancePayload[];
}

export class BinanceLiveDriver {
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private marketRules: MarketRulesManager = new MarketRulesManager();

  constructor(apiKey?: string, apiSecret?: string, baseUrl = "https://api.binance.com") {
    this.apiKey = apiKey || process.env.BINANCE_API_KEY || "";
    this.apiSecret = apiSecret || process.env.BINANCE_SECRET || process.env.BINANCE_API_SECRET || "";
    this.baseUrl = baseUrl;
  }

  public isConfigured(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  /**
   * Genera el querystring firmado con timestamp, recvWindow y signature HMAC-SHA256
   */
  private signQuery(params: Record<string, string | number | boolean> = {}): string {
    const timestamp = Date.now();
    const recvWindow = 5000;
    const queryParams: Record<string, string> = {};

    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        queryParams[k] = String(v);
      }
    }
    queryParams["timestamp"] = String(timestamp);
    queryParams["recvWindow"] = String(recvWindow);

    const queryString = Object.entries(queryParams)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");

    const signature = createHmac("sha256", this.apiSecret)
      .update(queryString)
      .digest("hex");

    return `${queryString}&signature=${signature}`;
  }

  /**
   * Ejecuta peticiones HTTP firmadas hacia Binance Spot API
   */
  private async signedRequest<T>(
    method: "GET" | "POST" | "DELETE",
    endpoint: string,
    params: Record<string, string | number | boolean> = {}
  ): Promise<T> {
    if (!this.isConfigured()) {
      throw new Error("BinanceLiveDriver: API Key o Secret no configurados en entorno.");
    }

    const signedQuery = this.signQuery(params);
    let url = `${this.baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      "X-MBX-APIKEY": this.apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    };

    let fetchOptions: RequestInit;

    if (method === "GET" || method === "DELETE") {
      url = `${url}?${signedQuery}`;
      fetchOptions = { method, headers, signal: AbortSignal.timeout(6000) };
    } else {
      // POST
      fetchOptions = {
        method,
        headers,
        body: signedQuery,
        signal: AbortSignal.timeout(6000),
      };
    }

    const response = await fetch(url, fetchOptions);
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Binance API Error [${response.status}]: ${text}`);
    }

    return JSON.parse(text) as T;
  }

  /**
   * Consulta el balance consolidado de la cuenta Spot
   */
  public async getAccountBalances(): Promise<BinanceBalancePayload[]> {
    const info = await this.signedRequest<BinanceAccountInfo>("GET", "/api/v3/account");
    return info.balances.filter(
      (b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0
    );
  }

  /**
   * Coloca una orden Maker estricta (Post-Only) usando type: "LIMIT_MAKER".
   * Binance rechaza la orden si cruzaría el spread (no cobra comisiones Taker).
   * Nota: Binance Spot no soporta timeInForce "GTX"; el post-only nativo es LIMIT_MAKER.
   */
  public async placePostOnlyOrder(
    symbol: string,
    side: "BUY" | "SELL",
    price: number,
    quantity: number,
    clientOrderId?: string
  ): Promise<BinanceOrderResult> {
    const cleanSymbol = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

    const params: Record<string, string | number | boolean> = {
      symbol: cleanSymbol,
      side,
      type: "LIMIT_MAKER", // Post-Only nativo de Binance Spot
      quantity,
      price,
    };

    if (clientOrderId) {
      params.newClientOrderId = clientOrderId;
    }

    return await this.signedRequest<BinanceOrderResult>("POST", "/api/v3/order", params);
  }

  /**
   * Coloca una orden a mercado (MARKET) para salidas defensivas.
   * Garantiza ejecución inmediata cuando el libro se torna tóxico.
   */
  public async placeMarketOrder(
    symbol: string,
    side: "BUY" | "SELL",
    quantity: number,
    clientOrderId?: string
  ): Promise<BinanceOrderResult> {
    const cleanSymbol = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const params: Record<string, string | number | boolean> = {
      symbol: cleanSymbol,
      side,
      type: "MARKET",
      quantity,
    };
    if (clientOrderId) params.newClientOrderId = clientOrderId;
    return await this.signedRequest<BinanceOrderResult>("POST", "/api/v3/order", params);
  }

  /**
   * Cancela una orden abierta por orderId o clientOrderId
   */
  public async cancelOrder(symbol: string, orderId?: number, clientOrderId?: string): Promise<any> {
    const cleanSymbol = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const params: Record<string, string | number | boolean> = { symbol: cleanSymbol };

    if (orderId) params.orderId = orderId;
    if (clientOrderId) params.origClientOrderId = clientOrderId;

    return await this.signedRequest<any>("DELETE", "/api/v3/order", params);
  }

  /**
   * Consulta las órdenes abiertas activas para un par
   */
  public async getOpenOrders(symbol?: string): Promise<BinanceOrderResult[]> {
    const params: Record<string, string | number | boolean> = {};
    if (symbol) {
      params.symbol = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    }
    return await this.signedRequest<BinanceOrderResult[]>("GET", "/api/v3/openOrders", params);
  }

  /**
   * Consulta el estado exacto de una orden por orderId o clientOrderId.
   * Permite verificar fills reales antes de mutar la contabilidad interna.
   */
  public async getOrderStatus(symbol: string, orderId?: number, clientOrderId?: string): Promise<BinanceOrderResult> {
    const cleanSymbol = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const params: Record<string, string | number | boolean> = { symbol: cleanSymbol };
    if (orderId) params.orderId = orderId;
    if (clientOrderId) params.origClientOrderId = clientOrderId;
    return await this.signedRequest<BinanceOrderResult>("GET", "/api/v3/order", params);
  }

  /**
   * Consulta las ejecuciones (fills) reales de un par desde un orderId o timestamp.
   * Fuente de verdad absoluta para reconstruir inventario y comisiones cobradas.
   */
  public async getMyTrades(symbol: string, opts: { orderId?: number; startTime?: number; limit?: number } = {}): Promise<
    Array<{ id: number; orderId: number; price: string; qty: string; quoteQty: string; commission: string; commissionAsset: string; time: number; isBuyer: boolean }>
  > {
    const cleanSymbol = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const params: Record<string, string | number | boolean> = { symbol: cleanSymbol, limit: opts.limit ?? 50 };
    if (opts.orderId) params.orderId = opts.orderId;
    if (opts.startTime) params.startTime = opts.startTime;
    return await this.signedRequest("GET", "/api/v3/myTrades", params);
  }

  /**
   * Cancela TODAS las órdenes abiertas de un par (limpieza de arranque LIVE).
   */
  public async cancelAllOpenOrders(symbol: string): Promise<any> {
    const cleanSymbol = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    return await this.signedRequest<any>("DELETE", "/api/v3/openOrders", { symbol: cleanSymbol });
  }

  /**
   * Consulta el saldo libre/bloqueado de un activo específico (ej. BTC, USDT).
   */
  public async getAssetBalance(asset: string): Promise<{ free: number; locked: number; total: number }> {
    const balances = await this.getAccountBalances();
    const clean = asset.toUpperCase();
    const found = balances.find((b) => b.asset === clean);
    if (!found) return { free: 0, locked: 0, total: 0 };
    const free = parseFloat(found.free) || 0;
    const locked = parseFloat(found.locked) || 0;
    return { free, locked, total: free + locked };
  }

  public getMarketRulesManager(): MarketRulesManager {
    return this.marketRules;
  }

  public async syncMarketRules(symbols: string[]): Promise<void> {
    await this.marketRules.syncSymbols(symbols);
  }
}
