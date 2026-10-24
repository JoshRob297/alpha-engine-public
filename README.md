# Alpha Engine — Laboratorio de validación (y archivo de su propio motor refutado)

**Historia completa (qué quisimos, qué construimos, cómo lo refutamos): [`docs/HISTORY.md`](docs/HISTORY.md).**

Este repositorio empezó como un motor de trading multi-activo (CEX + liquidez concentrada en DEX +
hedge de futuros). **La hipótesis de trading está cerrada: ninguna de sus líneas demuestra ventaja.**
El repositorio queda como **archivo técnico auditable** y como **laboratorio de validación**: el
conjunto de instrumentos que refutó al propio motor, aplicable a cualquier estrategia ajena.

- Caso de estudio completo: [`docs/VALIDATION_LAB_WHITEPAPER.md`](docs/VALIDATION_LAB_WHITEPAPER.md)
- Protocolo y resultados: [`docs/LIVE_PAPER_VALIDATION_2026-10.md`](docs/LIVE_PAPER_VALIDATION_2026-10.md)
- Cierre de la hipótesis: [`docs/CONCLUSIONS.md`](docs/CONCLUSIONS.md)
- Servicio de auditoría: [`docs/AUDIT_SERVICE_SPEC.md`](docs/AUDIT_SERVICE_SPEC.md)
- Plan vigente: [`docs/ACTION_PLAN_2026-10.md`](docs/ACTION_PLAN_2026-10.md)
- Validación del repo: [`docs/REPO_VALIDATION_2026-10-24.md`](docs/REPO_VALIDATION_2026-10-24.md)
- Auditorías de terceros: [`docs/AUDITS_2026-10.md`](docs/AUDITS_2026-10.md) y
  [`docs/AUDITS_PROSPECT.md`](docs/AUDITS_PROSPECT.md)

## Validación del repositorio

| Comando | Qué valida |
|---|---|
| `bun run typecheck` | Motor (`src/`) |
| `bun run typecheck:scripts` | Scripts + motor (antes no se typechequeaban) |
| `bun test` | Suite completa (288 tests) |
| `OFFLINE=1 bun test` | Suite hermética (280 + 8 con red, lo que corre CI) |
| `bun run audit:demo` | Kit de auditoría (3 casos) |

CI: `.github/workflows/ci.yml` (instalación frozen + ambos typechecks + tests offline + demo).
Último informe: [`docs/REPO_VALIDATION_2026-10-24.md`](docs/REPO_VALIDATION_2026-10-24.md)
(288 tests, 0 fallos; hallazgos corregidos: `ethers` faltante, 6 scripts legacy, CI inexistente).

## Qué demuestra la evidencia (resumen)

| Métrica (corrida Paper, 24 sep – 24 oct) | Valor |
|---|---|
| Cierres / win rate | 204 (82.84%) |
| Profit factor | 0.4985 |
| Expectancy neta | -0.0163 USD/trade (t = -2.151) |
| Payoff | 1:9.5 (gana +0.61%, pierde -3.4%) |
| Win rate de breakeven | 90.47% (déficit 8.85 pp) |
| Muestra OOS archivada | n=136, bootstrap IC95% [-0.039, +0.002], binomial p=0.0011 |
| Walk-forward | 1/4 folds positivos |
| Edge bruto por nocional | negativo → breakeven de capital = 0 |

Y los hallazgos que la propia auditoría encontró en el motor: **173.07 USD de capital acuñado** en
2.9 días (86.5% del capital), una segunda fuga de 10.28 USD, IL subestimado 29-47x, fee APR DEX
realizado de 10.6% (pool de 192% APR) y 82.7% (pool de 34%), gas de 119-507% de las fees, y un
dashboard que mostraba "+5 USD" cuando los libros decían "-4".

## Quick start

```bash
bun install

bun test                 # 288 tests (OFFLINE=1: 280 + 8 skip)
bun run audit:demo       # demo del kit: 2 casos sinteticos + 1 formato de terceros
bun run audit:cli --help # CLI de auditoria
```

Auditar una estrategia ajena:

```bash
alpha-audit --file export.csv --adapter generic --mapping docs/audit-mapping.example.json --capital 1000
alpha-audit --file engine_state.json          # formato del motor
```

Salida: veredicto (`REFUTADO` / `PARADA RECOMENDADA` / `NO CONCLUYENTE` / `NO REFUTADO` /
`NO AUDITABLE`), muestra, IC95% bootstrap, binomial contra breakeven, walk-forward, escalado y
limitaciones. Cada corrida escribe `data/audit_reports/audit_<label>_<ts>.json` con el **sha256 del
archivo de entrada**.

## Cómo funciona el kit

```
archivo ──► adaptador ──► modelo canónico ──► compuerta de calidad ──► PnL neto
                                                              │
        ┌─────────────────────────────────────────────────────┘
        ▼
bootstrap por bloques + binomial exacto + n efectivo ──► walk-forward ──► escalado ──► veredicto
```

