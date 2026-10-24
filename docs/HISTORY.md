# Historia del proyecto: qué quisimos, qué construimos y cómo lo refutamos

Este documento es la entrada canónica para entender el repositorio de punta a punta. No es
marketing: es el registro de una tesis, su implementación, la evidencia que la contradijo y el
instrumento que quedó de todo eso.

---

## 1. Qué queríamos (22 de septiembre de 2026)

Construir un sistema autónomo multi-activo que operara tres frentes con un mismo "cerebro causal":

| Línea | Idea |
|---|---|
| **CEX Spot** | Mallas adaptativas sobre BTC/SOL/AERO con genomas evolucionados (spacing, TP y stop ajustados por ATR) |
| **DEX** | Liquidez concentrada en Aerodrome Slipstream (Base L2), rangos causales, re-centrado dinámico |
| **Futuros** | Cobertura delta-neutral con cosecha de funding |
| **Cerebro** | `Jev` (régimen macro, terceros) + `Laya` (microestructura local, <1 ms) decidiendo asignación y salidas |
| **FX** | Una línea MXN/USD que se descartó antes de la validación |

La promesa del proyecto, tal como se documentó entonces: **"cero parámetros hardcodeados, cero
suposiciones de liquidez, deducción real de todas las fricciones"**, con una proyección de
**+57% a +65% anual, Sharpe 4.22, max drawdown 1.85% y 99.44% de preservación de capital**.

Lo que no estaba escrito en esa promesa: esas cifras venían de **backtests in-sample optimizados
sobre el mismo período que se reportaba**.

## 2. Qué construimos

Entre el 22 de septiembre y el 24 de octubre: **310 archivos, ~42.700 líneas de TypeScript**,
47 archivos de test, 272 commits.

| Subsistema | Qué incluye |
|---|---|
| Motor | Orquestador multi-activo, motor CEX (grid + salidas), motor DEX (LP concentrada), motor de futuros, asignador de capital por régimen |
| Cerebro | Clientes de Jev y Laya, analizador de OFI, gobernanza de salidas, política de régimen |
| Datos | Feeds de Binance (spot, futuros, histórico), DeFiLlama, libros L2, destilación de Laya |
| Riesgo | Guardrails, kill-switch, límites de exposición, circuit breakers |
| Observabilidad | Audit log forense, telemetría, dashboard HTTP, bot de Telegram, reporte diario de validación |
| Laboratorio | Validación OOS, validación por régimen, economía DEX, poder predictivo, Monte Carlo, contabilidad con invariante |
| Kit de auditoría | Modelo canónico, adaptadores, inferencia robusta, walk-forward, escalado, fee growth on-chain, CLI `alpha-audit` |

## 3. Qué dijeron los primeros análisis

Los análisis iniciales fueron **entusiastas y estaban equivocados**:

| Fase | Resultado reportado | Qué lo produjo |
|---|---|---|
| Backtests iniciales | +57% a +65% anual, Sharpe 4.22, DD 1.85% | Backtests in-sample con genomas optimizados sobre el mismo período |
| Evolución genética | Win rate 100% en varias estrategias | Sobreajuste: los genomas memorizaban el tramo evaluado |
| Optimización de parámetros | "SETS" mejoraba el retorno | Selección entre variantes sobre los mismos datos |
| Economía DEX | APR 68-150% | Fee APR publicado por una fuente externa, sin validar contra el contrato |

El primer análisis honesto llegó el **2 de octubre**: un split in-sample / out-of-sample (70/30,
selección de genoma solo en IS, evaluación solo en OOS) mostró que **todos los genomas candidatos
perdían ya en in-sample** (entre -20% y -35%) y que en OOS el sistema quedaba muy por debajo de
simplemente mantener:

| Activo | Estrategia (OOS) | Buy & Hold |
|---|---|---|
| BTC | +3.66% | **+35.50%** |
| SOL | -2.10% | **+80.89%** |

Y el "cerebro" no aportó: Laya y Jev no superaron al OFI crudo en poder predictivo (AUC cercano a
0.5 a los horizontes operados).

## 4. Cómo lo desmentimos

La refutación no fue una opinión: fue una secuencia de instrumentos, cada uno más exigente que el
anterior. Todos quedaron en el repositorio.

| Fecha | Instrumento | Hallazgo |
|---|---|---|
| 02-oct | Validación OOS (split, benchmarks, robustez, Monte Carlo) | CEX refutado; elegimos genomas entre perdedores |
| 02-oct | Test de poder predictivo (IC/AUC vs OFI) | Laya/Jev no agregan; el OFI crudo predice igual o mejor |
| 02-oct | Economía DEX (IL real, fees, gas, vs Hold) | Sin moat; el resultado depende de un APR no validado |
| 15-oct | Auditoría contable del Paper | El "+0.77%" era un artefacto (fees doblemente contadas, NAV inflado); real: **-1.47 USD** |
| 16-oct | Invariante de conservación | **173.07 USD de capital acuñado** en 2.9 días (86.5% del capital): creación de slots DEX sin débito + poda sin crédito + churn de régimen |
| 19-oct | Inferencia robusta (bootstrap por bloques, binomial exacto) | La muestra es bimodal y autocorrelacionada: el t-test no sirve; la binomial ya rechaza el breakeven con la mitad de la muestra |
| 19-oct | Walk-forward y escalado | 1/4 folds positivos; el edge bruto por nocional es negativo → breakeven de capital **0** |
| 22-oct | Segunda auditoría | Otra fuga de 10.28 USD por el régimen moviendo el objetivo cada 5-9 h → régimen de asignación con 12 h de persistencia |
| 24-oct | Auditoría on-chain de fees DEX | El pool de 192% APR realizó **10.6%**; el de 34% realizó **82.7%**; el gas es 119-507% de las fees |

