# Cierre de la Hipótesis de Trading — Conclusiones y Evidencia

**Fecha:** 2 de octubre de 2026
**Alcance:** Alpha Engine v1.0.0 — suite multiactivo (CEX Spot, DEX Liquidez Concentrada, Futuros Delta-Neutral, FX).
**Propósito de este documento:** registrar formalmente el veredicto sobre si el sistema constituye una fuente de retorno defendible, con la evidencia que lo sustenta.

---

## 1. Resumen ejecutivo

**Veredicto: la hipótesis de trading queda cerrada. Ninguna de las líneas evaluadas demuestra un edge positivo, robusto y defendible.**

- **CEX (malla):** refutado en validación out-of-sample rigurosa.
- **DEX (liquidez concentrada):** viable solo como LP pasiva, sin edge y sin moat; depende de un fee APR no validado.
- **Futuros (cobertura delta-neutral):** nunca ejecutado en real; su aporte es simulación.
- **FX:** descartado previamente y sin evidencia confiable.

**El "cerebro" (Jev + Laya), que era el valor diferencial declarado, no aporta** — auditado y medido.

La causa no es un fallo de implementación aislado, sino **estructural**: operamos sin ventaja de datos, sin ventaja de ejecución/velocidad y compitiendo contra profesionales, con comisiones que superan cualquier edge marginal.

---

## 2. Metodología de validación (construida ad hoc)

Para no decidir por intuición, se construyeron instrumentos de prueba reproducibles:

| Instrumento | Archivo | Qué mide |
|---|---|---|
| Validación OOS | `src/research/validation-oos.ts` | Split IS/OOS, benchmarks (Buy&Hold, grid ingenuo), robustez de parámetros, sensibilidad de fecha |
| Validación por régimen | `src/research/validation-regimes.ts` | Filtro de régimen, ventanas 1Y/3Y, desglose de régimen |
| Poder predictivo de señal | `scripts/laya-predictive-test.ts` + `src/research/predictive-stats.ts` | IC (Spearman) y AUC de la señal vs baseline de OFI crudo |
| Recolector L2 | `scripts/collect-l2.ts` | Datos reales de libro (Binance partial depth 100ms) |
| Economía DEX | `src/research/dex-economics-sim.ts` + `run-dex-economics.ts` | Valor v3 exacto, IL real, fees por concentración, gas, vs Hold |

---

## 3. Resultados por línea

### 3.1 CEX Spot (mallas) — REFUTADO

Validación out-of-sample (8,760 h BTC/SOL, costos incluidos, split 70/30, genoma elegido solo en IS):

| Activo | Smart (SETS) | Grid ingenuo | Buy & Hold |
|---|---|---|---|
| BTC (1Y OOS) | +3.66% | +9.95% | **+35.50%** |
| SOL (1Y OOS) | −2.10% | +6.44% | **+80.89%** |

Ventana de 3 años (incluye mercado bajista):

| Activo | Smart | Smart+Range | Naive | Buy & Hold |
|---|---|---|---|---|
| BTC | −7.75% | −0.97% | −19.95% | −15.57% |
| SOL | −18.84% | −13.84% | −32.39% | −24.26% |

Conclusiones:
1. **Todos los genomas candidatos pierden en In-Sample** (−20% a −35%).
2. El **grid "inteligente" pierde contra el grid ingenuo** → la señal no aporta.
3. **La malla pierde contra Buy & Hold** en régimen alcista y solo "gana" en el bajista por perder menos.
4. Sin meseta de robustez (perturbación ±40% mueve el retorno ±10 puntos) ni estabilidad temporal.
5. La hipótesis "edge en rango" **refutada**: en un período con 79% de barras en rango, el filtro no aportó.

### 3.2 DEX (Liquidez Concentrada) — SIN EDGE

Simulador de economía con valor v3 exacto (1 año, costos y gas incluidos):

| Estrategia | ETH | BTC |
|---|---|---|
| LP Pasiva | +68.6% | +67.6% |
| LP + señal volatilidad | +56.8% | +65.6% |
| LP + señal tendencia | +58.6% | +64.3% |
| **Hold** | **−19.4%** | **−14.5%** |

Conclusiones:
1. La LP **batió a Hold** en el período muestreado **porque el mercado fue bajista**, no por ventaja. En tendencia alcista ocurriría lo contrario (la LP capa el upside).
2. **La capa de señal volvió a restar** (misma conclusión que en CEX).
3. El resultado está **dominado por el fee APR asumido** (68.9%): barrido de 10%→+9.5%, 30%→+29.2%, 69%→+67.7%, 150%→+147.6%. El APR real y sostenible **no está validado** (los APR de dashboards suelen incluir emisiones infladas).
4. La ventaja de velocidad de Laya (ms) es **irrelevante on-chain** (bloques ~2s, gas por acción); y un AMM llena al LP sin permitirle rechazar fills.

