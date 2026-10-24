# Spec del servicio de auditoria de estrategias

**Alpha Validation Lab — Documento 2 — 2026-10-24**

## 1. Que es

Una auditoria independiente de una estrategia o bot de trading: se toma su historial de
operaciones y su estado, se reconstruye el PnL **neto de costes**, se aplica inferencia robusta
(sin supuesto de normalidad) y se emite un **veredicto clasificado con evidencia reproducible**.
No es asesoramiento financiero ni una promesa de retorno: es un dictamen sobre si la evidencia
sostiene que la estrategia tiene ventaja, con que confianza y bajo que supuestos.

La credibilidad del servicio viene del caso 0: **el laboratorio refuto su propio motor** y documento
los defectos que encontro (ver `VALIDATION_LAB_WHITEPAPER.md`).

## 2. Por que no existe una herramienta universal (y que se hace en su lugar)

Cada bot define distinto que es un trade, si el PnL es bruto o neto, si las fees estan dentro del
precio, si reporta posiciones o cierres y en que zona horaria. Un formato universal es imposible;
lo que si es posible es un **contrato canonico + adaptadores + compuerta de suficiencia**:

| Pieza | Rol |
|---|---|
| `src/audit/canonical.ts` | Modelo `CanonicalTrade` (`ts, venue, symbol, qty, entry, exit, fees, slippage`) y **derivacion** del PnL neto a partir de los ingredientes |
| `src/audit/adapters/alpha-engine.ts` | Formato del motor propio (primera parte) |
| `src/audit/adapters/generic.ts` | JSON / JSONL / CSV con **mapeo declarado** de columnas, convencion de signo de costes y `pnlKind` (bruto vs neto) |
| `assessDataQuality` | SUFFICIENT / PARTIAL / INSUFFICIENT con motivos. Si es INSUFFICIENT no se emite veredicto |

Reglas duras:

1. **El PnL declarado no es la verdad.** Se deriva de precios, cantidades y costes; si el cliente
   declara un neto y hay ingredientes, se compara y una discrepancia se registra como bandera roja.
2. **No se inventan costes.** Sin fees declaradas, el trade queda `mixed` y la calidad baja: el kit
   puede decir "el bruto es positivo" pero no afirmar el neto.
3. **Lo no auditable se dice.** Un bot que solo exporta una curva de equity no es auditable con este
   kit (seria otro producto, mas debil: forense de curva). Se rechaza, no se simula.

## 3. Ingesta (que entrega el cliente)

Minimo viable:

| Archivo | Formato | Obligatorio |
|---|---|---|
| Historial de operaciones cerradas | JSON o JSONL; un registro por cierre con `timestamp`, `venue`, `assetOrPool`, `action`, `price`, `amount`, `pnlNet`, `pnlPct`, `feePaidUsd`, `slippageUsd` | Si |
| Declaracion de costes | fees maker/taker y slippage asumido si no vienen por trade | Si |
| Estado de cuenta / equity | JSON con capital inicial, equity actual y desglose por componente | Recomendado |
| Logs de decisiones | opcional (permite replay y auditoria de gatillos) | Opcional |
| Mapeo de columnas | obligatorio si el formato no es el del motor (`--mapping mapping.json`) | Solo para formatos de terceros |

Se acepta tambien el estado persistido del motor (`engine_state.json`) tal cual. Si faltan campos
de costes, la auditoria se emite como **NO CONCLUYENTE por datos insuficientes** (no se rellena
con supuestos silenciosos).

Reglas de ingesta: se calcula el hash SHA-256 de cada archivo recibido y se registra en el informe;
cualquier modificacion posterior invalida el dictamen.

## 4. Uso del CLI

```bash
# Motor propio
alpha-audit --file engine_state.json

# Export de terceros con mapeo declarado
alpha-audit --file export.csv --adapter generic --mapping mapping.json --capital 1000

# Mapeo inline + ventana OOS + JSON
alpha-audit --file trades.jsonl --adapter generic \
  --mapping '{"ts":"t","symbol":"s","pnlNet":"profit","pnlKind":"gross","fees":"commission","extraCosts":["swap"],"costSign":"negative"}' \
  --oos-start 2026-10-24T17:49:08Z --json
```

Mapeo (ejemplo MT4): `docs/audit-mapping.example.json`.
Convenciones: `pnlKind` (`gross`|`net`|`unknown`) es obligatorio declararlo; si no, el dataset
queda NO AUDITABLE. `costSign: "negative"` normaliza brokers que reportan costes con signo.
El delimitador CSV se autodetecta (`;`, `,`, tab, `|`).

Codigos de salida: `0` auditoria emitida | `3` datos insuficientes (NO AUDITABLE) | `1` error.
Cada corrida escribe `data/audit_reports/audit_<label>_<timestamp>.json` con el hash del archivo
de entrada, la calidad de datos, el veredicto y las limitaciones.

## 5. Proceso

1. **Reconstruccion independiente del PnL**: bruto por trade, menos fees y slippage, mas coherencia
   del tramo DEX (fees - IL - gas vs capital). Desvio tolerado: 0.05% del nocional total.
2. **Clasificacion de la muestra**: completa vs out-of-sample (si hay ventana declarada); rechazo de
   trades sin costes y de ventanas con deriva contable (si hay equity).
3. **Inferencia robusta**: bootstrap circular por bloques del promedio (preserva autocorrelacion),
   test binomial exacto del win rate contra el breakeven, autocorrelacion lag-1 y n efectivo,
   perfil de riesgo (payoff, concentracion de perdidas). El t de Student se reporta solo como referencia.
