# ARQUITECTURA TÉCNICA Y GUARDRAILS DE ALPHA ENGINE v1.0.0

Especificación formal de sistemas, ecuaciones de microestructura, lógica de estados y algoritmos de ejecución para los mercados activos del sistema (**CEX Spot, DEX Liquidez Concentrada y Futuros Delta-Neutral**).

---

## 1. ESPECIFICACIÓN MATEMÁTICA DE LOS SETS ADAPTATIVOS POR ATR

Para erradicar constantes fijas y sobreajuste, todos los niveles de malla y salidas se computan como funciones continuas de la volatilidad realizada del activo.

### A. Cálculo del Average True Range Horario ($\text{ATR}_{14}$)
Dada una serie de velas horarias con precios $\{H_t, L_t, C_t\}$:

$$\text{TR}_t = \max\Big( H_t - L_t, \, |H_t - C_{t-1}|, \, |L_t - C_{t-1}| \Big)$$

$$\text{ATR}_{14, t} = \frac{1}{14} \sum_{i=0}^{13} \text{TR}_{t-i}$$

$$\text{ATR}_{\% , t} = \frac{\text{ATR}_{14, t}}{C_t}$$

### B. Mapeo Cuantitativo por Perfil de Activo (Genomas SETS)
El motor genético SETS asigna multiplicadores continuos según el perfil cuantitativo del activo:
- **`BETA` (Alta Volatilidad / Solana, AVAX, SUI, NEAR):** Múltiplos calibrados para atrapar retrocesos profundos y correr rallies largos.
- **`ANCHOR` (Volatilidad Media / Bitcoin, Ethereum):** Múltiplos balanceados para maximizar acierto pasivo en el Bid con órdenes Maker Post-Only (`LIMIT_MAKER`).

$$\text{Espaciado de Malla} = \max\Big( \text{Spread}_{\text{bps}} \times 1.5, \, \text{ATR}_{\% , t} \times k_{\text{spacing}} \Big)$$

$$\text{Take Profit (TP)} = \max\Big( \text{Fee}_{\text{Maker}} \times 3.5, \, \text{ATR}_{\% , t} \times k_{\text{tp}} \Big)$$

$$\text{Stop Loss Defensivo} = \max\Big( \text{Espaciado} \times 2.0, \, \text{ATR}_{\% , t} \times k_{\text{stop}} \Big)$$

$$\text{Descuento Post-SL} = \max\Big( \text{Espaciado} \times 1.5, \, \text{ATR}_{\% , t} \times k_{\text{discount}} \Big)$$

---

## 2. GOBERNANZA DE SALIDAS Y BLINDAJE INVISIBLE

### A. Stop Sintético Escalonado (Server-Side en Memoria)
Diseñado para eliminar el riesgo de *Stop Hunting* institucional:
1. **Invisibilidad en Memoria:** Ninguna orden stop se transmite al libro de órdenes del exchange. La evaluación se realiza a nivel milisegundo en la memoria del daemon en Compute-node.
2. **Hard Stop Algorítmico:**
   - Gatillo: $\text{MidPrice} \le \text{EntryPrice} \times (1 - \text{HardStop}_{\%})$ o toxicidad extrema de Laya ($\text{toxicFlow} > 0.75$).
   - Acción: Liquidación inmediata al mejor bid y pase a estado de enfriamiento/recalibración.

### B. Trailing Take Profit y Running Profits (CEX Spot Binance)
1. **Activación de Trailing:** Al superar el umbral inicial de beneficio ($\text{High} \ge \text{EntryPrice} \times (1 + \text{TP}_{\text{base}})$), el modo Trailing se activa.
2. **Fórmula de Seguimiento Dinámico:**
   $$\text{TrailingStop}_t = \max\Big( \text{TrailingStop}_{t-1}, \, \text{HighestHigh}_t \times (1 - \text{TrailingDistance}) \Big)$$
   - En Solana/Beta: $\text{TrailingDistance} = 3.5\%$.
   - En Bitcoin/Anchor: $\text{TrailingDistance} = 1.5\%$.