### 3.3 Futuros Delta-Neutral — NO EJECUTADO

- La cobertura corta 1x es **simulación**: no envía órdenes reales a Binance Futures.
- El "funding cosechado" de los reportes es aritmética, no ingreso.
- Con guardia de código explícita: `[FUTURES LIVE GUARD] ... permanece en SIMULACIÓN`.

### 3.4 FX (`usd_mxn`) — DESCARTADO

- Módulo eliminado del código. La cifra legacy (75.6% win) proviene de un backtest con el mismo sesgo metodológico (in-sample) y no es confiable.
- Estructuralmente **peor** que CEX: doble peaje de comisiones (0.2% ida/vuelta) con objetivos de salida pequeños.
- No se re-validó en esta ronda por estar ya descartado.

---

## 4. Auditoría del "cerebro" (Jev + Laya) — NO APORTA

**Qué son (verificado):**
- **Laya:** modelo **open-source Apache 2.0 de Convai Innovations** (ModernBERT), checkpoints públicos en HuggingFace. **No es propiedad del proyecto.**
- **Jev:** **API de terceros** (`api.typesafe.ai/v1/systemone`). **No es propiedad del proyecto.**
- La "destilación" a un modelo propio nunca se materializó: el dataset de entrenamiento era sintético (purgado) y el artefacto es un clasificador trivial.

**Poder predictivo (datos L2 reales, 68 min por activo, 403 muestras, estado en texto natural = su mejor caso):**

| Horizonte (BTC) | Laya `toxicFlow` (AUC) | OFI crudo (AUC) |
|---|---|---|
| 1s | 0.5524 | **0.5860** |
| 5s | 0.5742 | **0.6610** |
| 30s | 0.5373 | **0.6418** |
| 60s | 0.5761 | **0.6342** |

**El OFI crudo (gratis) predice mejor que Laya en todos los horizontes y en ambos activos.**

**Fallo de integración en producción:** Laya es un modelo de **texto**; el sistema le enviaba **números en JSON**, que ignora:
- JSON (OFI +0.9 → −0.9): salida casi constante (~0.28).
- Texto natural: calma → 0.081; pánico → 0.764.
- Es decir, en producción Laya devolvía **prácticamente una constante**.

**Latencia real ~242 ms**, no el "< 1 ms" declarado en la documentación.

---

## 5. Causa estructural común

1. **Market-making / reversión a la media capa el upside.** En mercados tendenciales, el dinero se hace en la tendencia; estas estrategias la recortan.
2. **Las comisiones superan el edge marginal** (0.2% roundtrip en CEX; gas en DEX; 0.2% en FX).
3. **Sin ventaja competitiva:** sin datos propietarios, sin infra de latencia, sin moat. El "cerebro" era de terceros.
4. **Las señales débiles pero reales (OFI, AUC ~0.6) son públicas y ya arbitradas.**

---

## 6. Qué queda de valor (activos reales)

1. **El criterio de validación.** El sistema se refutó a sí mismo con rigor (OOS, benchmarks, robustez, Monte Carlo). Ese criterio es un servicio vendible: auditar estrategias/bots ajenos contra el overfitting.
2. **El stack de observabilidad y riesgo** (`forensic-audit-logger`, `risk-guard`, `/health`, atribución por componente, canvas Telegram). Reutilizable para monitorear cualquier sistema automatizado.
3. **El OFI** como señal predictiva **medida** — pública, gratis, sin moat, pero con evidencia.
4. **Las librerías on-chain** (Aerodrome/Uniswap v3: encoders de mint/collect/decreaseLiquidity). Skill escaso y reutilizable.
5. **Las skills de infra/IA del operador** — donde está el valor de monetización real.

---

## 7. Cierre formal

**Se cierra la hipótesis de que Alpha Engine constituye una fuente de retorno defendible en CEX, DEX, Futuros o FX.**

El proyecto **no se descarta**: se **reposiciona**. Deja de ser un bot de trading y pasa a ser:
- Un **laboratorio de validación cuantitativa** (herramienta y metodología).
- Un **conjunto de componentes reutilizables** (riesgo, observabilidad, señales, on-chain).

**Recomendación:** no invertir más esfuerzo en estrategia de trading. Reasignar el tiempo a la monetización de las herramientas de IA del operador (automatización/servicios) y, si se desea, ofrecer el **servicio de validación** como producto.

---

## Anexo — Evidencia

- `docs/VALIDATION_OOS_REPORT.md`
- `docs/VALIDATION_REGIMES_REPORT.md`
- `docs/DEX_ECONOMICS_REPORT.md`
- `docs/LAYA_PREDICTIVE_RESULTS.md`
- `docs/LAYA_PREDICTIVE_TEST.md` (metodología)
- `docs/LIVE_READINESS_CHECKLIST.md` (alcance real de ejecución)