4. **Estabilidad**: walk-forward por folds temporales (misma direccion del signo en todos los tramos).
5. **Escala**: curva de expectancy por tamaño de cuenta con impacto y fees; breakeven de capital.
6. **DEX (si aplica)**: auditoria de `feeGrowthInside` on-chain contra el APR modelado.
7. **Veredicto** con la regla pre-registrada: REFUTADO / PARADA RECOMENDADA / NO CONCLUYENTE / NO REFUTADO.

Comandos del kit: `verify:open-items`, `audit:pnl`, `audit:dex-inputs`, `audit:dex-fees`,
`audit:scaling`, `walk-forward`, `replay:decisions`, `verify:chain`, `monitor:equity`, `validate:paper`.

## 6. Contrato de salida

Informe con:

- **Veredicto** y su justificacion (la regla aplicada, no una opinion).
- **Metricas**: n, win rate, breakeven WR, deficit en pp, payoff, profit factor, expectancy neta,
  IC95% bootstrap, p binomial, n efectivo, folds positivos, breakeven de capital.
- **Evidencia cruda**: trades, costes aplicados, hashes de ingesta y (si aplica) lecturas on-chain.
- **Limitaciones**: tamano de muestra, regimenes cubiertos, supuestos de profundidad/costes,
  y todo lo que no se pudo verificar.

Clases de veredicto:

| Veredicto | Condicion | Lectura |
|---|---|---|
| REFUTADO | IC95% bootstrap < 0 y binomial rechaza el breakeven | No hay ventaja; cerrar la linea |
| PARADA RECOMENDADA | IC95% bootstrap < 0 sin rechazo del WR | La evidencia apunta a perdida; no seguir |
| NO CONCLUYENTE | IC95% cruza cero | Sin evidencia suficiente; seguir midiendo |
| NO REFUTADO | IC95% > 0 y folds estables | Indicio de ventaja; exigir walk-forward antes de capital |

## 7. Alcance y limites (declarados antes de contratar)

- Audita **una** estrategia y **su** historial; no valida el broker, el exchange ni la custodia.
- Un NO REFUTADO no es una recomendacion de invertir: es la ausencia de refutacion en la muestra.
- No garantiza resultados futuros; mide lo observado.
- Si el historial es PAPER, se declara explicitamente (no es evidencia de ejecucion real).
- No se aceptan datos de terceros sin autorizacion; el cliente declara la titularidad.

## 8. Confidencialidad y trazabilidad

- Los datos se procesan en un nodo aislado; no se publican ni se reutilizan sin autorizacion escrita.
- El informe incluye hashes de los archivos de entrada y, si el cliente lo aporta, la cadena de
  hashes de sus logs, de modo que el dictamen sea verificable contra los datos originales.
- Retencion: los archivos se devuelven o se destruyen al cierre, a eleccion del cliente.

## 9. Demo reproducible (sin red, sin datos del cliente)

`bun run audit:demo` genera dos estrategias sinteticas y muestra como el kit las clasifica:

```
--- Deceptiva (dashboard feliz, edge inexistente)
  Titular naive (lo que mostraria un dashboard): +$63.17 (6.32%)
  Auditable: bruto $-276.83 - fees $80.23 - slippage $20.06 = NETO $-377.12 (-37.71%)
  Muestra: n=160 | WR 76.88% vs breakeven 95.94% (deficit 19.06 pp)
  Inferencia: expectancy $-2.35699 | bootstrap IC95% [$-3.14641, $-1.56957] | binomial p=<1e-6
  Walk-forward: 0/4 folds positivos
  VEREDICTO DEL KIT: REFUTADO  [OK]

--- Sana (control de falsos positivos)
  Titular naive: +$392.27 (39.23%)
  Auditable: bruto +$392.27 - fees $125.9 - slippage $31.48 = NETO +$234.89 (23.49%)
  Muestra: n=250 | WR 53.6% vs breakeven 41.17%
  Inferencia: expectancy $0.93954 | bootstrap IC95% [$0.54308, $1.34211] | binomial p=0.999971
  Walk-forward: 4/4 folds positivos
  VEREDICTO DEL KIT: NO REFUTADO  [OK]
```

El primer caso demuestra la deteccion; el segundo, que el kit **no refuta todo** (control de falsos
positivos). Es el mismo criterio que se aplica a un cliente.

## 10. Hallazgo de la construccion del demo (control negativo del propio kit)

Al construir el caso deceptivo aparecio un defecto real en el pipeline: el reporte de validacion
calculaba el veredicto sobre el **PnL bruto** del ledger, sin restar `feePaidUsd` ni `slippageUsd`.
En la corrida real eso sobrestimaba el resultado (-3.32 bruto vs -4.66 neto). Corregido: el veredicto
se emite sobre el PnL **neto**. Sin este control negativo, el kit habria aprobado estrategias que
solo pierden por costes.

## 11. Roadmap comercial (si el servicio se abre)

1. Multi-estrategia y comparacion contra un benchmark de la misma volatilidad.
2. Monitoreo continuo (no solo auditoria puntual): la serie de equity y el invariante de conservacion
   ya estan construidos para eso.
3. Informe firmado con hash publicado (anclaje externo de la cadena).
4. Panel web de solo lectura para el cliente con el mismo criterio de "solo numeros auditados".
