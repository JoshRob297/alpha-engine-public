/**
 * Gestor dinámico de Filtros y Reglas de Mercado (Binance Spot Exchange Info)
 * Sincroniza dinámicamente:
 * - LOT_SIZE: minQty, maxQty, stepSize
 * - PRICE_FILTER: minPrice, maxPrice, tickSize
 * - NOTIONAL / MIN_NOTIONAL: minNotional
 *
 * Formatea y redondea precios y lotes matemáticamente para evitar
 * rechazos con códigos -1013 (FILTER_FAILURE) en Binance Spot API.
 */

export interface SymbolMarketRules {
  symbol: string;
  status: string;
  minPrice: number;
  maxPrice: number;
  tickSize: number;
  minQty: number;
  maxQty: number;
  stepSize: number;
  minNotional: number;
  priceDecimals: number;
  qtyDecimals: number;
}

export class MarketRulesManager {
  private cache: Map<string, SymbolMarketRules> = new Map();
  private lastFetchTs = 0;
  private ttlMs = 3600 * 1000; // 1 hora de caché

  private countDecimals(valueStr: string): number {
    const num = parseFloat(valueStr);
    if (!Number.isFinite(num) || num >= 1) {
      if (valueStr.includes(".")) {
        const parts = valueStr.split(".");
        const trimmed = parts[1].replace(/0+$/, "");
        return trimmed.length;
      }
      return 0;
    }
    const match = valueStr.match(/\.0*([1-9])/);
    if (match) {
      const dotIndex = valueStr.indexOf(".");
      const firstNonZero = valueStr.search(/[1-9]/);
      return firstNonZero - dotIndex;
    }
    const clean = num.toString();
    if (clean.includes(".")) return clean.split(".")[1].length;
    return 0;
  }

  /**
   * Sincroniza las reglas de mercado de la lista de símbolos solicitados
   */
  public async syncSymbols(symbols: string[]): Promise<void> {
    const now = Date.now();
    const cleanSymbols = Array.from(
      new Set(symbols.map((s) => s.replace(/[^A-Za-z0-9]/g, "").toUpperCase()))
    );

    const missing = cleanSymbols.filter((s) => !this.cache.has(s));
    if (missing.length === 0 && now - this.lastFetchTs < this.ttlMs) {
      return;
    }

    try {
      const symbolsParam = encodeURIComponent(JSON.stringify(cleanSymbols));
      const res = await fetch(`https://api.binance.com/api/v3/exchangeInfo?symbols=${symbolsParam}`, {
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) {
        console.warn(`[MARKET RULES WARN] Error al consultar exchangeInfo (${res.status})`);
        return;
      }

      const data: any = await res.json();
      if (!Array.isArray(data.symbols)) return;

      for (const item of data.symbols) {
        const sym = item.symbol;
        let minPrice = 0.01;
        let maxPrice = 1000000;
        let tickSize = 0.01;
        let minQty = 0.00001;
        let maxQty = 90000;
        let stepSize = 0.00001;
        let minNotional = 5.0;

        let tickStr = "0.01";
        let stepStr = "0.00001";

        for (const f of item.filters || []) {
          if (f.filterType === "PRICE_FILTER") {
            minPrice = parseFloat(f.minPrice);
            maxPrice = parseFloat(f.maxPrice);
            tickSize = parseFloat(f.tickSize);
            tickStr = f.tickSize;
          } else if (f.filterType === "LOT_SIZE") {
            minQty = parseFloat(f.minQty);
            maxQty = parseFloat(f.maxQty);
            stepSize = parseFloat(f.stepSize);
            stepStr = f.stepSize;
          } else if (f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL") {
            minNotional = parseFloat(f.minNotional || f.notional || "5.0");
          }
        }

        const priceDecimals = this.countDecimals(tickStr);
        const qtyDecimals = this.countDecimals(stepStr);

        this.cache.set(sym, {
          symbol: sym,
          status: item.status,
          minPrice,
          maxPrice,
          tickSize,
          minQty,
          maxQty,
          stepSize,
          minNotional,
          priceDecimals,
          qtyDecimals,
        });
      }

      this.lastFetchTs = now;
      console.log(`[MARKET RULES] Sincronizados filtros de mercado para ${this.cache.size} pares en Binance.`);
    } catch (err: any) {
      console.warn(`[MARKET RULES ERR] Fallo sincronización de exchangeInfo: ${err?.message || err}`);
    }
  }

  public getRules(symbol: string): SymbolMarketRules | undefined {
    const clean = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    return this.cache.get(clean);
  }

  /**
   * Valida y ajusta de forma matemática el precio y cantidad según las reglas del exchange.
   * Aplica truncamiento / suelo según stepSize para no enviar más decimales o fracciones de lote prohibidas.
   */
  public sanitizeOrder(
    symbol: string,
    rawPrice: number,
    rawQty: number
  ): {
    valid: boolean;
    price: number;
    qty: number;
    notional: number;
    reason?: string;
  } {
    const rules = this.getRules(symbol);
    if (!rules) {
      // Fallback seguro si no hay reglas cacheadas
      return {
        valid: rawQty > 0 && rawPrice > 0 && rawPrice * rawQty >= 5.0,
        price: parseFloat(rawPrice.toFixed(2)),
        qty: parseFloat(rawQty.toFixed(4)),
        notional: rawPrice * rawQty,
      };
    }

    if (rules.status !== "TRADING") {
      return {
        valid: false,
        price: 0,
        qty: 0,
        notional: 0,
        reason: `Símbolo ${symbol} no está en estado TRADING (${rules.status})`,
      };
    }

    // 1. Ajustar precio al tickSize
    const priceTicks = Math.round(rawPrice / rules.tickSize);
    const cleanPrice = parseFloat((priceTicks * rules.tickSize).toFixed(rules.priceDecimals));

    if (cleanPrice < rules.minPrice || cleanPrice > rules.maxPrice) {
      return {
        valid: false,
        price: cleanPrice,
        qty: 0,
        notional: 0,
        reason: `Precio ${cleanPrice} fuera de límites [${rules.minPrice}, ${rules.maxPrice}]`,
      };
    }

    // 2. Ajustar cantidad a stepSize (truncar hacia abajo para no sobre-apalancar)
    const qtySteps = Math.floor(rawQty / rules.stepSize);
    const cleanQty = parseFloat((qtySteps * rules.stepSize).toFixed(rules.qtyDecimals));

    if (cleanQty < rules.minQty) {
      return {
        valid: false,
        price: cleanPrice,
        qty: cleanQty,
        notional: cleanPrice * cleanQty,
        reason: `Cantidad ${cleanQty} inferior al lote mínimo permitido (${rules.minQty})`,
      };
    }

    if (cleanQty > rules.maxQty) {
      return {
        valid: false,
        price: cleanPrice,
        qty: cleanQty,
        notional: cleanPrice * cleanQty,
        reason: `Cantidad ${cleanQty} superior al lote máximo (${rules.maxQty})`,
      };
    }

    // 3. Validar valor nocional (minNotional >= 5 USDT en Binance)
    const notional = cleanPrice * cleanQty;
    if (notional < rules.minNotional) {
      return {
        valid: false,
        price: cleanPrice,
        qty: cleanQty,
        notional,
        reason: `Valor nocional de la orden ($${notional.toFixed(2)} USD) inferior al mínimo de Binance ($${rules.minNotional} USD)`,
      };
    }

    return {
      valid: true,
      price: cleanPrice,
      qty: cleanQty,
      notional,
    };
  }
}
