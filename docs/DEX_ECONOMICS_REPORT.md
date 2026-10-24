# Simulador de Economía DEX — Resultados (Fase 2, paso 2)

Simulador riguroso de liquidez concentrada v3 (`src/research/dex-economics-sim.ts`).
Modela valor exacto de la posición (amount0/amount1), IL real vs hold, fees por concentración y gas en Base L2.
Compara: **LP pasiva**, **LP gobernada por señal** (volatilidad / tendencia) y **Hold**.

Ejecutable: `bun run src/research/run-dex-economics.ts --symbol BTCUSDT --hours 8760 --fee-apr 68.9 --width 0.065`

---

## Resultado (1 año, rango ±6.5%)

| Activo | Estrategia | Ret % | Fees | Drag IL | Gas | Rebal |
|---|---|---|---|---|---|---|
| ETH | LP Pasiva | +68.57 | 676.89 | -925.78 | 2.16 | 72 |
| ETH | LP + Señal Volatilidad | +56.83 | 573.77 | -1048.4 | 4.47 | 83 |
| ETH | LP + Señal Tendencia | +58.59 | 596.82 | -1112.6 | 7.77 | 129 |
| ETH | **Hold** | **-19.43** | 0 | 0 | 0 | 0 |
| BTC | LP Pasiva | +67.60 | 679.48 | -517.43 | 1.20 | 40 |
| BTC | LP + Señal Volatilidad | +65.61 | 647.79 | -533.33 | 2.16 | 52 |
| BTC | LP + Señal Tendencia | +64.32 | 648.73 | -597.05 | 3.21 | 62 |
| BTC | **Hold** | **-14.53** | 0 | 0 | 0 | 0 |

(El fee APR asumido es 68.9%, tomado de la documentación del proyecto para un pool de Aerodrome.)

## Hallazgos

1. **La LP batió a Hold en este período** (+68% vs -19% ETH; +67.6% vs -14.5% BTC). Motivo: en un mercado **bajista/lateral**, la LP convierte a stable al caer el precio y además cobra fees.
2. **La capa de señal VOLVIÓ a restar** (volatilidad/tendencia rinden MENOS que la LP pasiva en ambos activos). Mismo patrón que en CEX: la "inteligencia" no aporta; introduce pausas y gas que cuestan.
3. El resultado está **dominado por el fee APR asumido**, no por la señal. La exposición de precio de la LP fue ~plana (drag fijo ≈ -518 USD + gas).

## Sensibilidad al Fee APR (BTC, 1 año)

| Fee APR asumido | Ret LP Pasiva | Ret Hold |
|---|---|---|
| 10% | +9.51 | -14.53 |
| 30% | +29.24 | -14.53 |
| 69% | +67.70 | -14.53 |
| 150% | +147.58 | -14.53 |

**Todo el veredicto depende del fee APR real.** La LP batió a Hold en este período bajista por márgenes amplios, pero eso se sostiene solo si el APR es real y sostenible.

## Advertencias metodológicas (importantes)

1. **El fee APR (68.9%) es un supuesto**, no un dato validado. Los APR de DeFiLlama suelen estar inflados por emisiones de tokens (yield mercenario), no por fees orgánicas. Si el APR orgánico real es, ej., 15-25%, el resultado cae dramáticamente.
2. **La LP pierde contra Hold en tendencia alcista fuerte** (capar el upside). No se probó ese régimen aquí; el período muestreado fue bajista. La conclusión "LP > Hold" es específica de este régimen.
3. **Granularidad horaria**: los fees reales de un AMM concentrado dependen del volumen que atraviesa el rango y de la cuota de liquidez, no de un drip de APR lineal.
4. **La señal de DEX relevante es de régimen (horas), no la toxicidad en ms de Laya.** Este simulador usa señales de régimen (vol/tendencia) como proxy. La toxicidad de Laya, si valida, aplicaría a horizontes mucho más cortos.

## Conclusión

- **La LP es un vehículo plausible** (batió a Hold en este régimen y no necesitó señal alguna).
- **La señal no añadió valor, otra vez.** Si se construye DEX, sería **LP pasiva/rebalanceo simple**, no LP "inteligente".
- **La pregunta decisiva es el fee APR real**, no el modelo. Antes de escribir una línea de ejecución on-chain, hay que validar el APR orgánico sostenible de los pools objetivo (desde datos on-chain reales, no de dashboards agregados).
