/**
 * Deteccion estricta de entorno de pruebas.
 *
 * Motivo: la suite de tests corre en el mismo arbol de trabajo que produccion y
 * escribio artefactos reales (logs forenses con ordenes marcadas como LIVE y
 * genomas "bestTesttoken"). Este guard es la unica puerta que decide si un
 * artefacto de produccion puede ser tocado.
 *
 * Criterio deliberadamente conservador: nunca debe devolver true en produccion.
 * Si hay duda, asume produccion (false) y el artefacto queda bloqueado, que es
 * el lado seguro del error.
 */

export function isTestEnvironment(): boolean {
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") return true;
  if (process.env.VITEST === "true" || process.env.JEST_WORKER_ID !== undefined) return true;

  // bun test / bun run *.test.ts
  if (process.argv.includes("test")) return true;
  if (process.argv.some((arg) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(arg))) return true;

  // Runner de bun test en proceso
  const g = globalThis as any;
  if (typeof g.describe === "function" && typeof g.expect === "function") return true;

  return false;
}

/**
 * Ejecuta una escritura solo si NO estamos en entorno de pruebas.
 * Devuelve true si la escritura fue autorizada.
 */
export function allowProductionWrite(): boolean {
  return !isTestEnvironment();
}