### El número final (corrida Paper, 24 sep – 24 oct)

| Métrica | Valor |
|---|---|
| Cierres | 204 (169W/35L) |
| Win rate | 82.84% |
| Profit factor | **0.4985** |
| Expectancy neta | **-0.0163 USD/trade** (t = -2.151) |
| Payoff | 1:9.5 (gana +0.61%, pierde -3.4%) |
| Win rate de breakeven | **90.47%** (déficit 8.85 pp) |
| Muestra OOS | n=136, bootstrap IC95% [-0.039, +0.002], **binomial p=0.0011** |
| Walk-forward | 1/4 folds positivos |
| Edge bruto por nocional | negativo → breakeven de capital **0** |

El diagnóstico estructural: cortar ganadores en +0.6% y dejar correr pérdidas a -3.4% exige un
win rate de 90.5% para no perder; el sistema entrega 82%. Ningún ajuste de parámetros cambia esa
aritmética. El contrafactual lo confirmó: **mantener la posición superaba a las salidas del motor**
en casi todas las categorías, incluidas las de emergencia.

## 5. Los casos ya validados (terceros, datos públicos)

El laboratorio quedó como kit (`alpha-audit`) y se aplicó a backtests públicos. Informes:
`docs/AUDITS_2026-10.md` y `docs/AUDITS_PROSPECT.md`.

| Fuente | n | Neto | PF | WR vs breakeven | Bootstrap IC95% | p binomial | Folds | Veredicto |
|---|---:|---:|---:|---|---:|---:|---|---|
| `pumanitro/tral` (backtest público) | 584 | -49.2% | 0.73 | 85.45% vs 88.92% | [-1.63, -0.10] | 0.0058 | 0/4 | **REFUTADO** |
| `pumanitro/tral` (otra ventana) | 643 | -48.6% | 0.78 | 82.74% vs 86% | [-1.40, +0.06] | 0.0115 | 1/4 | NO CONCLUYENTE |
| `CharlesLehnen/...` SimpleVisualRSI | 32 | +0.1% | 1.03 | 68.75% vs 68.2% | [-0.97, +1.03] | 0.59 | 2/4 | NO CONCLUYENTE |
| `Mastaaa1987/freqtrade-strategie` | — | +32.896% publicado | 1.64 | — | — | — | — | **NO AUDITABLE** (solo `.txt`) |

Lote de prospección (8 datasets): **3 auditables, 3 solo agregados, 2 fixtures**. Hallazgo
transversal: **3/3 auditables tienen win rate 68-85% y breakeven por encima del observado** — el
mismo patrón que el motor propio. Y el dato de costos: en el único caso con bruto positivo, las
fees se comieron **95.8%** del bruto.

## 6. Conclusión

**No hay edge.** Ni en el motor propio ni en los casos auditados. La causa es estructural: sin
ventaja de datos, sin ventaja de ejecución y con costos que superan cualquier margen, el win rate
alto es la parte visible de una expectancy negativa.

Lo que sí quedó es el **laboratorio**: un protocolo pre-registrado (ventana OOS congelada, universo
congelado, regla de parada), inferencia sin supuesto de normalidad, invariante de conservación con
reparación auditada, cadena de hashes, auditoría independiente de PnL, replay determinista,
auditoría on-chain de fees y un kit para auditar estrategias ajenas con la misma exigencia.

**Un laboratorio que refuta su propio motor es más creíble que mil dashboards en verde.** Ese es
el producto.

## 7. Cómo verificar todo esto

```bash
bun install --frozen-lockfile
bun run typecheck && bun run typecheck:scripts
bun test                     # 288 tests
OFFLINE=1 bun test           # hermético (lo que corre CI)
bun run audit:demo           # 3 casos: deceptiva REFUTADA, sana NO REFUTADA, MT4 NO CONCLUYENTE
bun run verify:chain --all   # integridad del audit log
bun run verify:open-items --state <engine_state.json>
alpha-audit --file <trades.json> --adapter generic --mapping <mapping.json>
```

Detalle por etapa: `docs/CONCLUSIONS.md` (cierre del 2-oct), `docs/LIVE_PAPER_VALIDATION_2026-10.md`
(protocolo y resultados en vivo), `docs/VALIDATION_LAB_WHITEPAPER.md` (caso de estudio),
`docs/AUDIT_SERVICE_SPEC.md` (el servicio), `docs/REPO_VALIDATION_2026-10-24.md` (estado del repo).

## 8. Línea de tiempo

| Fecha | Hito |
|---|---|
| 22-sep-2026 | Primer commit: motor multi-activo |
| 27-sep | Primera corrida Paper con capital simulado (200 USD) |
| 02-oct | **Cierre de la hipótesis**: validación OOS, regímenes, DEX, Laya/Jev |
| 11-oct | Auditoría de preparación para vivo: sin edge → no se pasa a capital real |
| 15-oct | Protocolo de validación Paper pre-registrado; auditoría contable |
| 16-oct | Incidente de 173.07 USD; invariante + reparación; ventana reiniciada |
| 19-oct | Inferencia robusta, walk-forward, escalado; segundo incidente (10.28) |
| 22-oct | Régimen de asignación lento (12 h) |
| 24-oct | Auditoría on-chain de fees; kit de auditoría, CLI, adaptadores, CI; ventana OOS vigente |
