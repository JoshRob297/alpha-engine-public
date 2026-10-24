# Validacion del Periodo Paper — Protocolo Pre-Registrado y Correcciones

**Proyecto:** Alpha Engine v1.0.0
**Fecha de apertura de la ventana:** 2026-10-16 (UTC)
**Proposito:** medir, sin auto-enganio, si el sistema tiene ventaja real. Este documento se
escribe ANTES de conocer el resultado de la ventana nueva, para que los criterios de
exito/fracaso no se puedan reinterpretar a posteriori.

---

## 1. Estado de partida (verificado con datos, no con documentacion)

La corrida previa (2026-09-24 a 2026-10-16, 21 dias en modo PAPER) dejo:

- **CEX:** 68 cierres, 58G/10P, win rate 85.29%, **PF 0.5458**, expectancy **-0.0175 USD/operacion**.
  Win rate requerido para no perder: **91.4%** (deficit 6.1 pp). t = **-1.19** → **sin significancia estadistica**.
- **DEX:** fees acumuladas 1.707 USD contra un APR asumido de 120-566%; el APR realizado fue
  **9-40% del modelado** y el gasto de gas registrado por el propio motor (2.64 USD) **superaba** las fees.
- **Cerebro:** 23 muestras de destilacion en 13 dias; la atribucion del gatillo de salida fue
  9 OFI / 9 Laya / 4 ambos / 1 otro.
- **Contabilidad:** cuatro valuaciones distintas del mismo portafolio (201.54 por formula,
  129.73 por componentes, 200 por targets, 0.09 de tesoreria real).

Conclusion previa: la corrida **ilustra** la refutacion (`docs/CONCLUSIONS.md`) pero **no la
prueba** por si sola (n insuficiente). Este protocolo cierra esa brecha.

---

## 2. Protocolo pre-registrado

### 2.1 Ventana y congelamiento

- `GENOME_FREEZE=true` durante toda la ventana: no hay re-evolucion JIT, ni recalibracion
  reactiva (SETS), ni evolucion en el onboarding de activos nuevos. Los activos nuevos entran
  con `DEFAULT_GENOME`.
- `MEASUREMENT_STARTED_AT` fija el inicio de la ventana out-of-sample; todo trade anterior
  queda fuera del computo OOS.
- **Ventana vigente: `2026-10-19T02:20:00Z`.** La ventana anterior (`2026-10-16T02:40:00Z`) fue
  invalidada el 2026-10-19 por deriva contable persistente (173.07 USD de reserva inexistente,
  ver seccion 6 u 8) y quedo archivada; el contador de cierres OOS arranca de cero.
- Motivo: la corrida previa re-calibro genomas el 2026-10-02 y el 2026-10-15, con datos que
  incluian el propio periodo de prueba. Eso la invalida como OOS.

### 2.2 Tamano de muestra objetivo

**191 cierres** (trades con PnL distinto de cero). Es el n que, con el efecto observado
(expectancy -0.0175 USD, sd 0.121 USD), permite rechazar `expectancy = 0` al 95%.
Al ritmo de 4.7 cierres/dia son **~41 dias**.

### 2.3 Criterios de decision (fijados de antemano)

| Desenlace | Condicion | Lectura |
|---|---|---|
| **REFUTADO** | t <= -2 con expectancy < 0 | Los genomas/mallas no tienen ventaja. Cerrar la linea de trading. |
| **NO REFUTADO** | t >= +2 con expectancy > 0 | Hay indicio de ventaja; exigir validacion walk-forward antes de cualquier capital real. |
| **INCONCLUYENTE** | -2 < t < 2 al llegar a 191 cierres | El sistema no demuestra ventaja; no justifica capital real (mismo efecto practico que refutado, con menos certeza). |

Regla adicional pre-registrada: si `win rate < breakeven WR` durante la ventana, el sistema es
estructuralmente deficitario con independencia de la significancia, porque la asimetria
(payoff 1:10.6) exige un win rate que no se alcanza.

### 2.4 Metricas que se reportan (todas, sin seleccion)

- Cierres, G/P, win rate, PF, avgWin%, avgLoss%, payoff ratio, breakeven WR y deficit en pp.
- Expectancy por operacion con t de Student e IC95%.
- PF total vs PF out-of-sample (post-congelamiento).
- Por activo: retorno del motor contra buy & hold del mismo capital desplegado.
- DEX: fees vs IL vs gas vs APR modelado, por slot.
- Contrafactual de cada salida (+1h/+4h/+24h): cuanto valor aporto salir frente a mantener.
- Atribucion del gatillo: OFI crudo vs Laya.
- Equity reconciliada vs formula legacy (deriva contable).

---

## 3. Correcciones aplicadas en esta iteracion

### 3.1 Aislamiento de la suite de tests (raiz de la contaminacion)

