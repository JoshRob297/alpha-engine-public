# Reporte de Validación por Régimen — CEX (Fase 1B)

Generado por `src/research/validation-regimes.ts`. Extiende la Fase 1 añadiendo:
(1) filtro de régimen (operar solo fuera de tendencia), (2) ventanas de 1 y 3 años, (3) desglose de régimen del OOS.

Datos reales de Binance Spot. Split 70% IS / 30% OOS. Selección de genoma solo sobre IS. Costos 0.10% por fill y cierre.

---

## Ventana 1Y (365 días) — período alcista

| Activo | Estrategia | Ret % | MaxDD % | PF | Trades |
|---|---|---|---|---|---|
| BTC | Smart | +3.73 | 10.07 | 1.24 | 20 |
| BTC | Smart+Range | +4.46 | 9.11 | 1.28 | 20 |
| BTC | **Naive** | +10.03 | 7.07 | 1.77 | 22 |
| BTC | **Buy & Hold** | **+35.66** | 13.38 | — | 1 |
| SOL | Smart | -1.98 | 10.41 | 0.94 | 51 |
| SOL | Smart+Range | **-9.56** | 13.81 | 0.69 | 39 |
| SOL | **Naive** | +6.57 | 11.29 | 1.12 | 90 |
| SOL | **Buy & Hold** | **+81.27** | 14.90 | — | 1 |

Régimen OOS: BTC 79.4% en rango; SOL 59.6% en rango.

**Hallazgo A:** Incluso en un período con **79% de barras en rango**, el filtro de régimen **NO mejora** de forma consistente: ayuda marginal en BTC (+4.46 vs +3.73) y **empeora** en SOL (-9.56 vs -1.98). La hipótesis "edge en rango" **no se confirma**.

**Hallazgo B:** El grid ingenuo sigue batiendo a la capa inteligente. La inteligencia no aporta.

## Ventana 3Y (1095 días) — incluye mercado bajista

| Activo | Estrategia | Ret % | MaxDD % | PF | Trades |
|---|---|---|---|---|---|
| BTC | Smart | -7.75 | 31.11 | 0.86 | 40 |
| BTC | Smart+Range | **-0.97** | 20.36 | 0.98 | 33 |
| BTC | Naive | -19.95 | 34.70 | 0.73 | 55 |
| BTC | Buy & Hold | -15.57 | 45.35 | — | 1 |
| SOL | Smart | -18.84 | 30.35 | 0.82 | 112 |
| SOL | Smart+Range | **-13.84** | 23.61 | 0.85 | 92 |
| SOL | Naive | -32.39 | 46.71 | 0.84 | 259 |
| SOL | Buy & Hold | -24.26 | 64.25 | — | 1 |

**Hallazgo C:** En el mercado bajista, Smart+Range **pierde menos** que el grid ingenuo y que Buy & Hold (BTC -0.97% vs -19.95% vs -15.57%; SOL -13.84% vs -32.39% vs -24.26%). Es **mitigación de daño real**, pero el resultado **sigue siendo negativo** en absoluto.

---

## Veredicto (Fase 1B): NO PASA

| Ventana/Activo | Smart+Range | Naive | Buy&Hold | ¿Bate a Naive? | ¿Bate a B&H? |
|---|---|---|---|---|---|
| 1Y/BTC | +4.46 | +10.03 | +35.66 | No | No |
| 1Y/SOL | -9.56 | +6.57 | +81.27 | No | No |
| 3Y/BTC | -0.97 | -19.95 | -15.57 | Sí | Sí |
| 3Y/SOL | -13.84 | -32.39 | -24.26 | Sí | Sí |

1. **No hay edge positivo demostrado** en ninguna ventana ni activo. En los períodos alcistas pierde contra todo; en el bajista gana solo por "perder menos".
2. **La hipótesis de régimen queda refutada**: en un período con 79% de barras en rango, el filtro no aportó.
3. La única propiedad real y consistente: el filtro de régimen + stops **reduce drawdown y pérdidas** frente a la malla desnuda. Valor como **gestión de riesgo**, no como fuente de retorno.

## Interpretación honesta

- El dinero en cripto se hace en las **tendencias**. Un market-maker/grid, por construcción, **capa el upside** y queda estructuralmente por debajo de Buy & Hold en mercados alcistas.
- Su ventaja teórica (capturar oscilación) no compensa el costo de oportunidad de no estar largo en un activo tendencial, ni las comisiones.
- Lo único defendible que emergió es una **capa de control de riesgo** que reduce pérdidas — pero eso no es un producto de alfa; es gestión pasiva.

## Recomendación

1. **No construir DEX** sobre esta base mientras la pregunta del edge siga abierta.
2. **No fondear el piloto CEX esperando alpha**: la evidencia dice que un grid CEX no bate a Buy & Hold en ninguno de los regímenes evaluados.
3. **Reconsiderar la tesis completa** del producto (CEX grid como fuente de retorno). Si se quiere monetizar, el camino plausible es vender **gestión de riesgo / cobertura**, no "trading automático con IA".
4. Si se insiste en CEX: la única configuración con lógica sería un sistema **long-biased que no capa el upside** (ej. DCA/stacking con stops), no un grid de rango.

> Conclusión de una línea: **la evidencia out-of-sample, en dos ventanas y dos regímenes, no respalda un edge de trading en la malla CEX. El harness hizo su trabajo: evitó invertir meses y capital en una hipótesis no rentable.**
