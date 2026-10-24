# Plan de accion (2026-10-24)

Objetivo: cerrar la hipotesis de trading con el veredicto formal, reposicionar el proyecto
como laboratorio de validacion y, solo si se decide, abrir UN experimento nuevo de baja
frecuencia bajo el mismo protocolo. Ningun capital real sin pasar las compuertas.

Estado de partida: ventana OOS reiniciada 2026-10-24T17:49:08Z (valida, n=0, ~15-23
cierres/dia -> objetivo 191 en ~8-12 dias). Motor en PAPER con todo el stack de integridad
activo. Dashboard ya muestra la equity auditada.

---

## Fase 0 — Congelamiento y monitoreo (ahora hasta el veredicto)

Regla de oro: **cero cambios al codigo del trader**. La ventana es el ultimo test del diseno.

| # | Accion | Responsable | Plazo | Verificacion |
|---|---|---|---|---|
| 0.1 | Rotar el token del bot en BotFather y actualizar `/home/user/.env.secrets` (TELEGRAM_TOKEN). El valor viejo sigue ACTIVO y en el historial de git | Operador | 1 dia | `getMe` del token viejo devuelve `unauthorized`; `verify:open-items --check-telegram-token` muestra el nuevo ACTIVO |
| 0.2 | **HECHO 2026-10-24.** Auditar `scripts/deploy-pool.ts`: no escribia estado ni firmaba transacciones, pero generaba ~5.760 lineas/dia de journal y ~5.760 llamadas RPC/dia, mantenia la clave privada en memoria y anunciaba APR proyectado como hecho. Reescrito: poll 60 s con backoff, log solo en cambios + heartbeat horario, direccion desde `BASE_WALLET_ADDRESS` (sin clave en memoria), eventos en el audit log, sin proyecciones en las alertas, modo `--once` | Agente | Hecho | Verificado en compute-node: journal 15 lineas en 4 min (antes 16/4min de spam continuo), 2 eventos `BASE_WALLET_BALANCE_CHANGED` en el log encadenado |
| 0.3 | Revision diaria automatica ya en curso: reporte 21:10 CST, dead-man 22:00 CST, monitor de deriva horario | Automatico | Continuo | Artefacto diario fresco + Telegram; cero `CAPITAL_REPAIR`; `capitalMovedTotalUsd` estable |
| 0.4 | Vigilar que el regimen de asignacion quede anclado (12 h de persistencia) | Agente | Continuo | Sin eventos `REBALANCE_TO_POLICY` masivos; churn semanal < 10 USD |

## Fase 1 — Veredicto y cierre (se dispara con n>=191 OOS o regla de parada)

Compuertas de decision (pre-registradas, `evaluateStopRule`):
- **REFUTADO**: bootstrap IC95% < 0 Y binomial (WR < breakeven) p < 0.05.
- **PARADA RECOMENDADA**: bootstrap IC95% < 0 sin rechazo binomial.
- **CONTINUE**: sin evidencia suficiente.

| # | Accion | Responsable | Verificacion |
|---|---|---|---|
| 1.1 | Emitir el veredicto formal con el reporte completo (OOS + walk-forward + escalado + contrafactuales) | Agente | Artefacto `paper_validation_<fecha>.json` con `stopRule.action` y tabla en docs |
| 1.2 | Si REFUTADO (esperado): detener `alpha-engine.service` y `alpha-engine-bot.service`; dejar `laya.service`, `watcher` (o parar si 0.2 lo dicta), timers de reporte/monitor activos | Agente | Servicios `inactive`; estado final archivado |
| 1.3 | Backup de cierre: estado final + audit logs + serie equity + replay, con sha256 registrado en el KB | Agente | Archivo en `data/archive/final_<fecha>/` + hashes en docs |
| 1.4 | Actualizar `docs/CONCLUSIONS.md` con el veredicto final y la ficha del KB | Agente | Commit en ambos repos |

## Fase 2 — Reposicionamiento: laboratorio de validacion como producto (2-4 semanas)

El activo con moat es el stack que refuto al propio motor: protocolo pre-registrado, OOS,
bootstrap por bloques, binomial exacto, walk-forward, escalado, invariante de conservacion,
cadena de hashes, replay determinista, auditoria on-chain de fees.