| Defecto | Evidencia | Correccion |
|---|---|---|
| Tests escribian en el log forense de produccion | `data/audit_logs/live_audit_2026-10-02.jsonl`: 3 registros `mode=LIVE` "Orden real colocada en Binance" y 2 fills `@ $100000` con `orderId: 1` (precio de mercado real: 84,332) | `src/telemetry/audit-logger.ts`: sin escritura a disco en entorno de test (el buffer en memoria se conserva para las aserciones). `src/telemetry/forensic-audit-logger.ts`: barrera dura que lanza si un test intenta escribir en `data/audit_logs` |
| Tests escribian en el almacen de genomas | `bestTesttoken` (dataset "600h Binance TESTUSDT", fitness 243, winRate 100) presente en el store de produccion | `src/genetic/jit-evolution.ts`: skip en test + rechazo de genomas degenerados + dataset/ticker de prueba, con cuarentena auditable (`data/evolved_atr_genomes_rejected.jsonl`) |
| Deteccion de entorno duplicada e inconsistente | `exit-governance.ts` tenia su propia copia | `src/guardrails/env-guard.ts`: unica fuente de verdad, criterio conservador (ante duda, asume produccion) |

### 3.2 Contabilidad

| Defecto | Causa raiz | Correccion |
|---|---|---|
| `effectivePortfolioUsd` no cuadraba con los componentes (±1.8 a 80 USD segun bucket) | Contaba dos veces las fees DEX (ya incluidas en `currentCapitalUsd` por `shadow-lp-simulator.ts`) y omitia el PnL realizado del CEX | Invariante nuevo: `equity = desplegado + reserva capturada + reserva no operada`, con la reserva no operada como RESIDUO derivado (`capital + PnL - desplegado - reserva capturada`). Asi la identidad se cumple por construccion; lo unico que puede romperse es su signo |
| NAV de cada bot CEX inflado | `realNavUsd = caja + ordenes en reposo + inventario`, pero las ordenes en reposo NO se debitan de la caja (`GridBot._fill` es quien debita): el mismo dinero se contaba dos veces (+8.56 USD acumulados) | `realNavUsd = caja + inventario`. Las ordenes en reposo se exponen aparte como `restingOrdersUsd` (informativas) |
| IL y gas del DEX invisibles | No se persistian en `dexSummary` ni se restauraban en `restoreState` | Se persisten y restauran `initialCapitalUsd`, `impermanentLossUsd`, `gasSpentUsd`; el estado expone `netPnlUsd` (fees - IL - gas) por slot |
| Capital acuñado en cada reinicio | Al restaurar, `bot.cash = capitalForThisBot - cost`: cada reinicio regalaba a cada bot el objetivo completo | La restauracion usa la caja persistida (`saved.cashUsd`) |
| La politica de regimen no movia dinero | El asignador fijaba `allocatedCashUsd` (etiqueta) pero nunca movia caja, asi que el desplegado excedia el presupuesto | Normalizacion de capital (CEX y DEX): retira el excedente a una reserva real (`unallocatedCashUsd`), financia deficits solo con caja existente (nunca acuña) y registra cada movimiento en el audit log (`CAPITAL_NORMALIZATION`) |
| Contadores de rebalanceo no cuadraban con el audit log (736 vs 2,653) | Los contadores por slot se resetean en rotaciones; no habia contador global | `dexRebalanceEventsTotal` acumulativo en el estado, incrementado en cada `REPOSITION_RANGE` |

Diagnostico permanente en el estado (`equity`): `deployedValueUsd`, `unallocatedCashUsd`,
`untradedReserveUsd`, `policyReserveTargetUsd`, `policyActiveTargetUsd`,
`underDeploymentVsPolicyUsd`, `phantomCapitalUsd`, `legacyFormulaUsd`, `driftUsd`,
`dexFeesUsd`, `dexImpermanentLossUsd`, `dexGasUsd`, `dexNetPnlUsd`, `cexRealizedNetUsd`.

Alertas forenses: `PHANTOM_CAPITAL` (CRITICAL, la reserva derivada se vuelve negativa) y
`POLICY_OVER_DEPLOY` (WARN, se despliega mas que el presupuesto). El sub-despliegue se registra
como INFO porque es estructural mientras no exista logica de mint/burn en el modelo.

### 3.3 Economia del tramo DEX

- Modelo de gas calibrado: unidades reales de un rebalanceo de liquidez concentrada
  (`decreaseLiquidity + collect + mint`) y suelo de precio de gas y de coste por transaccion.
  El modelo previo arrojaba ~0.0004 USD por rebalanceo, lo que hacia invisible el coste.

### 3.4 Instrumentacion

- `triggerSource` ("OFI" | "LAYA" | "BOTH" | "OTHER") en cada registro de salida: sin esto la
  contribucion de Laya no se puede atribuir.
