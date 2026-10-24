import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guardia de higiene de secretos.
 *
 * Motivo: el token del bot de Alpha Engine estuvo embebido en dos archivos de
 * produccion (telegram-bot.ts y notifier.ts) y por tanto en el historial de git.
 * Este test impide que vuelva a ocurrir: falla si aparece cualquier patron de
 * token de Bot API de Telegram en el arbol de fuentes.
 */

const TOKEN_PATTERN = /bot\d{8,}:[A-Za-z0-9_-]{30,}|(?<![\w:])\d{9,10}:[A-Za-z0-9_-]{30,}/g;
const SCAN_DIRS = ["src", "scripts", "config"];
const SKIP_DIRS = new Set(["node_modules", ".git", "data", "backups", "dist"]);
const SKIP_FILES = new Set(["secret-hygiene.test.ts", "verify-open-items.ts"]);

function scan(dir: string, hits: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return hits;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) scan(full, hits);
    else if (/\.(ts|tsx|js|mjs|py|sh|json|service|timer)$/.test(entry) && !SKIP_FILES.has(entry)) {
      const content = readFileSync(full, "utf-8");
      const matches = content.match(TOKEN_PATTERN);
      if (matches) hits.push(`${full}: ${matches.length} coincidencia(s)`);
    }
  }
  return hits;
}

describe("higiene de secretos", () => {
  test("ningun token de Telegram embebido en el codigo", () => {
    const hits = SCAN_DIRS.flatMap((d) => scan(d));
    expect(hits).toEqual([]);
  });

  test("los consumidores de Telegram cargan el token desde secretos, no desde literales", () => {
    const bot = readFileSync("src/telemetry/telegram-bot.ts", "utf-8");
    const notifier = readFileSync("src/telemetry/notifier.ts", "utf-8");
    expect(bot).toContain("loadSecret(\"TELEGRAM_TOKEN\")");
    expect(notifier).toContain("loadSecret(\"TELEGRAM_TOKEN\")");
  });
});
