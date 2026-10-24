/**
 * Cadena de hashes (hash chain) para los logs forenses.
 *
 * Objetivo: que el audit log sea a prueba de reescritura. Cada registro incluye
 * `prevHash` (hash del registro anterior del mismo archivo) y `hash`
 * (sha256 de `${prevHash}|${canonical}`), de modo que alterar, borrar o
 * reordenar una linea rompe la cadena y la verificacion lo detecta.
 *
 * Modulo puro: sin acceso a disco ni a red. Solo `node:crypto`.
 */

import { createHash } from "node:crypto";

/** Hash inicial de una cadena (64 ceros en hexadecimal). */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Serializa un registro a JSON canonico: las claves de objeto se ordenan
 * alfabeticamente de forma recursiva, para que el hash sea estable
 * independientemente del orden de insercion.
 *
 * Se excluyen `hash` y `prevHash` del NIVEL SUPERIOR: son metadatos derivados de
 * la propia cadena y no deben entrar en el calculo. Las claves anidadas con esos
 * mismos nombres NO se excluyen a proposito: forman parte de los datos y deben
 * quedar cubiertas por el hash (excluirlas abriria un punto ciego donde una
 * manipulacion pasaria inadvertida).
 */
export function canonicalizeForHash(record: Record<string, unknown>): string {
  return JSON.stringify(canonicalizeValue(record, true));
}

function canonicalizeValue(value: unknown, isRoot: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item, false));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (isRoot && (key === "hash" || key === "prevHash")) continue;
      ordered[key] = canonicalizeValue(source[key], false);
    }
    return ordered;
  }
  return value;
}

/**
 * Hash sha256 (hex) de `${prevHash}|${canonical}`, donde `canonical` es la
 * serializacion canonica del registro (metadatos de cadena excluidos).
 */
export function computeRecordHash(record: Record<string, unknown>, prevHash: string): string {
  const canonical = canonicalizeForHash(record);
  return createHash("sha256").update(`${prevHash}|${canonical}`).digest("hex");
}

export interface ChainVerificationResult {
  ok: boolean;
  checked: number;
  legacySkipped: number;
  brokenAt: number | null;
  brokenId: string | null;
}

/**
 * Verifica la integridad de una cadena de registros leidos en orden de archivo.
 *
 * - Los registros SIN `hash` son pre-cadena (escritos antes de habilitar la
 *   cadena): se cuentan en `legacySkipped` y no se verifican. La cadena arranca
 *   en el primer registro con hash, sembrada con `GENESIS_HASH`.
 * - Un registro con hash que no coincide con el esperado (o cuyo `prevHash`
 *   declarado no enlaza con el registro verificado anterior) marca la ruptura:
 *   `ok=false`, `brokenAt` = indice del archivo y `brokenId` = su id.
 * - La continuidad se ancla en el hash PERSISTIDO del registro, para que una
 *   manipulacion local se reporte en su propio indice sin contaminar los
 *   registros posteriores.
 */
export function verifyChain(records: Record<string, any>[]): ChainVerificationResult {
  let expected = GENESIS_HASH;
  let checked = 0;
  let legacySkipped = 0;
  let brokenAt: number | null = null;
  let brokenId: string | null = null;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const hasHash =
      record !== null &&
      typeof record === "object" &&
      typeof record.hash === "string" &&
      record.hash.length > 0;

    if (!hasHash) {
      legacySkipped++;
      continue;
    }

    checked++;
    const expectedHash = computeRecordHash(record, expected);
    const prevHashMatches =
      typeof record.prevHash === "string" ? record.prevHash === expected : true;

    if (record.hash !== expectedHash || !prevHashMatches) {
      if (brokenAt === null) {
        brokenAt = i;
        brokenId = typeof record.id === "string" ? record.id : null;
      }
    }

    expected = record.hash;
  }

  return { ok: brokenAt === null, checked, legacySkipped, brokenAt, brokenId };
}