- `scripts/paper-validation-report.ts`: reporte completo (secciones 2.4) con salida a
  `data/validation/paper_validation_<fecha>.json`, historico en `paper_validation_history.jsonl`
  y notificacion opcional a Telegram.
- `src/research/paper-validation.ts` + tests: la matematica del veredicto (breakeven WR, PF,
  t, contrafactuales, atribucion) esta cubierta por pruebas unitarias.
- Etiquetado de modo corregido: los logs ya no dicen "posicion DEX Real" cuando el motor
  opera en PAPER.
- Secreto eliminado: el token del bot de Telegram estaba hardcodeado en
  `src/telemetry/telegram-bot.ts`. Ahora se carga del entorno o de `$HOME/.env.secrets`, y si
  falta, el poller no arranca y lo reporta.

### 3.5 Limpieza de artefactos contaminados

Ejecutado con scripts reproducibles (dry-run por defecto):

```bash
bun run scripts/clean-genome-store.ts --apply           # aparta genomas de test/degenerados
bun run scripts/quarantine-stub-audit-events.ts --apply # mueve eventos sinteticos a quarantine/
```

- Genomas apartados: `bestTesttoken` (test) y `bestAero` (winRate 100%, PF en cap, risk/reward
  1:19.5 → breakeven WR 95.1%). AERO pasa a operar con `DEFAULT_GENOME` (tp 3.8%, stop 7.5%,
  breakeven WR 66.4%).
- Eventos forenses: 5 movidos a `data/audit_logs/quarantine/`; los archivos originales conservan
  un unico registro `WARN` documentando la extraccion. **No se borro evidencia.**

---

## 4. Limitaciones conocidas (declaradas, no corregidas en esta pasada)

1. **Conservacion de capital: invariante instrumentado y ahora auto-reparado (ver seccion 6 u 8).**
   La identidad `capital + PnL realizado = desplegado + reserva capturada + reserva no operada`
   se cumple por construccion (la reserva no operada es el residuo). El 2026-10-19 el invariante
   detecto y cuantifico un defecto real de **173.07 USD acuñados** sobre 200 de capital (ver seccion 6 u 8);
   se corrigio la causa (creacion de slots DEX sin debito, cierre sin credito, churn de regimen) y se
   añadio reparacion automatica con evento forense. Lo que sigue abierto:
   - el objetivo de reserva de la politica es **dependiente del regimen** (fiat 30-50%), de modo
     que `policyActiveTargetUsd` oscila (100 a 140 USD) y el "despliegue contra politica" se mueve
     con el mercado, no con un error; ahora con **histeresis** para que ese movimiento no genere churn
     de reasignacion;
   - el tramo DEX solo se financia con caja existente (`DEX_FUNDING SKIP` si no hay): el sub-despliegue
     queda declarado en vez de acuñarse.
2. **Sin libro unico con debito/credito por bucket:** se cerraron los caminos que rompian la
   conservacion (financiacion de slots y cierre contable) y hay reparacion + evento forense por
   movimiento anomalo, pero sigue sin existir un asiento contable por movimiento
   (falta el test de invariante como guardia de CI sobre el estado vivo).
3. **IL sin factor de concentracion (medido en la seccion 5):** `calculateImpermanentLoss` usa la
   formula de rango completo aunque recibe los limites del rango. Verificado: subestima el IL por
   **29-47x** con los rangos vivos. El valor correcto ya existe (`calculateConcentratedIlFraction`,
   con tests) pero la produccion no lo usa todavia para no romper la comparabilidad de la corrida.
4. **Base historica del DEX no recuperable:** los `initialCapitalUsd`/IL/gas previos al
   reinicio no existen en ningun artefacto (nunca se persistieron). La contabilidad DEX es
   auditable **desde el reinicio**, no hacia atras. Tras esta iteracion las posiciones quedaron
   re-basadas a ~$20 por slot.
5. **Rotaciones de pool cambian la base de capital:** cuando un slot rota, el capital se
   reasigna al pool nuevo. La comparabilidad entre slots es aproximada.
6. **Fee APR de los pools no validado on-chain:** el APR que alimenta el modelo (120-566%)
   proviene de la fuente de pools, y se realizo al 9-40%. Sigue siendo el parametro dominante.
7. **Muestra:** 21 dias no alcanzan para significancia; ver seccion 2.2.

---

## 5. Resultado de la verificacion de puntos abiertos (2026-10-16)

Ejecutable: `bun run scripts/verify-open-items.ts [--check-telegram-token]` (exit 1 si algo falla).
Resultado: **5/5 PASS** (2026-10-19; los 4 primeros puntos siguen verificados con estado vivo).

