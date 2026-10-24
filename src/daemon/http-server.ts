/**
 * Servidor HTTP y API de Telemetría (Alpha Engine)
 * Expone endpoints REST para Dashboard UI, Pangolin y Bot de Telegram
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeLiveWinRateMetrics } from "../guardrails/live-metrics.js";
import { sendTelegramAlert } from "../telemetry/notifier.js";
import { RealTimeAuditLogger } from "../telemetry/audit-logger.js";
import { ForensicAuditLogger } from "../telemetry/forensic-audit-logger.js";
import { MemorySentinel } from "./memory-sentinel.js";
import type { DynamicAlphaOrchestrator } from "./dynamic-orchestrator.js";

export const HTTP_PORT = 3001;

export class HttpServerManager {
  private orchestrator: DynamicAlphaOrchestrator;
  private port: number;

  constructor(orchestrator: DynamicAlphaOrchestrator, port = HTTP_PORT) {
    this.orchestrator = orchestrator;
    this.port = port;
  }

  public start() {
    const webHtmlPath = "./src/web/index.html";
    const orch = this.orchestrator;

    Bun.serve({
      port: this.port,
      hostname: "0.0.0.0",
      fetch: async (req) => {
        const url = new URL(req.url);

        // 1. Dashboard UI
        if (url.pathname === "/" || url.pathname === "/index.html") {
          if (existsSync(webHtmlPath)) {
            const html = readFileSync(webHtmlPath, "utf-8");
            return new Response(html, {
              headers: {
                "Content-Type": "text/html",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }
          return new Response("Alpha Engine Dashboard HTML no encontrado", { status: 404 });
        }

        // 2. Preflight CORS
        if (req.method === "OPTIONS") {
          return new Response(null, {
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "*",
            },
          });
        }

        // 3. Status del Sistema
        if (url.pathname === "/status") {
          const raw = readFileSync(orch.getStateFilePath(), "utf-8");
          const parsed = JSON.parse(raw);
          parsed.causalMetrics = computeLiveWinRateMetrics();
          const realState = orch.getRealLedger().getState();
          parsed.realLedgerSummary = realState.pnlRealSummary;
          parsed.realState = realState;
          parsed.liveTradingEnabled = orch.isLiveTradingEnabled();

          // Semáforo institucional de Profit Factor
          const pf = parsed.paperMetrics?.profitFactor ?? 1.0;
          parsed.paperMetrics.pfSignal = pf >= 1.0 ? "GREEN" : pf >= 0.75 ? "YELLOW" : "RED";

          // Fase 0: atribución de PnL + estado de riesgo
          parsed.attribution = orch.getLedger().getAttribution();
          parsed.risk = orch.getRiskGuard().getStatus();

          // Inyectar auditoría de memoria en el payload de estado
          parsed.memoryAudit = MemorySentinel.getInstance().getStatus();
          return new Response(JSON.stringify(parsed, null, 2), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // 3.1. Health / Heartbeat
        if (url.pathname === "/health") {
          const now = Date.now();
          const lastTickAt = orch.getLastTickAt();
          const stalenessSeconds = Math.round((now - lastTickAt) / 1000);
          const healthy = stalenessSeconds < 60;
          return new Response(JSON.stringify({
            status: healthy ? "ok" : "stale",
            executionMode: orch.getExecutionMode(),
            pulseCount: (() => { try { return JSON.parse(readFileSync(orch.getStateFilePath(), "utf-8")).pulseCount; } catch { return null; } })(),
            lastTickAt: new Date(lastTickAt).toISOString(),
            stalenessSeconds,
            killed: orch.isRiskKilled(),
            timestamp: new Date().toISOString(),
          }, null, 2), {
            status: healthy ? 200 : 503,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // 3.2. Estado de riesgo
        if (url.pathname === "/risk") {
          return new Response(JSON.stringify(orch.getRiskGuard().getStatus(), null, 2), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // 3.3. Atribución de PnL por componente
        if (url.pathname === "/metrics/attribution") {
          const mode = (url.searchParams.get("mode") || undefined) as "PAPER" | "LIVE" | undefined;
          return new Response(JSON.stringify({
            mode: mode || orch.getExecutionMode(),
            total: orch.getLedger().getAttribution(mode),
            timestamp: new Date().toISOString(),
          }, null, 2), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // 4. Comparativa Paper vs Live
        if (url.pathname === "/metrics/comparison") {
          const raw = readFileSync(orch.getStateFilePath(), "utf-8");
          const parsed = JSON.parse(raw);
          const realState = orch.getRealLedger().getState();
          const comparison = {
            executionMode: orch.getExecutionMode(),
            timestamp: new Date().toISOString(),
            paper: {
              capitalUsd: orch.getTotalCapitalUsd(),
              effectivePortfolioUsd: parsed.effectivePortfolioUsd ?? orch.getTotalCapitalUsd(),
              openPositionPnlUsd: parsed.openPositionPnlUsd ?? 0,
              totalTrades: parsed.paperMetrics?.totalTrades ?? 0,
              winRatePct: parsed.paperMetrics?.winRatePct ?? 0,
              profitFactor: parsed.paperMetrics?.profitFactor ?? 1.0,
              totalPnlRealizedUsd: parsed.paperMetrics?.totalPnlRealizedUsd ?? 0,
              totalPnlDexUsd: parsed.paperMetrics?.totalPnlDexUsd ?? 0,
            },
            live: {
              depositedUsd: realState.totalDepositedUsd,
              grossCurrentUsd: realState.pnlRealSummary.grossCurrentUsd,
              netProfitUsd: realState.pnlRealSummary.netProfitUsd,
              roiPct: realState.pnlRealSummary.roiPct,
              binanceUsdt: realState.binanceLive?.usdt || 0,
              binanceBnb: realState.binanceLive?.bnb || 0,
              baseEth: realState.baseL2Live?.ethBalance || 0,
              totalTrades: parsed.liveMetrics?.totalTrades ?? 0,
              winRatePct: parsed.liveMetrics?.winRatePct ?? 0,
              profitFactor: parsed.liveMetrics?.profitFactor ?? 1.0,
            },
          };
          return new Response(JSON.stringify(comparison, null, 2), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // 5. Win Rate Cuantitativo
        if (url.pathname === "/metrics/winrate") {
          const winRateData = computeLiveWinRateMetrics();
          return new Response(JSON.stringify(winRateData, null, 2), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // 5.1. Log de Auditoría en Tiempo Real con Fallback al Historial en Disco
        if (url.pathname === "/audit/logs") {
          const limit = parseInt(url.searchParams.get("limit") || "100", 10);
          const category = url.searchParams.get("category") || undefined;
          let events = RealTimeAuditLogger.getInstance().getRecentEvents(limit, category);
          
          // Si el buffer en RAM está vacío (por reinicio reciente del daemon), cargar inmediatamente los últimos eventos de disco
          if (!events || events.length === 0) {
            const diskEvents = ForensicAuditLogger.getInstance().queryHistoricalLogs(orch.getExecutionMode(), undefined, limit, category);
            events = diskEvents.map(e => ({
              id: e.id,
              timestamp: e.timestamp,
              category: e.category,
              trigger: e.trigger,
              assetOrPool: e.asset,
              action: e.action,
              details: e.details,
              level: e.level,
              metrics: e.metrics
            }));
          }

          return new Response(JSON.stringify({ total: events.length, events, timestamp: new Date().toISOString() }, null, 2), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // 5.2. Historial Forense Diario en Disco (/audit/history)
        if (url.pathname === "/audit/history") {
          const mode = (url.searchParams.get("mode") || orch.getExecutionMode()) as "LIVE" | "PAPER";
          const dateStr = url.searchParams.get("date") || undefined;
          const limit = parseInt(url.searchParams.get("limit") || "100", 10);
          const category = url.searchParams.get("category") || undefined;
          const asset = url.searchParams.get("asset") || undefined;
          const events = ForensicAuditLogger.getInstance().queryHistoricalLogs(mode, dateStr, limit, category, asset);
          const dates = ForensicAuditLogger.getInstance().listAvailableDates(mode);
          return new Response(JSON.stringify({ mode, date: dateStr || "today", availableDates: dates, total: events.length, events }, null, 2), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // 5.3. Endpoint de Klines para TradingView (/api/klines)
        if (url.pathname === "/api/klines") {
          const rawSymbol = url.searchParams.get("symbol") || "BTCUSDT";
          const cleanSymbol = rawSymbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
          const interval = url.searchParams.get("interval") || "1h";
          const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 500);

          try {
            const bRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${cleanSymbol}&interval=${interval}&limit=${limit}`, {
              signal: AbortSignal.timeout(4000),
            });
            if (bRes.ok) {
              const bData: any[][] = await bRes.json();
              const formatted = bData.map((k) => ({
                time: Math.floor(k[0] / 1000), // Timestamp en segundos para Lightweight Charts
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
              }));
              return new Response(JSON.stringify({ symbol: cleanSymbol, interval, count: formatted.length, candles: formatted }), {
                headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
                },
              });
            }
          } catch (kErr) {
            console.warn("[KLINES API ERROR]:", kErr);
          }
          return new Response(JSON.stringify({ symbol: cleanSymbol, count: 0, candles: [] }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // 6. Auditoría On-Chain / CEX Real
        if (url.pathname === "/wallets" || url.pathname === "/wallets/real") {
          const liveReal = await orch.getRealLedger().auditLiveHoldings();
          return new Response(JSON.stringify(liveReal, null, 2), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // 7. Lista de Activos Activos
        if (url.pathname === "/metrics") {
          const activeCex = orch.getActiveCexTickers();
          const activeDex = orch.getActiveDexTickers();
          return new Response(
            JSON.stringify({ activeCex, activeDex, timestamp: new Date().toISOString() }, null, 2),
            {
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            }
          );
        }

        // 8. Control: Pausa
        if (req.method === "POST" && url.pathname === "/pause") {
          const target = (url.searchParams.get("target") || "all").toLowerCase();
          let msg = "";

          if (target === "paper" || target === "all") {
            orch.pausePaper();
            msg += "[PAPER: PAUSADO] ";
          }

          if (target === "live" || target === "all") {
            if (orch.getExecutionMode() === "LIVE") {
              orch.cancelLiveOrders();
              msg += "[LIVE: ORDENES CANCELADAS] ";
            } else {
              msg += "[LIVE: NO ACTIVO] ";
            }
          }

          await sendTelegramAlert(`[ALPHA ENGINE PAUSA] ${msg}`);
          return new Response(JSON.stringify({ success: true, target, message: msg }), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // 9. Control: Reanudar
        if (req.method === "POST" && url.pathname === "/resume") {
          const target = (url.searchParams.get("target") || "all").toLowerCase();
          let msg = "";

          if (target === "paper" || target === "all") {
            orch.resumePaper();
            msg += "[PAPER: REANUDADO] ";
          }

          if (target === "live" || target === "all") {
            msg += "[LIVE: QUOTING LISTO] ";
          }

          await sendTelegramAlert(`[ALPHA ENGINE REANUDAR] ${msg}`);
          return new Response(JSON.stringify({ success: true, target, message: msg }), {
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }

        // 10. Control: Kill-switch de riesgo (Fase 0)
        if (req.method === "POST" && url.pathname === "/kill") {
          const reason = url.searchParams.get("reason") || "Kill-switch manual activado por el operador.";
          orch.getRiskGuard().manualKillSwitch(reason);
          await sendTelegramAlert(`[ALPHA ENGINE] KILL-SWITCH ACTIVADO\n${reason}\nNuevas entradas BLOQUEADAS.`);
          return new Response(JSON.stringify({ success: true, killed: true, reason }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // 10.1. Control: Levantar kill-switch
        if (req.method === "POST" && url.pathname === "/unkill") {
          orch.getRiskGuard().clearKill();
          await sendTelegramAlert("[ALPHA ENGINE] KILL-SWITCH LEVANTADO. Nuevas entradas habilitadas.");
          return new Response(JSON.stringify({ success: true, killed: false }), {
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          });
        }

        // 11. Control: Flatten
        if (req.method === "POST" && url.pathname === "/flatten") {
          const target = (url.searchParams.get("target") || "paper").toLowerCase();
          try {
            if (target === "paper" || target === "all") {
              await orch.flattenPaperPositions();
              await sendTelegramAlert("[ALPHA ENGINE] FLATTEN SIMULADOR (PAPER): Posiciones cerradas a efectivo virtual.");
            }

            if (target === "live" || target === "all") {
              if (orch.getExecutionMode() === "LIVE") {
                const confirm = url.searchParams.get("confirm");
                if (confirm === "true") {
                  orch.cancelLiveOrders();
                  await sendTelegramAlert("[ALPHA ENGINE] FLATTEN LIVE EJECUTADO: Órdenes abiertas canceladas en Binance Spot.");
                } else {
                  return new Response(JSON.stringify({ error: "Flatten LIVE requiere confirm=true por seguridad" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                  });
                }
              }
            }

            return new Response(JSON.stringify({ success: true, target, message: `Flatten completado para target: ${target}` }), {
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            });
          } catch (e) {
            return new Response(JSON.stringify({ error: String(e) }), {
              status: 500,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            });
          }
        }

        return new Response("Alpha Engine Dynamic Multi-Asset Active.\n");
      },
    });
    console.log(`[HTTP] Servidor de telemetria escuchando en http://127.0.0.1:${this.port}`);
  }
}
