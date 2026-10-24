/**
 * Notificador Telegram nativo dedicado para Alpha Engine
 * Respeta la REGLA CERO EMOJIS de AGENTS.md
 */

import { loadSecret } from "../guardrails/secrets.js";

// Bot dedicado exclusivamente para Alpha Engine.
// El token NUNCA se embebe en el codigo: se resuelve de entorno o $HOME/.env.secrets.
const TELEGRAM_TOKEN: string | null = loadSecret("TELEGRAM_TOKEN");
const TELEGRAM_CHAT_ID: string | null = loadSecret("TELEGRAM_CHAT_ID") || "<chat-id>";

let missingTokenWarned = false;

export async function sendTelegramAlert(message: string): Promise<boolean> {
  // FILTRO ESTRICTO: Silenciar completamente alertas de simulación PAPER
  // Solo se transmiten eventos de dinero real (LIVE / REAL) o arranque de servicios
  if (
    message.includes("[ALPHA ENGINE PAPER]") ||
    message.includes("[PAPER]") ||
    message.includes("SIMULACIÓN") ||
    message.includes("Virtual Cash")
  ) {
    return true; // Silenciado intencionalmente
  }

  // Filtrar emojis para cumplir Clean UI total
  const cleanMessage = message.replace(
    /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
    ""
  );

  if (!TELEGRAM_TOKEN) {
    if (!missingTokenWarned) {
      missingTokenWarned = true;
      console.error(
        "[NOTIFIER] TELEGRAM_TOKEN no configurado (entorno o $HOME/.env.secrets): notificaciones deshabilitadas."
      );
    }
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: cleanMessage,
        parse_mode: "HTML",
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("Error enviando alerta por Telegram:", err);
    return false;
  }
}