| Punto | Veredicto | Evidencia |
|---|---|---|
| **[1] IL de rango completo** | **CONFIRMADO** (subestimacion de 29x a 47x) | WETH-CBBTC: legacy 4.519e-4% vs correcto 1.805e-2% (**39.9x**); USDC-CBBTC: 5.799e-3% vs 1.707e-1% (**29.4x**); AERO-CBBTC: 1.347e-3% vs 6.269e-2% (**46.5x**). Impacto en USD aun marginal (~$0.036 acumulado) porque los precios se movieron poco, pero el error escala con el movimiento y con lo estrecho del rango |
| **[2] Normalizacion DEX sin acunar** | **CONFIRMADO** | Deficit sintetico (20 contra 60 con caja 0) -> 0 movimientos y `unfundedDeficitUsd = 40`. Estado vivo: reserva capturada $17.32, deficit no financiado vs politica $30.06 declarado, `phantomCapitalUsd = 0` |
| **[3] Reserva objetivo segun regimen** | **CONFIRMADO** | AGGRESSIVE fiat 30% -> reserva $60 / activo $140; BALANCED 40% -> $80 / $120; DEFENSIVE 50% -> $100 / $100. Oscilacion de **$40 sobre $200** (20% del capital) con el regimen vivo en AGGRESSIVE (reserva observada $60, coincide) |
| **[4] Higiene de secretos** | **CONFIRMADO** (con pendiente del operador) | 0 coincidencias de patron de token en `src/`, `scripts/` y `config/`; se encontro y corrigio un **segundo** token embebido (`src/telemetry/notifier.ts`, ademas del de `telegram-bot.ts`); test de guardia en `src/telemetry/secret-hygiene.test.ts`. **Pendiente:** el valor sigue en el historial de git del repo privado y el token responde `ACTIVO (bot @<bot>)` -> rotar en BotFather |
| **[5] Conservacion de capital** | **CONFIRMADO** (tras el incidente de la seccion 6) | Caja real (capital 200 + PnL -2.42 - desplegado 119.52) = $78.06 contra reserva capturada $77.62, residuo $0.44, exceso $0.00. La etiqueta ya no puede exceder la caja: se repara en cada tick y se registra `CAPITAL_REPAIR` |

Detalle tecnico de [1]: `calculateImpermanentLoss` recibe `lowerPrice`/`upperPrice` y los ignora;
su formula es el limite de rango completo. Se agrego `calculateConcentratedIlFraction` (v3 real:
cantidades por unidad de L, single-sided fuera del rango, valuadas a precio de mercado) y se verifico
por test que **converge** a la formula de rango completo cuando `lower -> 0` y `upper -> infinito`,
y que se amplifica al estrechar el rango. La produccion mantiene la formula legacy a proposito, para
no romper la comparabilidad de la corrida en curso.

## 6. Incidente de conservacion de capital (detectado 2026-10-19, corregido)

**Que paso.** El invariante de equity agregado en la iteracion anterior (2026-10-16) empezo a emitir
`CAPITAL_CONSERVATION / PHANTOM_CAPITAL` a las pocas horas de la ventana: la caja no desplegada
derivada era **negativa**. En 2.9 dias, la etiqueta de reserva capturada crecio de 17.32 a 262.94 USD
sobre un capital de 200: **173.07 USD de capital inexistente** (86.5% del capital) al momento de la
reparacion. Sin el invariante, los reportes habrian seguido mostrando un equity "reconciliado" de
197.58 con buckets imposibles.

**Causa raiz (cadena completa).**
1. El regimen macro derivado de los juicios Jev por activo **alternaba cada ~16 minutos** entre dos
   estados (`AGGRESSIVE_ACCUMULATION` y `DEFENSIVE_STRESS`), reescribiendo el objetivo de CEX/DEX en
   cada sincronizacion (cada 10 min) y cambiando `maxDexSlots` de 4 a 1.
2. Cada alternancia **creaba y podaba slots DEX**. La creacion instanciaba el slot con
   `dexTotalPoolUsd * share` **sin debito alguno** (capital acuñado).
3. La poda borraba el slot en silencio, **sin devolver su capital** (perdida no contabilizada).
4. La normalizacion posterior **convertia el capital acuñado en reserva capturada** (credito de
   reserva sin contrapartida): de ahi la deriva neta positiva.
   Evidencia: los `reserveDeltaUsd` de las normalizaciones DEX suman **+142.52** (10-16), **+103.67**
   (10-18) y **-27.41** (10-19); los de CEX apenas +17 netos.

**Correcciones aplicadas.**
- **Financiacion sin acuñar:** un slot nuevo se financia con caja de la reserva
  (`DEX_SLOT_FUNDED`, `DEX FUNDING SKIP` si no alcanza). Nunca se crea capital de la nada.
- **Cierre contable:** al podar un slot su capital vuelve a la reserva (`DEX_SLOT_CLOSED`), con lo que
  el ciclo crear/cerrar es neutro. Se elimino la "recuperacion de fees" del slot anterior, que con el
  cierre contable pasaba a ser doble conteo.
