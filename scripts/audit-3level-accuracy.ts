/**
 * AUDITORÍA RIGUROSA DE ACIERTOS EN 3 NIVELES:
 * 1. Nivel 1: Concordancia Categórica Exacta (Label Identity)
 * 2. Nivel 2: Concordancia Direccional de Riesgo (Risk Posture Alignment)
 *    - POSTURA SEGURA  : [BALANCED_RANGE, AGGRESSIVE_ACCUMULATION] -> Compras Maker permitidas
 *    - POSTURA PELIGRO : [DEFENSIVE_STRESS] -> Bloqueo preventivo de compras
 * 3. Nivel 3: Acierto Financiero Real (PnL Outcome en velas futuras)
 *    - Si el modelo predijo DEFENSIVE_STRESS, ¿el precio efectivamente cayó en las siguientes horas?
 *    - Si predijo AGGRESSIVE / BALANCED, ¿el precio rebotó o se mantuvo en rango?
 */

import { readFileSync, writeFileSync } from "node:fs";

console.log("Iniciando auditoría profunda de aciertos en 3 niveles...");
