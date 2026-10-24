/**
 * Carga de secretos.
 *
 * Regla del proyecto: PROHIBIDO hardcodear tokens o claves en el codigo versionado.
 * Orden de resolucion:
 *   1. Variable de entorno.
 *   2. $HOME/.env.secrets (chmod 600, fuera del arbol de git).
 *
 * Si no se encuentra, se devuelve null: el consumidor debe degradar de forma visible
 * (no iniciar el servicio o silenciar la notificacion) en lugar de usar un valor por
 * defecto embebido.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function loadSecret(key: string): string | null {
  const fromEnv = process.env[key];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

  try {
    const secretsPath = join(homedir(), ".env.secrets");
    if (existsSync(secretsPath)) {
      for (const line of readFileSync(secretsPath, "utf-8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
        if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {}

  return null;
}

export function getSecretsPath(): string {
  return join(homedir(), ".env.secrets");
}