- **Histeresis de regimen** (`src/daemon/regime-hysteresis.ts`): el objetivo de capital solo cambia
  con **3 observaciones consecutivas** del mismo regimen y **20 minutos** de permanencia minima
  (persistida en el estado). Mata el churn que disparaba todo lo anterior.
- **Rate limit + banda muerta:** normalizacion de capital cada **>=15 min** con tolerancia del **10%**
  (antes 5%) en CEX y DEX.
- **Reparacion automatica con evidencia** (`src/daemon/capital-conservation.ts`): en cada tick se
  audita `capital + PnL realizado - desplegado` contra la etiqueta de reserva; si la excede, se repara
  a la caja real y se registra `CAPITAL_REPAIR` (CRITICAL) con el monto y el porcentaje del capital.
  La etiqueta es el residuo; la posicion marcada a mercado es la fuente de verdad.
- **Telemetria del defecto:** `conservationRepairs` se persiste en el estado y se expone en el payload.

**Estado tras la reparacion (2026-10-19T02:20Z).** `unallocatedCashUsd` 77.62 + `deployedValueUsd`
119.51 + residuo 0.45 = **197.58 = capital 200 + PnL realizado -2.42** (identidad exacta),
`phantomCapitalUsd 0`, `conservationRepairs 0` sin nuevas apariciones, histeresis anclada en
`BALANCED_RANGE`.

**Consecuencia sobre la medicion.** El protocolo de la seccion 2.3 invalida la ventana ante deriva
contable persistente: la ventana 2026-10-16T02:40Z queda **invalidada y archivada** y se reinicia en
**2026-10-19T02:20:00Z** (contador de cierres OOS desde cero). La deriva fue detectada por la propia
instrumentacion agregada en la iteracion anterior, que es exactamente su proposito.

**Defecto colateral encontrado en el pipeline de reporte.** Los tres reportes diarios
(10-16, 10-17, 10-18) contenian **el mismo estado** (equity identico): el `rsync` fallaba y el
`|| echo` lo enmascaraba, de modo que se reportaban cifras viejas como si fueran actuales. El wrapper
`/usr/local/bin/alpha-validation-report` ahora **aborta con alerta a Telegram** si el estado
sincronizado tiene mas de 15 minutos (mtime o `lastUpdated`) y avisa si el motor no persiste en 15 min.

---

## 7. Cierre de brechas de la lista de faltantes (2026-10-19)

Todo lo implementado, con el comando que lo verifica. `bun test` cubre 251 casos en 47 archivos.

### Metodo y estadistica

| Brecha | Implementacion | Verificacion |
|---|---|---|
| Independencia de los trades y perfil no normal | `src/research/statistics.ts`: bootstrap circular por bloques, test binomial exacto (log-gamma), autocorrelacion lag-1, n efectivo, perfil de riesgo y regla de parada | 20 tests. En vivo: lag-1 **0.223** -> n efectivo **28 de 44**; binomial p=**0.0135** (rechaza WR >= breakeven); t-test marcado como inapropiado (payoff 1:10.3, 3 peores trades = 52.3% de la perdida) |
| El veredicto usaba el t de Student | El reporte agrega la seccion `INFERENCIA ROBUSTA` y el veredicto textual sale de la regla de parada (bootstrap + binomial) | `bun run validate:paper` |
| Walk-forward | `scripts/walk-forward-stability.ts`: folds temporales con media y desviacion entre folds | En vivo: 4 folds, expectancy -0.0096 / -0.0421 / +0.0079 / -0.0259 -> **INESTABLE, 1/4 folds positivos** |
| Criterio de parada automatico | `evaluateStopRule`: CONTINUE / STOP_RECOMMENDED / REFUTED, con razones, en el reporte y en Telegram | 4 tests |
| Universo no congelado en la ventana | `src/guardrails/measurement-universe.ts` + `data/measurement_universe.json` (fijado: AERO/BTC/SOL y AERO-CBBTC/USDC-CBBTC/WETH-CBBTC). Con la ventana activa solo se opera eso; lo bloqueado se registra una vez y una admision marcaria la muestra como no pre-especificada | 8 tests; `bun run universe:init` |
| Muestra insuficiente sin ETA | El reporte publica ritmo y fecha estimada al objetivo | `bun run validate:paper` |

### Realismo de ejecucion

