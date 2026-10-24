# Reporte de Validación Out-of-Sample — CEX (Fase 1)

Generado por `src/research/validation-oos.ts`. Datos: 8,760 velas horarias reales de Binance Spot (BTC, SOL).
Split temporal: In-Sample (IS) = 70% inicial; Out-of-Sample (OOS) = 30% final (sin fuga de información).
Selección de genoma SOLO sobre IS; evaluación reportada SOLO sobre OOS. Costos Maker 0.10% por fill y cierre.

## 1. Selección de genoma (In-Sample)

| Activo | Ranking IS (ret %) | Elegido |
|---|---|---|
| BTC | DEFAULT=-25.32 \| ATR_SOL=-27.47 \| ATR_BTC=-20.04 \| TIGHT=-26.80 | ATR_BTC |
| SOL | DEFAULT=-29.91 \| ATR_SOL=-34.77 \| ATR_BTC=-29.28 \| TIGHT=-24.68 | TIGHT |

**Hallazgo 1: Todos los genomas candidatos PIERDEN en In-Sample (entre -20% y -35%).** La selección se hizo entre perdedores.

## 2. Resultados Out-of-Sample vs Benchmarks

| Activo | Estrategia | Ret % | MaxDD % | Profit Factor | Trades | Win % | Exposición % |
|---|---|---|---|---|---|---|---|
| BTC | Smart (genoma) | +3.66 | 10.07 | 1.23 | 20 | 70.0 | 83.9 |
| BTC | **Grid Ingenuo** | +9.95 | 7.07 | 1.76 | 22 | 81.8 | 99.2 |
| BTC | **Buy & Hold** | **+35.50** | 13.38 | — | 1 | 100 | 100 |
| SOL | Smart (genoma) | -2.10 | 10.41 | 0.94 | 51 | 80.4 | 59.6 |
| SOL | **Grid Ingenuo** | +6.44 | 11.29 | 1.12 | 90 | 82.2 | 96.6 |
| SOL | **Buy & Hold** | **+80.89** | 14.90 | — | 1 | 100 | 100 |

**Hallazgo 2: La capa "inteligente" (señal genética) rinde PEOR que el grid ingenuo** en ambos activos (BTC: 3.66% vs 9.95%; SOL: -2.10% vs +6.44%). La inteligencia resta valor.

**Hallazgo 3: Ambos grids pierden contra Buy & Hold por márgenes enormes** (BTC: 3.66% vs 35.5%; SOL: -2.1% vs 80.9%). En el periodo evaluado el mercado fue alcista y la malla limita el upside.

## 3. Robustez de Parámetros (perturbación ±20% / ±40%)

| Activo | 0.6x | 0.8x | 1.0x | 1.2x | 1.4x | Rango |
|---|---|---|---|---|---|---|
| BTC | +0.8 | +5.8 | +3.66 | +12.1 | +10.63 | 0.8% – 12.1% |
| SOL | -5.92 | +0.97 | -2.10 | +0.52 | +3.86 | -5.9% – 3.9% |

**Hallazgo 4: No hay meseta de robustez.** Cambios de ±40% en parámetros producen swings de 3 a 11 puntos de retorno. El resultado es un "filo de cuchillo": no generaliza.

## 4. Sensibilidad a la Fecha de Inicio (offsets dentro del OOS)

| Activo | +0h | +168h | +336h | +504h |
|---|---|---|---|---|
| BTC | +3.66 | +6.26 | +11.57 | +8.98 |
| SOL | -2.10 | -0.11 | +3.75 | -0.70 |

**Hallazgo 5: El resultado depende fuertemente del punto de entrada**, con signo variable en SOL. Sin estabilidad temporal, no hay edge consistente.

## Veredicto (Gate Fase 1): NO PASA

1. La estrategia de malla CEX **no supera** los benchmarks en OOS (ni al grid ingenuo ni a Buy & Hold).
2. La ventaja declarada del "stack inteligente" **no aparece** en OOS; en los hechos, resta.
3. La robustez de parámetros y la estabilidad temporal son **insuficientes** para considerar el edge real.

## Implicaciones

- **No procede construir DEX (Fase 3+) sobre esta maquinaria** hasta resolver el punto 1.
- El resultado NO invalida todo el proyecto: valida el valor del harness (reveló en horas lo que semanas de paper habrían insinuado).
- La malla en tendencia alcista es estructuralmente débil; su edge, si existe, debe buscarse en regímenes laterales y/o en gestión de riesgo, no en la señal direccional actual.

## Siguientes pasos recomendados

1. **Reformular la hipótesis** de estrategia: evaluar la malla SOLO en regímenes laterales (filtro de tendencia macro) y con capital/tamaño que no compita contra Buy & Hold en tendencia.
2. **Medir con vergüenza**: si la estrategia no bate al grid ingenuo, eliminar la capa de señal/evolución.
3. **Re-validar**: repetir este harness sobre un periodo que incluya un mercado bajista/lateral para ver la verdadera asimetría.
