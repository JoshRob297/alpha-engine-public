# Prospeccion de bots publicos con backtests auditables (2026-10-24)

Datos publicos de GitHub, solo lectura. **Todos los casos son backtests: in-sample.**
Un veredicto aqui mide robustez interna del backtest, no evidencia out-of-sample.

## Resumen

- Repos inspeccionados: **8**
- Con trades individuales (auditables): **3**
- Solo agregados (`.txt`): **3**
- Solo capturas/README: **0**
- Datos sinteticos de test (fixtures, no estrategias): **2**
- Sin datos / errores: **0**
- Veredictos: NO CONCLUYENTE=2, REFUTADO=1
- Fees como % del bruto (mediana de los auditables): **95.8%**

## Auditables

| Repo | Estrellas | Estrategia | n | Neto % | PF | WR vs BE | Fees/bruto | Bootstrap IC95% | p binomial | Folds | Veredicto |
|---|---:|---|---:|---:|---:|---:|---:|---|---:|---|---|
| pumanitro/tral | 3 | SampleStrategy | 643 | -48.6 | 0.7805 | 82.74% vs 86% | n/d% | [-1.396, 0.063] | 0.011502 | 1/4 | **NO CONCLUYENTE** |
| pumanitro/tral | 3 | SampleStrategy | 584 | -49.2 | 0.7314 | 85.45% vs 88.92% | n/d% | [-1.625, -0.105] | 0.005829 | 0/4 | **REFUTADO** |
| CharlesLehnen/LightweightCharts-for-Freqtrade | 8 | SimpleVisualRSI | 32 | 0.1 | 1.0258 | 68.75% vs 68.2% | 95.8% | [-0.968, 1.028] | 0.592477 | 2/4 | **NO CONCLUYENTE** |

## Fixtures (no son estrategias)

- freqtrade/freqtrade — StrategyTestV2 (179 trades) · tests/testdata/backtest_results/backtest-result_multistrat.json | datos sinteticos de test (96% con PnL 0)
- freqtrade/freqtrade — StrategyTestV3 (179 trades) · tests/testdata/backtest_results/backtest-result.json | datos sinteticos de test (96% con PnL 0)

## Solo agregados (no auditables)

| Repo | Estrellas | Reportes .txt | Nota |
|---|---:|---:|---|
| Mastaaa1987/freqtrade-strategie | 140 | 11 | 11 reportes .txt sin trades individuales |
| lavaalone/freqtrade-backtest | 33 | 4 | 4 reportes .txt sin trades individuales |
| Canx/NFI_Backtest | 3 | 1 | 1 reportes .txt sin trades individuales |

## Metodo

1. Busqueda de repos por consultas de bots/backtests; arbol de cada repo por API.
2. Deteccion de `backtest-result*.json` (trades) y de reportes `.txt` (agregados).
3. Descarga de **1 JSON por repo** (el mas grande), adaptado con `adaptFreqtradeBacktest` (fees derivadas de `fee_open`/`fee_close`) y auditado con `runAudit`.
4. Reglas: pausas de cortesia, corte limpio al agotar la cuota, sin datos privados.

## Lectura

De 8 repos inspeccionados, **3** publican trades individuales auditables, **3** publican solo agregados o capturas y **2** son fixtures de test. Es decir: **la mayoria de los bots publicos no publica lo que hace falta para auditarlos**.

En los auditables, las fees consumieron una mediana de **95.8%** del PnL bruto. Ese es el hallazgo repetido: el coste de operar se lleva la mayor parte de lo que el backtest muestra como ganancia, y el veredicto estadistico (muestras chicas) no alcanza para afirmar ventaja.

## Hallazgo transversal

2 de 3 datasets auditables tienen **win rate > 60% y breakeven por encima del observado**: el patron repetido es "gana muchas veces, pierde mas por vez". El win rate alto es la parte visible; la expectancy negativa, la que importa.

## Correccion y verificacion (2026-10-24)

- El dataset de 584 trades (`REFUTADO`) proviene del commit inicial `1c1e700c` de `pumanitro/tral`
  (`backtest-result-2022-11-17_16-46-00.json`); en la rama actual ese archivo fue reemplazado por
  `..._16-29-12.json` (234 trades). Ambos se auditann con permalink a commit en
  [`docs/AUDITS_2026-10.md`](AUDITS_2026-10.md) y **ambos salen REFUTADOS**: la conclusion no
  depende de la version del archivo.
- Todas las fuentes quedaron verificadas con sha256 a commit fijado y su licencia citada.

## Limites

- Backtests in-sample; muchas veces optimizados por el autor sobre el mismo periodo.
- Muestras chicas (decenas de trades) y estrategias distintas entre repos: no se comparan entre si como si fueran un ranking de calidad.
- Solo se audita el primer JSON de cada repo; puede no ser la version que el autor considera vigente.
- Los repos 'solo agregados' no se auditan: el kit no emite veredicto sin trades.