| Brecha | Implementacion | Verificacion |
|---|---|---|
| Fills PAPER sin cola ni slippage | `src/daemon/paper-execution.ts` (fill parcial de maker segun cola, reclasificacion a TAKER si el post-only cruza, impacto adverso por profundidad, fees maker/taker, fill parcial por profundidad) cableado en el llenado de mallas; `bookDepthUsd` calcula la profundidad de los 5 mejores niveles | 22 tests del modulo; los cierres PAPER ya escriben `liquidity`, `slippageUsd` y `feePaidUsd` |
| Fee APR DEX sin validar on-chain | `src/dex/fee-growth.ts` (matematica v3 real: wrap 2^256, feeGrowthInside con los 4 casos, delta/2^128, ticks) + `scripts/dex-fee-growth-audit.ts` con `eth_call` a mano (selectores de `slot0`, `feeGrowthGlobal`, `liquidity`, `ticks`) | 26 tests; el script **respondio contra Base mainnet** y falla con exit 4 si el RPC no responde (sin inventar numeros) |
| IL de rango completo en produccion | `DEX_IL_MODEL` (default `concentrated`): el motor usa el IL concentrado y **persiste ambos** valores para comparabilidad | En vivo: IL activo **0.0158** vs rango completo **0.0005** (31.6x) |
| Futuros sin evidencia | El funding ya se modelaba: ahora se expone en el reporte junto con la advertencia de que la pata corta es sombra | `bun run validate:paper` |
| Escalabilidad no medida | `src/research/pnl-reconstruction.ts` + `scripts/capital-scaling-analysis.ts`: curva de expectancy por tamano de cuenta y breakeven | En vivo: edge bruto por nocional **-0.00275** -> breakeven **0** (ninguna cuenta es rentable con estos supuestos, porque el edge ya es negativo antes del impacto) |

### Integridad y auditoria

| Brecha | Implementacion | Verificacion |
|---|---|---|
| Falta de partida doble / propiedad | `src/daemon/capital-conservation.property.test.ts`: 200 secuencias de 20 operaciones aleatorias (PRNG sembrado) con las funciones reales de normalizacion; verifica conservacion exacta tras CADA operacion y control negativo que reproduce la clase de defecto del incidente | 13.015 asserts. **Hallazgo**: el invariante agregado es ciego cuando hay holgura no etiquetada -> se agrego `auditReserveSlack` y la alerta `UNALLOCATED_SLACK` |
| Sin recomputacion independiente del PnL | `src/research/pnl-reconstruction.ts` + `scripts/independent-pnl-audit.ts` (CEX por componentes + coherencia por slot DEX, con exit 1 si no cuadra) | En vivo: desvio CEX **$0.077**, 3 de 3 slots DEX coherentes (delta <= $0.0001) |
| Audit log mutable | Cadena de hashes en el logger forense (`src/telemetry/audit-chain.ts`: canonicalizacion estable, sha256 encadenado, continuidad por archivo) + `scripts/verify-audit-chain.ts` | En vivo: 39 registros, **2 verificados, 37 pre-cadena, integro**; alterar una linea reporta el indice exacto |
| Deriva solo visible en eventos | Serie horaria del equity (`src/daemon/metrics-series.ts`, muestreo en el motor) + `scripts/equity-drift-monitor.ts` que calcula la **pendiente** del residuo de conservacion y alerta | 7 tests; en vivo la serie ya se escribe (`data/metrics/equity_series.jsonl`) |
| Reporte con punto unico de fallo | `/usr/local/bin/alpha-validation-deadman` + timer diario 22:00 CST: alerta si no hay artefacto/historial fresco o si la serie de equity marca deriva | Ejecutado: `[DEAD-MAN] OK` |
| Invalidacion de ventana manual | El motor persiste `measurement.windowValid` e `invalidations` (CAPITAL_REPAIR, UNIVERSE_EXPANSION); el reporte lo publica en el texto, el JSON y Telegram | En vivo: `valid: true`, 0 invalidaciones |

### Reproducibilidad

| Brecha | Implementacion | Verificacion |
|---|---|---|
| Sin inputs grabados | `src/guardrails/input-recorder.ts`: un JSONL por dia UTC con el pulso completo (libro, OFI, toxicidad, regimen, juicio de Laya, decision y contexto de posicion) | Grabando en vivo (`data/replay/2026-10-19.jsonl`); 9 tests |
| Sin replay | `scripts/replay-decisions.ts`: re-evalua la decision con el kernel y reporta el % de acuerdo, con **guard de deriva** contra el fuente de `exit-governance.ts` | Probado end-to-end: 85.7% de acuerdo, divergencia identificada y `KERNEL DRIFT DETECTADO` si cambian las condiciones |
| Cierres irreconstruibles | `src/telemetry/trade-context.ts` + provider en el ledger: cada cierre lleva version del motor, modelo de IL, regimen aplicado y del activo, confianza Jev, spread, OFI, toxicidad, huella del genoma y fraccion ya tomada | Inspeccionable en `state.history[].context` |

**Limitacion declarada y pendiente:** `src/guardrails/exit-governance.ts` no expone un kernel **puro**
(la decision vive dentro de una funcion `async` que consulta Laya por HTTP y escribe el dataset de
destilacion). El replay congela el juicio grabado y replica el arbol con guard de deriva, pero el fix
definitivo es extraer el kernel puro y que el motor llame a ESA funcion. No se hizo en esta pasada
porque toca el camino de decision en vivo durante la ventana de medicion: se hara al reiniciar ventana.