| # | Accion | Responsable | Verificacion |
|---|---|---|---|
| 2.1 | **HECHO 2026-10-24.** Whitepaper del caso de estudio: afirmacion original -> metodo pre-registrado -> resultados -> hallazgos de auditoria (dos fugas, IL 30x, APR 10,6-82,7%, gas 119-507%, dashboard falso) -> que hace el laboratorio como producto -> limitaciones | Agente | `docs/VALIDATION_LAB_WHITEPAPER.md` (commit `daa4a8f`) |
| 2.2 | **HECHO 2026-10-24.** Spec del servicio (`docs/AUDIT_SERVICE_SPEC.md`): ingesta, proceso, contrato de salida, clases de veredicto, limites, confidencialidad y demo. Demo reproducible en un comando (`bun run audit:demo`) con dos casos sinteticos: una estrategia deceptiva (REFUTADA) y una sana (NO REFUTADA). **Hallazgo del control negativo:** el reporte calculaba el veredicto sobre el PnL bruto; corregido a neto de fees/slippage | Agente | Hecho: demo 2/2 correctos, reporte corregido |
| 2.2b | **HECHO 2026-10-24.** Capa canonica + adaptadores (respuesta a "cada bot hace lo suyo"): `src/audit/canonical.ts` (modelo + derivacion de PnL + compuerta de suficiencia), adaptador del motor, adaptador generico JSON/JSONL/CSV con mapeo, convencion de signo de costes y `pnlKind`. Demo con tercer caso (MT4 CSV) auditado desde un formato ajeno; 16 tests nuevos | Agente | Hecho: 273 tests, demo 3/3 |
| 2.3 | **HECHO 2026-10-24.** CLI `alpha-audit` (scripts/alpha-audit.ts + bin en package.json): ingesta con hash, adaptador auto/alpha-engine/generic, `--mapping`, autodeteccion de delimitador, compuerta de calidad, `--oos-start`, `--json`, reporte en `data/audit_reports/`. Exit 0/3/1. Motor de decision extraido a `src/audit/audit-run.ts` con 7 tests | Agente | Hecho: probado sobre estado del motor (REFUTADO), CSV MT4 (NO CONCLUYENTE) y solo-PnL (NO AUDITABLE, exit 3) |
| 2.5 | **HECHO 2026-10-24.** Prospección automática (`prospect:freqtrade`): busca repos, clasifica (auditable / solo agregados / capturas / fixtures) y audita los JSON de Freqtrade con `runAudit`. Lote: 8 datasets → 3 auditables (1 REFUTADO, 2 NO CONCLUYENTE), 3 solo agregados, 2 fixtures. Hallazgo transversal: en 3/3 auditables el win rate (68-85%) queda por debajo del breakeven. Informe: `docs/AUDITS_PROSPECT.md` | Agente | Hecho |
| 2.4 | **HECHO 2026-10-24.** README reescrito: posicionamiento (laboratorio + archivo), evidencia resumida, quick start, como funciona el kit, tabla de comandos, garantias de integridad y limites. Se elimino la tabla de rendimiento in-sample que contradecia el aviso de cabecera | Agente | Hecho: README coherente con el estado real |

## Fase 3 — Experimento nuevo (SOLO si el operador decide seguir tradeando)

Tesis candidata (la evidencia interna la favorece): baja frecuencia. "El contrafactual mostro
que mantener superaba a las salidas del motor: probar trend following diario + rebalanceo
mensual, no microestructura."

| # | Accion | Responsable | Verificacion |
|---|---|---|---|
| 3.1 | Pre-registrar la hipotesis: protocolo completo (periodo OOS, criterios de exito: expectancy > 0.02%/trade neta, Sharpe OOS > 1, 3/4 folds walk-forward positivos, regla de muerte) | Agente | `docs/PRE_REGISTERED_TREND_2026.md` |
| 3.2 | Backtest OOS con klines (reusar el harness existente), sin tocar el motor | Agente | Reporte con las mismas metricas robustas |
| 3.3 | Si pasa 3.2: implementacion paper con el stack actual (invariante, cadena, replay) | Agente | Motor paper de baja frecuencia corriendo |
| 3.4 | Veredicto a 191 cierres con la misma compuerta | Agente | Artefacto de validacion |
| 3.5 | Solo si 3.4 sale NO REFUTADO: capital real minimo (50-100 USD) con reglas de riesgo escritas y kill-switch | Operador | Checklist de readiness firmado |

## Fase 4 — Deuda tecnica y cierre de calidad

| # | Accion | Responsable | Plazo |
|---|---|---|---|
| 4.1 | Extraer el kernel puro de `exit-governance.ts` (ya sin ventana en curso: sin riesgo de cambiar el camino de decision vivo) | Agente | despues de Fase 1 |
| 4.2 | Correr `dex-fee-growth-audit` con la liquidez/ticks de la posicion real (cerrar la pregunta DEX con numero atribuible) | Agente | 1 sesion |
| 4.3 | Resolver `deploy-pool.ts` segun 0.2 (reparar o eliminar el watcher) | Agente | despues de 0.2 |
| 4.4 | Ficha del KB al estado final (proyecto cerrado como trader, abierto como lab) | Agente | despues de Fase 2 |

## Reglas de no hacer (vinculantes)

1. No reabrir la hipotesis del grid/microestructura sin una tesis NUEVA (no un parametro nuevo).
2. No mostrar en ningun dashboard metricas que no salgan de la equity auditada.
3. No capital real sin compuerta 3.5 firmada.
4. No tocar el codigo del trader durante la Fase 0 (congelado).
5. Cualquier deriva contable invalida la ventana y se reinicia (protocolo vigente).

## Metrica de exito del plan

- Fase 0: veredicto emitido con protocolo intacto, cero reparaciones, token rotado.
- Fase 2: un caso de estudio reproducible de auditoria + whitepaper.
- Fase 3 (opcional): una hipotesis nueva pre-registrada evaluada con las mismas compuertas.

## Fase 5 — Validación del repositorio (HECHO 2026-10-24)

- Typecheck del motor y de scripts: limpios. Suite: 288 tests / 0 fallos (OFFLINE=1: 280 + 8 skip).
- CI agregado (`.github/workflows/ci.yml`).
- Hallazgos corregidos: `ethers` faltaba en `package.json`; 6 scripts legacy movidos a
  `scripts/archive/legacy/`; 2 scripts con firma de Jev obsoleta; unión de estados del prospector.
- Informe: `docs/REPO_VALIDATION_2026-10-24.md`.
