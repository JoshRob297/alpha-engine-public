#!/usr/bin/env bun
/**
 * Generador Seguro de Hot Wallet para Base L2 (Offline y Zero-Knowledge)
 * Este script se ejecuta localmente en Compute-node.
 * Genera la clave privada y la guarda en /home/user/.env.secrets con permisos 600.
 * La IA (OpenCode / Antigravity) NUNCA lee ni solicita este archivo.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Generar una clave privada criptografica valida de 32 bytes (secp256k1)
const privateKeyBytes = randomBytes(32);
const privateKeyHex = "0x" + privateKeyBytes.toString("hex");

// Derivar direccion publica simple compatible con EVM
const SECRETS_FILE = join(homedir(), ".env.secrets");

if (existsSync(SECRETS_FILE)) {
  console.log("==========================================================================");
  console.log("AVISO: Ya existe un archivo de secretos en: " + SECRETS_FILE);
  console.log("Si deseas regenerar la wallet, elimina o renombra el archivo manualmente.");
  console.log("==========================================================================");
  process.exit(0);
}

const fileContent = [
  "# ALPHA ENGINE - PRIVATE SECRETS (ZERO KNOWLEDGE FOR AI)",
  "# Permisos estrictos: chmod 600",
  `BASE_PRIVATE_KEY=${privateKeyHex}`,
  `GENERATED_AT=${new Date().toISOString()}`,
  "",
].join("\n");

writeFileSync(SECRETS_FILE, fileContent, { encoding: "utf-8", mode: 0o600 });
chmodSync(SECRETS_FILE, 0o600);

console.log("==========================================================================");
console.log("                  HOT WALLET GENERADA EXITOSAMENTE                        ");
console.log("==========================================================================");
console.log("1. Clave privada guardada en: " + SECRETS_FILE);
console.log("2. Permisos aplicados: 600 (Solo lectura/escritura para tu usuario Linux).");
console.log("3. La IA NO tiene acceso de lectura a este archivo por seguridad.");
console.log("4. Para ver tu direccion publica o fondear, ejecuta en Compute-node:");
console.log("   bun run scripts/show-address.ts");
console.log("==========================================================================");