---

## 8. Segunda deriva contable y regimen de asignacion lento (2026-10-24)

**Que paso.** Entre el 19 y el 24 de octubre el regimen macro persistia solo 5-9 horas y cada
cambio movia el objetivo de capital ~40 USD (fiat 30-50%), forzando al normalizador y al ciclo de
slots DEX a mover caja real en ambos sentidos cada pocas horas. El 2026-10-22T09:07Z el invariante
detecto **otro exceso: etiqueta 41.98 contra caja real 31.70 (10.28 USD, 5.1% del capital)**. La
instrumentacion funciono como fue diseñada: reparo, emitio `WINDOW_INVALIDATION` (CRITICAL) y el
reporte diario del 24-10 salio con `windowValid=false`. Evidencia del churn: la serie horaria de
equity muestra oscilaciones de reserva de ±20-65 USD cada pocas horas con el total conservado
(la identidad se mantenia: el problema eran las asimetrias acumuladas del ciclo de slots).

**Causa raiz.** La histeresis anterior (3 observaciones + 20 min) no alcanzaba: el regimen
persistia lo suficiente para pasar el umbral, se aplicaba el cambio, y a las pocas horas se
revertia. Los movimientos eran conservacion-correctos pero no perfectamente neutros: el cierre de
un slot acredita su `currentCapitalUsd` (fees incluidas) y la creacion debita el disponible;
el residuo neto por ciclo se acumulaba en la etiqueta.

**Correccion.**
- **Regimen de asignacion lento** (`decideAllocationRegime`): el objetivo de capital (reserva /
  CEX / DEX, `maxDexSlots` y pesos) solo cambia si el regimen observado se mantiene IGUAL durante
  **12 horas continuas**. El regimen tactico (TP, stops, salidas) sigue usando el juicio por
  activo en cada pulso: solo se enfrio la reasignacion de capital.
- **Metrica de churn**: `capitalMovedTotalUsd` (suma de valores absolutos movidos entre buckets)
  persiste en el estado para medir el sloshing en el reporte.
- El monitor de deriva solo marca las reparaciones ocurridas DENTRO de la ventana analizada.

**Ventana.** Segunda invalidacion por protocolo (seccion 2.3): la ventana 2026-10-19T02:20Z queda
archivada y se reinicia en **2026-10-24T17:49:08Z**. Con el ritmo observado (15-23 cierres/dia),
el objetivo de 191 se alcanza en ~8-12 dias.

**Refinamiento propuesto del protocolo (registrado, no aplicado en esta pasada).** La deriva
afectaba las etiquetas de bucket, no los cierres: el `pnlNet` por trade sale de aritmetica de
precios y quedo verificado por la auditoria independiente y la cadena de hashes. Regla futura
propuesta: distinguir "integridad de la muestra de cierres" (auditada por `independent-pnl-audit`
+ `verify-audit-chain`) de "integridad de equity"; solo la segunda obliga a reiniciar si la
primera esta intacta. Se mantuvo la regla conservadora (reiniciar) para no aflojar el criterio
a mitad de camino.

**Numeros de la revision (ventana 19-24, archivada).**
- OOS n=136 (111W/25L) WR 81.62% PF 0.4677 expectancy -0.0157/trade t=-1.8.
- Bootstrap por bloques IC95% [-0.0389, +0.0020] (cruza cero); **binomial vs breakeven p=0.0011
  (rechaza)**; lag-1 0.199 -> n efectivo 90.9 de 136.
- Muestra total (25 dias): n=204, t=-2.151 (significativo por t, pero la muestra OOS es la
  pre-registrada).
- IL concentrado en produccion: activo 0.1411 vs rango completo 0.005.
- DEX: fees 0.98, IL 0.14, gas 1.11 -> neto -0.27 (gas/fees 1.13x: el gas domina las fees).
- Cadena de hashes: 26/26 archivos integros. PnL independiente: desvio CEX 0.0268, slots coherentes.
- Universo congelado operando: 12 pools bloqueados en 5 dias (XDP-USDC, USDC-MSTRC, WETH-AERO,
  WETH-VVV, USDC-METAC, USDC-VVV, WETH-USDC, ...) que antes habrian entrado y rotado la boveda.

---

## 9. Auditoria on-chain de fees DEX (2026-10-24)

Objetivo: cerrar la pregunta de la linea DEX con un numero atribuible, no con el APR publicado.
Metodo: `scripts/dex-slot-audit-inputs.ts` (puente estado -> on-chain: lee el pool real por RPC,
verifica el precio contra el entry del slot y deriva ticks y liquidez L) + `scripts/dex-fee-growth-audit.ts`
(feeGrowthInside con los 4 casos de v3, ponderado por L, ventana de 43.200 bloques ~24 h en Base).

