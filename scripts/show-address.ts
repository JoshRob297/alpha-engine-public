#!/usr/bin/env bun
/**
 * Muestra la direccion publica de la Hot Wallet en Base
 * respetando el aislamiento estricto de la clave privada.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ethers } from "ethers";

const SECRETS_FILE = join(homedir(), ".env.secrets");

if (!existsSync(SECRETS_FILE)) {
  console.log("No existe el archivo de secretos en: " + SECRETS_FILE);
  process.exit(1);
}

const content = readFileSync(SECRETS_FILE, "utf-8");
const match = content.match(/BASE_PRIVATE_KEY=(0x[a-fA-F0-9]{64})/);

if (!match) {
  console.log("Error: No se encontro BASE_PRIVATE_KEY valida en .env.secrets");
  process.exit(1);
}

const wallet = new ethers.Wallet(match[1]);

console.log("==========================================================================");
console.log("                     HOT WALLET ADDRESS (BASE L2)                         ");
console.log("==========================================================================");
console.log("DIRECCION PUBLICA DEPOSITO:");
console.log(wallet.address);
console.log("--------------------------------------------------------------------------");
console.log("Red de retiro requerida:  BASE (Chain ID: 8453)");
console.log("Moneda sugerida a retirar: ETH");
console.log("Basescan Explorer:        https://basescan.org/address/" + wallet.address);
console.log("==========================================================================");