3. **Trailing Grid al Alza:**
   - Si $\text{MidPrice} > \text{GridPrice} \times 1.04$ y $\text{OFI} > +0.15$:
     $$\text{GridPrice}_{\text{new}} = \text{MidPrice} \times (1 - \text{Espaciado})$$
   - Mueve la orden pasiva Maker debajo del nuevo precio para capturar retrocesos horarios intermedios en plena tendencia alcista.

---

## 3. GOBERNANZA DE LIQUIDEZ CONCENTRADA EN DEX (BASE L2)

### A. Física de Slipstream (Aerodrome)
La provisión de liquidez en Slipstream opera dentro de un intervalo $[P_l, P_u]$:
- Cuando el precio está en rango ($P_l \le P \le P_u$), la posición gana comisiones de swap continuas con un multiplicador de concentración:
  $$M = \frac{1}{\sqrt{P_u / P_l} - 1}$$
- Con el rango adaptativo de $\pm6.5\%$, el multiplicador efectivo se sitúa entre $6.0\times$ y $8.0\times$ sobre una posición de liquidez tradicional no concentrada.

### B. Impermanent Loss Horario Exacto
Para cualquier divergencia de precio $k = P_t / P_{\text{entry}}$:

$$\text{IL}(k) = \frac{2 \sqrt{k}}{1 + k} - 1$$

En las pruebas continuas de 4,320 horas, la pérdida impermanente fue prácticamente neutralizada por la cobertura en futuros y la selección de pares correlacionados (`WETH-cbBTC`).

---

## 4. MOTOR DE COBERTURA DELTA-NEUTRAL EN DERIVADOS (RFC-003)

### A. Subordinación DEX-Maestro vs Futuros-Esclavo
Para eliminar el riesgo direccional de las piscinas de Base L2:
- Por cada dólar de activo volátil en el DEX, el submotor mantiene una posición corta (Short 1x) en Binance Futures (`AEROUSDT`, `ETHUSDT`, `BTCUSDT`):
  $$\Delta_{\text{Total}} = \Delta_{\text{DEX}} + \Delta_{\text{Short}} \approx 0.00$$

### B. Deadband Dinámico (SETS + Jev)
Para evitar el sobre-ajuste y el churn de comisiones:
$$\text{Deadband Dinámico} = 4.5\% \times \text{Multiplier}_{\text{SETS (ATR)}} \times \text{Multiplier}_{\text{Jev}}$$
- Tolerancia acotada entre **±2.5% y ±9.5%**. Si el inventario del pool cambia menos de esta banda, el Short permanece intacto cosechando la tasa de fondeo.

### C. Cosecha Pasiva de Funding Rates
- El Short cobra cada 8 horas las tasas de financiamiento pagadas por los especuladores alcistas en Binance Futures (+7% a +16% APR anualizado).

---

## 5. INFERENCIA DUAL CAUSAL: JEV CLOUD + LAYA SYSTEM 1

### A. Vector Microestructural de Laya Local
Laya en Compute-node (`:8088`) procesa el tensor físico en <1 ms:

$$\vec{X} = \begin{bmatrix} \text{Spread}_{\text{bps}} \\ \text{OFI}_{\text{score}} \\ \text{Depth}_{\text{ratio}} \\ \text{Evaporation}_{\text{flag}} \end{bmatrix}$$

- **Order Flow Imbalance ($\text{OFI}$):**
  $$\text{OFI} = \frac{\text{TakerBuyVol} - \text{TakerSellVol}}{\text{TotalVol}}$$
- Si $\text{OFI} > +0.20$ y $\text{toxicFlow} < 0.35$: Luz verde para compras Maker y rebalanceos.

### B. Protocolo de Fail-Over Paridad 1:1
- Si Jev Cloud entra en timeout ($t > 1500\text{ ms}$):
  - Laya local asume como **Hot-Standby**.
  - Si el activo arrastra una caída en 24h menor al $-3.5\%$, Laya declara automáticamente `DEFENSIVE_STRESS` con 95% de confianza, protegiendo al sistema de cualquier caída de red o de la nube.