1. **Modelo canónico** (`src/audit/canonical.ts`): el PnL se **deriva** de precios, cantidades y
   costes. El PnL declarado por el cliente es una afirmación a verificar, no la fuente de verdad.
2. **Adaptadores**: propio (`adapters/alpha-engine.ts`) y genérico JSON/JSONL/CSV con mapeo
   (`adapters/generic.ts`: `pnlKind`, `costSign`, `extraCosts`, delimitador autodetectado).
3. **Compuerta de suficiencia**: sin costes o sin granularidad → `NO AUDITABLE`. No se inventan datos.
4. **Inferencia sin supuesto de normalidad** (`src/research/statistics.ts`): bootstrap circular por
   bloques, binomial exacto, autocorrelación lag-1 y n efectivo, perfil de riesgo, regla de parada.
5. **Estabilidad y escala**: walk-forward por folds y curva de escalado con impacto y fees.
6. **DEX on-chain** (`src/dex/fee-growth.ts`): `feeGrowthInside` leído del contrato para comparar el
   APR realizado contra el modelado.

## Primeros casos auditados (datos públicos)

Ver [`docs/AUDITS_2026-10.md`](docs/AUDITS_2026-10.md). Resumen:

- **Backtest de Freqtrade (32 trades, auditable):** PF 1.03, +0.09% neto, **fees = 96% del bruto**,
  bootstrap IC95% cruza cero, un solo trade explica 616% del resultado → **NO CONCLUYENTE**.
- **Bot con 21 reportes `.txt` (sin trades):** +32,896% y Sharpe 3.14 publicados, pero **48% underwater**
  y 9/9 meses positivos (incluido un mes con el mercado -2.7%), sin benchmark ni out-of-sample, y sin
  datos individuales → **NO AUDITABLE** (el kit no inventa veredictos).

Importador de Freqtrade incluido: `bun run import:freqtrade --file backtest-result.json`.
Prospección y auditoría en lote de repos públicos: `bun run prospect:freqtrade --max-repos 18` → `docs/AUDITS_PROSPECT.md`.

## Comandos

| Comando | Qué hace |
|---|---|
| `prospect:freqtrade` | Prospección de repos públicos: clasifica y audita los JSON de Freqtrade |
| `import:freqtrade` | Convierte un backtest de Freqtrade en trades canónicos |
| `audit:demo` | Demo con 3 casos (deceptiva REFUTADA, sana NO REFUTADA, MT4 ajeno NO CONCLUYENTE) |
| `audit:cli` | CLI `alpha-audit` (ingesta → veredicto → reporte) |
| `audit:pnl` | Recomputación independiente del PnL (CEX por componentes, DEX por slot) |
| `audit:dex-inputs` / `audit:dex-fees` | Puente estado→ticks/L y auditoría on-chain de fees |
| `audit:scaling` | Curva de escalado y breakeven de capital |
| `walk-forward` | Estabilidad temporal por folds |
| `replay:decisions` | Replay determinista de decisiones sobre inputs grabados |
| `verify:chain` | Verificación de la cadena de hashes del audit log |
| `monitor:equity` | Deriva de la conservación de capital (serie horaria) |
| `validate:paper` | Reporte diario de validación (OOS, bootstrap, binomial, walk-forward) |
| `verify:open-items` | Verificación de los puntos abiertos del protocolo (5/5) |

## Garantías de integridad (lo que hace creíble el veredicto)

- **Invariante de conservación** por tick con reparación auditada (`CAPITAL_REPAIR`, CRITICAL) y
  contador persistido. Detectó las dos fugas del motor.
- **Cadena de hashes** en el audit log forense (sha256 encadenado, verificación por archivo).
- **Auditoría independiente de PnL** (desvío típico < 0.1 USD sobre la muestra).
- **Replay determinista** de decisiones (100% de acuerdo en los pulsos grabados).
- **Universo congelado** durante la ventana OOS (admisiones bloqueadas y registradas).
- **Compuerta de suficiencia** en el kit: no se emite veredicto sin datos verificables.

## Límites

- Un veredicto cubre **una** estrategia y **su** historial; no valida broker, exchange ni custodia.
- Un `NO REFUTADO` no es una recomendación de invertir: es ausencia de refutación en la muestra.
- Los backtests son in-sample por definición: el kit los audita, no los convierte en evidencia OOS.
- Un bot que solo publica una curva de equity **no es auditable** con este kit (sería forense de
  curva, otro producto, más débil).
- Nada de esto operó capital real: el ledger real tiene ~7 USD y ganancia 0.00.

## Estado del repositorio

Archivo técnico en mantenimiento: la ventana OOS vigente corre en modo Paper y el veredicto formal se
emite a los 191 cierres. El código del motor está congelado; el desarrollo activo es el kit de auditoría.