Pools auditados (identificados por par + fee tier y verificados por precio on-chain contra el entry del slot):

| Slot | Pool | Rango (ticks) | Capital | Fees 24 h realizadas | Modeladas | Realizado/Modelado |
|---|---|---|---|---|---|---|
| WETH-CBBTC | `0x7c74...efa9` (0,009%) | [-266231, -265084] (±5,7%) | $34,78 | **$0,0267** | $0,0323 (33,91% APR) | **82,7%** |
| USDC-CBBTC | `0x3e66...a9fb` (1%) | [-67911, -65993] (±9,6%) | $14,11 | **$0,0078** | $0,0743 (192,14% APR) | **10,6%** |

**Hallazgos:**

1. **El APR publicado no es confiable como criterio de seleccion.** El pool de 192% APR (fee tier 1%)
   realizo solo el 10,6% de lo modelado en 24 h. El pool de 34% APR (fee tier 0,009%) realizo el 82,7%.
   El motor elegia por APR mas alto: estaba seleccionando sistematicamente el pool donde el APR no se
   materializa. La regla de seleccion debe ser estabilidad de feeGrowth/volumen, no APR publicado.
2. **La linea DEX no esta refutada por las fees: esta refutada por la escala.** Con feeGrowth real, el
   pool correcto paga ~28% anualizado; pero el gas acumulado es **119% de las fees** en WETH-CBBTC
   ($1,1436 vs $0,9581) y **507%** en USDC-CBBTC ($0,1552 vs $0,0306). Neto DEX del periodo: **-0,31 USD**
   sobre ~$49 de capital. Punto de equilibrio por slot: **~$250-300** (WETH) y **~$50** (USDC) solo para
   cubrir gas antes de IL, con el ritmo de re-centrado observado.
3. **El costo lo manda la frecuencia de re-centrado**, no el gas unitario ($0,00137 por re-centrado):
   hubo dias con 201-248 `REPOSITION_RANGE` (hasta ~8/hora) y dias con 6. Con un rango de ±5,7% eso es
   demasiado re-centrado para el capital. Regla propuesta si se revisita: re-centrar solo fuera de rango
   por un margen (p. ej. 2%) o tras N horas, y exigir capital minimo por slot.
4. **La economia DEX queda cuantificada, no especulada:** a $200 con 2-3 slots, cada slot esta por debajo
   del punto de equilibrio de gas; con ~$300-500 por slot y un pool de fee tier bajo/estable, la linea
   podria ser autosostenible a ~20-28% anualizado *antes de IL*, que sigue siendo el riesgo abierto.

**Lo que esto NO cambia:** el veredicto de la linea CEX (expectancy negativa) y la conclusion de que
ninguna linea demuestra hoy un edge. Lo que cambia es la precision del diagnostico DEX: de "APR no
validado" a "APR validado en un pool, mal pool elegido, y escala insuficiente para cubrir gas".

---

## 10. Nota de metodo: el veredicto se emite sobre PnL NETO

Desde el 2026-10-24 el reporte resta `feePaidUsd` y `slippageUsd` de cada cierre antes de calcular
la estadistica. Motivo: el `pnlNet` del ledger es **bruto** (verificado por `audit:pnl`); calcular el
veredicto sobre el bruto sobrestimaba el resultado (en la corrida real: -3.32 bruto vs -4.66 neto
sobre la muestra completa). Lo detecto el caso deceptivo del demo del kit (control negativo).
Los numeros archivados de ventanas anteriores no se reescriben: se citan como brutos.

---

## 11. Como se lee el resultado

```bash
bun run scripts/paper-validation-report.ts             # consola + JSON
bun run scripts/paper-validation-report.ts --notify    # ademas envia resumen a Telegram
bun run scripts/verify-open-items.ts                   # verificacion de puntos abiertos (exit 1 si falla)
```

Senales de alarma que invalidan la ventana (si aparecen, hay que reiniciarla):

- `genomas congelados=false` en el encabezado del reporte.
- Deriva contable (`equity.driftPct`) distinta de 0 de forma persistente.
- **`CAPITAL_REPAIR` en el audit log** (nuevo, 2026-10-19): la etiqueta de reserva excedio la caja
  real y el motor la corrigio. Una reparacion posterior al inicio de la ventana indica que el
  circuito contable volvio a abrirse: investigar el monto y reiniciar la ventana.
- **Reporte diario con estado obsoleto:** el wrapper aborta y avisa; si el reporte se emite, el
  estado tiene menos de 15 minutos.
- Entradas en el audit log con `mode=LIVE` cuando la tesoreria real esta en cero.
- `data/evolved_atr_genomes.json` con `updatedAt` posterior al inicio de la ventana.
