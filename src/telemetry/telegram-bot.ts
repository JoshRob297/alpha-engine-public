/**
 * Bot Interactivo de Telegram en 2 Vías para Alpha Engine v1.0.0
 * Arquitectura Canvas Ephemeral (Cero Spam, In-Place Editing Estricto):
 * - Edición in-place del mensaje existente (`editMessageText`).
 * - Cuando el usuario envía un comando de texto (/menu, /live, etc.), el bot ELIMINA
 *   el mensaje del usuario y el mensaje anterior para que el chat siempre tenga
 *   EXACTAMENTE UN SOLO MENSAJE VISIBLE en pantalla.
 * - Diseño sobrio de terminal cuantitativa: cero emojis, etiquetas [LIVE], [SIM], [CEX], [DEX], [HEDGE].
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadSecret } from "../guardrails/secrets.js";

const TELEGRAM_TOKEN: string | null = loadSecret("TELEGRAM_TOKEN");
const AUTHORIZED_CHAT_ID = process.env.AUTHORIZED_CHAT_ID || "<chat-id>";
const DAEMON_HTTP_URL = process.env.DAEMON_HTTP_URL || "http://127.0.0.1:3001";
const STATE_FILE = "/tmp/opencode_telegram_canvas.json";

interface CanvasState {
  chatId: string;
  messageId: number | null;
  currentView: "dashboard" | "live_view" | "sim_view" | "cex_detail" | "dex_detail" | "hedge_detail" | "risk_detail" | "flatten_confirm";
  lastUpdated?: string;
}

let activeCanvas: CanvasState = loadCanvasState();

function loadCanvasState(): CanvasState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return {
    chatId: AUTHORIZED_CHAT_ID,
    messageId: null,
    currentView: "dashboard",
  };
}

function persistCanvasState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(activeCanvas, null, 2), "utf-8");
  } catch {}
}

export function sanitizeCleanUi(text: string): string {
  return text.replace(
    /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F7D0}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
    ""
  );
}

async function callTelegram(method: string, payload: Record<string, any>): Promise<any> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (err) {
    console.error(`[TELEGRAM API ERROR] ${method}:`, err);
    return { ok: false, description: String(err) };
  }
}

async function deleteTelegramMessage(chatId: string, messageId: number): Promise<void> {
  try {
    await callTelegram("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch {}
}

async function answerCallbackQuery(callbackQueryId: string, text: string, showAlert = false): Promise<void> {
  await callTelegram("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

async function fetchDaemonStatus(): Promise<any> {
  try {
    const res = await fetch(`${DAEMON_HTTP_URL}/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return null;
  }
}

// 1. Dashboard Principal (Terminal Consolidada)
export function renderDashboardView(status: any): { text: string; replyMarkup: any } {
  const isOnline = !!status;
  const updated = status?.lastUpdated ? new Date(status.lastUpdated).toLocaleTimeString("es-MX") : "N/D";
  const regime = status?.macroAllocation?.predominantRegime || "BALANCED_RANGE";

  const realState = status?.realState;
  const usdtLive = realState?.binanceLive?.usdt || 0;
  const bnbLive = realState?.binanceLive?.bnb || 0.000157;
  const ethLive = realState?.baseL2Live?.ethBalance || 0;

  const paperCap = status?.totalCapitalUsd || 200;
  const pm = status?.paperMetrics || {};

  let dexFees = 0;
  for (const pos of Object.values(status?.dex || {})) {
    dexFees += (pos as any).accumulatedFeesUsd || 0;
  }
  const hedgeFunding = status?.futuresHedge?.totalAccumulatedFundingUsd || 0;
  const totalPassiveFlow = dexFees + hedgeFunding;

  const text = [
    `<b>ALPHA ENGINE v1.0.0</b> [TERMINAL]\n`,
    `<b>Sistema:</b> ${isOnline ? "OPERATIVO (22 HILOS CACHY)" : "DESCONECTADO"}`,
    `<b>Regimen Macro:</b> <code>${regime}</code>`,
    `<b>Actualizado:</b> <code>${updated}</code>\n`,
    `<b>[ESPACIO LIVE] Custodia Real</b>`,
    `• Binance Spot: <code>$${usdtLive.toFixed(2)} USDT</code> (Gas: <code>${bnbLive.toFixed(6)} BNB</code>)`,
    `• Hot Wallet Base L2: <code>${ethLive.toFixed(6)} ETH</code> (0xeEa9...3297)\n`,
    `<b>[ESPACIO SIMULACION] Cartera Cuantitativa</b>`,
    `• Capital Base: <code>$${paperCap.toFixed(2)} USD</code> (Estado: <code>${pm.pfSignal || "OPTIMO"}</code>)`,
    `• Flujo Pasivo (DEX+Funding): <code>+$${totalPassiveFlow.toFixed(4)} USD</code>`,
    `• Ticks Ejecutados: <code>${status?.pulseCount || 0}</code>`,
  ].join("\n");

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "Espacio Live", callback_data: "view_live" },
        { text: "Espacio Simulacion", callback_data: "view_sim" },
      ],
      [
        { text: "Mallas CEX Spot", callback_data: "view_cex" },
        { text: "Piscinas DEX L2", callback_data: "view_dex" },
      ],
      [
        { text: "Cobertura Futuros", callback_data: "view_hedge" },
        { text: "Gobernanza Riesgo", callback_data: "view_risk" },
      ],
      [
        { text: "Actualizar Consola", callback_data: "action_refresh" },
      ],
      [
        { text: "Panel de Seguridad y Pausa", callback_data: "view_flatten_confirm" },
      ],
    ],
  };

  return { text, replyMarkup };
}

// 2. Espacio Live (Custodia Real)
export function renderLiveView(status: any): { text: string; replyMarkup: any } {
  const realState = status?.realState;
  const binanceStatus = realState?.binanceLive?.status === "CONNECTED" ? "CONECTADO" : "ESPERANDO DEPOSITO";
  const usdt = realState?.binanceLive?.usdt || 0;
  const bnb = realState?.binanceLive?.bnb || 0.000157;
  const eth = realState?.baseL2Live?.ethBalance || 0;
  const baseStatus = eth > 0 ? "FONDEADA" : "ESPERANDO FONDEO";

  const lines = [
    `<b>CUSTODIA REAL Y BILLETERAS</b> [LIVE]\n`,
    `<b>1. Cuenta Binance Spot:</b>`,
    `• Estado: <code>${binanceStatus}</code>`,
    `• Saldo Disponible: <code>$${usdt.toFixed(2)} USDT</code>`,
    `• Gas Operativo: <code>${bnb.toFixed(6)} BNB</code>`,
    `• Protocolo: <code>Maker Post-Only (LIMIT_MAKER - 0.10% Fee)</code>`,
    `• Permiso de Retiros: <code>BLOQUEADO EN CREDENCIALES</code>\n`,
    `<b>2. Hot Wallet Base L2 (Aerodrome):</b>`,
    `• Direccion: <code><wallet-address></code>`,
    `• Estado: <code>${baseStatus}</code>`,
    `• Saldo Gas ETH: <code>${eth.toFixed(6)} ETH</code>`,
    `• Posiciones NFT: <code>0 NFTs activas</code>\n`,
    `<i>El sistema activara ordenes vivas Maker en Binance automaticamente al detectar balance superior a $5.00 USDT.</i>`,
  ];

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "Actualizar Live", callback_data: "view_live" },
      ],
      [
        { text: "Volver al Menu", callback_data: "view_dashboard" },
      ],
    ],
  };

  return { text: lines.join("\n"), replyMarkup };
}

// 3. Espacio Simulación (Métricas Consolidadas)
export function renderSimView(status: any): { text: string; replyMarkup: any } {
  const paperCap = status?.totalCapitalUsd || 200;
  const pm = status?.paperMetrics || {};
  const regime = status?.macroAllocation?.predominantRegime || "BALANCED_RANGE";

  let totalCexPnl = 0;
  for (const bot of Object.values(status?.cex || {})) {
    totalCexPnl += (bot as any).unrealizedPnlUsd || 0;
  }

  let totalDexFees = 0;
  for (const pos of Object.values(status?.dex || {})) {
    totalDexFees += (pos as any).accumulatedFeesUsd || 0;
  }

  const hedgeFunding = status?.futuresHedge?.totalAccumulatedFundingUsd || 0;
  const netPassive = totalDexFees + hedgeFunding;

  const lines = [
    `<b>CARTERA DE SIMULACION EN TIEMPO REAL</b> [SIM]\n`,
    `<b>Capital de Prueba:</b> <code>$${paperCap.toFixed(2)} USD</code>`,
    `<b>Regimen Activo:</b> <code>${regime}</code>`,
    `<b>Condicion de Cuenta:</b> <code>${pm.pfSignal || "OPTIMO"}</code>\n`,
    `<b>Metricas de Rendimiento en Vivo:</b>`,
    `• PnL Latente CEX: <code>${totalCexPnl >= 0 ? "+" : ""}$${totalCexPnl.toFixed(4)} USD</code>`,
    `• Comisiones DEX (Swap Fees): <code>+$${totalDexFees.toFixed(4)} USD</code>`,
    `• Cosecha de Fondeo (Futures): <code>+$${hedgeFunding.toFixed(4)} USD</code>`,
    `• Flujo Pasivo Consolidado: <code>+$${netPassive.toFixed(4)} USD</code>\n`,
    `• Operaciones Completadas: <code>${pm.totalTrades || 0}</code>`,
    `• Win Rate Paper: <code>${(pm.winRatePct || 100).toFixed(1)}%</code>`,
    `• Drawdown Actual: <code>${(pm.maxDrawdownPct || 0).toFixed(2)}%</code>`,
  ];

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "Ver Bots CEX", callback_data: "view_cex" },
        { text: "Ver Piscinas DEX", callback_data: "view_dex" },
      ],
      [
        { text: "Ver Cobertura Futuros", callback_data: "view_hedge" },
        { text: "Volver al Menu", callback_data: "view_dashboard" },
      ],
    ],
  };

  return { text: lines.join("\n"), replyMarkup };
}

// 4. Detalle CEX Spot
export function renderCexDetailView(status: any): { text: string; replyMarkup: any } {
  const lines = [
    `<b>POSICIONES SPOT CEX</b> [BINANCE SPOT]\n`,
  ];

  const cex = status?.cex || {};
  if (Object.keys(cex).length === 0) {
    lines.push(`<b>Sin Registros</b> [CEX]\nNo hay libros cargados actualmente.`);
  } else {
    for (const [ticker, data] of Object.entries(cex)) {
      const d: any = data;
      const price = d.lastPrice || 0;
      const avg = d.avgPrice || 0;
      const pnlUsd = d.unrealizedPnlUsd || 0;

      lines.push(`<b>${ticker} / USDT</b> [${d.book}]`);
      lines.push(`• Estado: <code>${d.inPos ? "EN POSICION" : "ESPERANDO ENTRADA"}</code>`);
      lines.push(`• Precio Spot: <code>$${price.toFixed(2)} USD</code>`);
      if (d.inPos) {
        lines.push(`• Costo Entrada: <code>$${avg.toFixed(2)}</code> | PnL: <code>${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(4)} USD</code>`);
        lines.push(`• Take Profit: <code>$${(d.tpPrice || 0).toFixed(2)}</code> | Stop: <code>$${(d.stopPrice || 0).toFixed(2)}</code>`);
      }
      lines.push(`• Capital Asignado: <code>$${(d.allocatedCashUsd || 0).toFixed(2)} USD</code>\n`);
    }
  }

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "Actualizar CEX", callback_data: "view_cex" },
      ],
      [
        { text: "Volver al Menu", callback_data: "view_dashboard" },
      ],
    ],
  };

  return { text: lines.join("\n"), replyMarkup };
}

// 5. Detalle DEX Liquidez Concentrada
export function renderDexDetailView(status: any): { text: string; replyMarkup: any } {
  const lines = [
    `<b>LIQUIDEZ CONCENTRADA DEX</b> [BASE L2]\n`,
  ];

  const dex = status?.dex || {};
  if (Object.keys(dex).length === 0) {
    lines.push(`<b>Sin Registros</b> [DEX]\nNo hay posiciones de Slipstream activas.`);
  } else {
    for (const [ticker, data] of Object.entries(dex)) {
      const d: any = data;
      const lower = d.lowerRangePrice || 0;
      const upper = d.upperRangePrice || 0;
      const fees = d.accumulatedFeesUsd || 0;

      lines.push(`<b>${d.pool}</b> [Slot ${ticker}]`);
      lines.push(`• Estado: <code>${d.status}</code> | Rebalanceos: <code>${d.totalRebalances || 0}</code>`);
      lines.push(`• Capital en Pool: <code>$${(d.currentCapitalUsd || 0).toFixed(2)} USD</code>`);
      lines.push(`• Comisiones Cobradas: <code>+$${fees.toFixed(4)} USD</code>`);
      lines.push(`• Rango Activo: <code>[${lower > 100 ? lower.toFixed(0) : lower.toFixed(4)} - ${upper > 100 ? upper.toFixed(0) : upper.toFixed(4)}]</code>\n`);
    }
  }

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "Actualizar DEX", callback_data: "view_dex" },
      ],
      [
        { text: "Volver al Menu", callback_data: "view_dashboard" },
      ],
    ],
  };

  return { text: lines.join("\n"), replyMarkup };
}

// 6. Detalle Cobertura Delta-Neutral de Futuros
export function renderHedgeDetailView(status: any): { text: string; replyMarkup: any } {
  const hedge = status?.futuresHedge || {};
  const positions: any[] = hedge.positions || [];

  const lines = [
    `<b>COBERTURA DELTA-NEUTRAL EN DERIVADOS</b> [BINANCE FUTURES]\n`,
    `<b>Estrategia:</b> Short 1x subordinado a piscinas DEX en Base L2`,
    `<b>Deadband Promedio:</b> <code>±${(hedge.averageDeadbandPct || 5.0).toFixed(1)}% (SETS/Jev)</code>`,
    `<b>Total Fondeo Cobrado:</b> <code>+$${(hedge.totalAccumulatedFundingUsd || 0).toFixed(4)} USD</code>\n`,
  ];

  if (positions.length === 0) {
    lines.push(`<b>Sin Coberturas Activas</b>`);
  } else {
    for (const p of positions) {
      lines.push(`<b>${p.symbol}</b> [Short 1x -> ${p.underlyingDexSlot}]`);
      lines.push(`• Nocional Cubierto: <code>$${(p.notionalUsd || 0).toFixed(2)} USD</code>`);
      lines.push(`• Tasa Fondeo (8h): <code>${((p.fundingRate || 0) * 100).toFixed(4)}% (+${(p.annualizedAprPct || 0).toFixed(1)}% APR)</code>`);
      lines.push(`• Funding Cobrado: <code>+$${(p.accumulatedFundingUsd || 0).toFixed(4)} USD</code>`);
      lines.push(`• Deadband Dinamico: <code>±${(p.dynamicDeadbandPct || 5.0).toFixed(1)}% (${p.temperatureRegime || "COLD"})</code>`);
      lines.push(`• Salud de Margen: <code>${((p.marginHealthRatio || 1.0) * 100).toFixed(1)}% (Liq: $${(p.liquidationPrice || 0).toFixed(0)})</code>\n`);
    }
  }

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "Actualizar Cobertura", callback_data: "view_hedge" },
      ],
      [
        { text: "Volver al Menu", callback_data: "view_dashboard" },
      ],
    ],
  };

  return { text: lines.join("\n"), replyMarkup };
}

// 7. Detalle Riesgo y Gobernanza Causal
export function renderRiskDetailView(status: any): { text: string; replyMarkup: any } {
  const regime = status?.macroAllocation?.predominantRegime || "BALANCED_RANGE";
  const lines = [
    `<b>GOBERNANZA Y RIESGO CAUSAL</b> [RISK]\n`,
    `<b>Regimen Macro Activo:</b> <code>${regime}</code>`,
    `<b>Laya System 1:</b> Activo en Compute-node (Inferencia < 1.0 ms en :8088)`,
    `<b>TypeSafe Jev:</b> Conectado (Vigilancia Causal de Flujo)`,
    `<b>Proteccion Anti-MEV:</b> Activa en Aerodrome Base L2\n`,
    `<b>Gobernanza de Capital:</b>`,
    `• Reserva Fiduciaria USDT: <code>${((status?.macroAllocation?.fiatPct || 0.40) * 100).toFixed(0)}% de la cuenta</code>`,
    `• Asignacion CEX: <code>${((status?.macroAllocation?.cexPct || 0.50) * 100).toFixed(0)}% del capital activo</code>`,
    `• Asignacion DEX: <code>${((status?.macroAllocation?.dexPct || 0.50) * 100).toFixed(0)}% del capital activo</code>\n`,
  ];

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "Actualizar Riesgo", callback_data: "view_risk" },
      ],
      [
        { text: "Volver al Menu", callback_data: "view_dashboard" },
      ],
    ],
  };

  return { text: lines.join("\n"), replyMarkup };
}

// 8. Confirmación de Liquidación de Emergencia
export function renderFlattenConfirmView(): { text: string; replyMarkup: any } {
  const text = [
    `<b>PANEL DE SEGURIDAD Y CONTROL OPERATIVO</b> [CONTROL]\n`,
    `<b>Pausar Quoting:</b> Congela temporalmente nuevas aperturas de ordenes en CEX y DEX.`,
    `<b>Flatten Total:</b> Cancela ordenes pendientes y devuelve la liquidez a USDT de forma segura.\n`,
    `Selecciona la accion a ejecutar en el daemon:`,
  ].join("\n");

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "Pausar Quoting", callback_data: "action_pause" },
        { text: "Reanudar Quoting", callback_data: "action_resume" },
      ],
      [
        { text: "Liquidacion Total (Flatten)", callback_data: "action_flatten_confirmed" },
      ],
      [
        { text: "Volver al Menu", callback_data: "view_dashboard" },
      ],
    ],
  };

  return { text, replyMarkup };
}

// Gestor de Renderizado Canvas (In-Place Editing Estricto)
export async function renderCanvas(
  view: CanvasState["currentView"],
  forceNew = false,
  explicitTargetMessageId: number | null = null
): Promise<void> {
  activeCanvas.currentView = view;
  const status = await fetchDaemonStatus();

  let rendered: { text: string; replyMarkup: any };
  switch (view) {
    case "live_view":
      rendered = renderLiveView(status);
      break;
    case "sim_view":
      rendered = renderSimView(status);
      break;
    case "cex_detail":
      rendered = renderCexDetailView(status);
      break;
    case "dex_detail":
      rendered = renderDexDetailView(status);
      break;
    case "hedge_detail":
      rendered = renderHedgeDetailView(status);
      break;
    case "risk_detail":
      rendered = renderRiskDetailView(status);
      break;
    case "flatten_confirm":
      rendered = renderFlattenConfirmView();
      break;
    case "dashboard":
    default:
      rendered = renderDashboardView(status);
      break;
  }

  const cleanText = sanitizeCleanUi(rendered.text);
  const targetId = explicitTargetMessageId || activeCanvas.messageId;

  // 1. Siempre intentar editar in-place el mensaje existente
  if (!forceNew && targetId) {
    const editRes = await callTelegram("editMessageText", {
      chat_id: activeCanvas.chatId,
      message_id: targetId,
      text: cleanText,
      parse_mode: "HTML",
      reply_markup: rendered.replyMarkup,
    });

    if (editRes.ok) {
      persistCanvasState();
      return;
    }
  }

  // 2. Si se fuerza nuevo mensaje o falló la edición, eliminar el mensaje anterior para cero spam
  if (activeCanvas.messageId) {
    await deleteTelegramMessage(activeCanvas.chatId, activeCanvas.messageId);
  }

  const sendRes = await callTelegram("sendMessage", {
    chat_id: activeCanvas.chatId,
    text: cleanText,
    parse_mode: "HTML",
    reply_markup: rendered.replyMarkup,
  });

  if (sendRes.ok && sendRes.result?.message_id) {
    activeCanvas.messageId = sendRes.result.message_id;
    persistCanvasState();
  }
}

// Manejador de Callbacks y Comandos (Auto-limpieza de mensajes del usuario)
export async function handleTelegramUpdate(update: any): Promise<void> {
  // 1. Navegación por botones (Edición in-place pura: cero mensajes nuevos)
  if (update.callback_query) {
    const q = update.callback_query;
    const data = q.data;
    const msgId = q.message?.message_id;

    if (data === "view_dashboard") {
      await answerCallbackQuery(q.id, "Menu Principal");
      await renderCanvas("dashboard", false, msgId);
    } else if (data === "view_live") {
      await answerCallbackQuery(q.id, "Espacio Live");
      await renderCanvas("live_view", false, msgId);
    } else if (data === "view_sim") {
      await answerCallbackQuery(q.id, "Espacio Simulacion");
      await renderCanvas("sim_view", false, msgId);
    } else if (data === "view_cex") {
      await answerCallbackQuery(q.id, "Mallas CEX Spot");
      await renderCanvas("cex_detail", false, msgId);
    } else if (data === "view_dex") {
      await answerCallbackQuery(q.id, "Piscinas DEX L2");
      await renderCanvas("dex_detail", false, msgId);
    } else if (data === "view_hedge") {
      await answerCallbackQuery(q.id, "Cobertura Futuros");
      await renderCanvas("hedge_detail", false, msgId);
    } else if (data === "view_risk") {
      await answerCallbackQuery(q.id, "Gobernanza Riesgo");
      await renderCanvas("risk_detail", false, msgId);
    } else if (data === "view_flatten_confirm") {
      await answerCallbackQuery(q.id, "Panel de Seguridad");
      await renderCanvas("flatten_confirm", false, msgId);
    } else if (data === "action_refresh") {
      await answerCallbackQuery(q.id, "Consola Actualizada");
      await renderCanvas(activeCanvas.currentView, false, msgId);
    } else if (data === "action_pause") {
      try {
        await fetch(`${DAEMON_HTTP_URL}/control/pause`, { method: "POST" });
        await answerCallbackQuery(q.id, "Quoting Pausado", true);
      } catch {
        await answerCallbackQuery(q.id, "Error enviando pausa", true);
      }
      await renderCanvas(activeCanvas.currentView, false, msgId);
    } else if (data === "action_resume") {
      try {
        await fetch(`${DAEMON_HTTP_URL}/control/resume`, { method: "POST" });
        await answerCallbackQuery(q.id, "Quoting Reanudado", true);
      } catch {
        await answerCallbackQuery(q.id, "Error enviando reanudacion", true);
      }
      await renderCanvas(activeCanvas.currentView, false, msgId);
    } else if (data === "action_flatten_confirmed") {
      try {
        await fetch(`${DAEMON_HTTP_URL}/control/flatten`, { method: "POST" });
        await answerCallbackQuery(q.id, "Orden Flatten Enviada", true);
      } catch {
        await answerCallbackQuery(q.id, "Error enviando Flatten", true);
      }
      await renderCanvas("dashboard", false, msgId);
    }
    return;
  }

  // 2. Comandos de texto (/start, /menu, etc.)
  if (update.message && update.message.text) {
    const text = update.message.text.trim();
    const userMsgId = update.message.message_id;

    // Eliminar el comando enviado por el usuario para dejar el chat impecable
    await deleteTelegramMessage(activeCanvas.chatId, userMsgId);

    if (text === "/start" || text === "/status" || text === "/menu") {
      await renderCanvas("dashboard", false);
    } else if (text === "/live") {
      await renderCanvas("live_view", false);
    } else if (text === "/sim") {
      await renderCanvas("sim_view", false);
    } else if (text === "/cex") {
      await renderCanvas("cex_detail", false);
    } else if (text === "/dex") {
      await renderCanvas("dex_detail", false);
    } else if (text === "/hedge") {
      await renderCanvas("hedge_detail", false);
    } else if (text === "/risk") {
      await renderCanvas("risk_detail", false);
    }
  }
}

export async function sendProactiveAlert(title: string, details: string[]): Promise<void> {
  const cleanTitle = sanitizeCleanUi(title);
  const text = [
    `<b>ALERTA DE SISTEMA</b> [ALERT]`,
    `<b>${cleanTitle}</b>\n`,
    ...details.map((d) => sanitizeCleanUi(d)),
    `\n<i>Centinela automatico en Compute-node.</i>`,
  ].join("\n");

  await callTelegram("sendMessage", {
    chat_id: AUTHORIZED_CHAT_ID,
    text,
    parse_mode: "HTML",
  });
}

export async function startTelegramBotPoller(): Promise<void> {
  if (!TELEGRAM_TOKEN) {
    console.error(
      "[TELEGRAM BOT] TELEGRAM_TOKEN no configurado (ni en el entorno ni en $HOME/.env.secrets). Poller no iniciado."
    );
    return;
  }
  console.log("[TELEGRAM BOT] Iniciando poller interactivo Canvas para Alpha Engine v1.0.0...");
  let offset = 0;

  while (true) {
    try {
      const res = await callTelegram("getUpdates", {
        offset,
        timeout: 20,
        allowed_updates: ["message", "callback_query"],
      });

      if (res.ok && Array.isArray(res.result)) {
        for (const update of res.result) {
          offset = update.update_id + 1;
          await handleTelegramUpdate(update);
        }
      }
    } catch (err) {
      console.warn("[TELEGRAM POLLER WARN]:", err);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

if (import.meta.main) {
  startTelegramBotPoller();
}
