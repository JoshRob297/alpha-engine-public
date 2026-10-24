# Proyecciones Financieras y Estrategia de Capital — Alpha Engine v1.0.0

> **Documento histórico (etapa previa a la refutación).** Puede contener proyecciones y cifras que el proyecto refutó. Ver [`HISTORY.md`](HISTORY.md) y [`CONCLUSIONS.md`](CONCLUSIONS.md).

Modelo cuantitativo de rendimiento y proyecciones empíricas basadas en datos observados en producción en el nodo `compute-node` (Binance Spot + Aerodrome Base L2 + Binance Futures Delta-Neutral).
Todos los rendimientos y participaciones se expresan en términos porcentuales normalizados y dólares estadounidenses netos.

---

## 1. Motores Cuantitativos de Generación de Valor

Alpha Engine v1.0.0 genera flujo de caja en cuatro frentes coordinados con gestión estricta de paridad de riesgo y neutralidad de mercado:

| Frente Operativo | Venue / Pares | Mecánica Cuantitativa | Rendimiento Empírico / Proyectado |
|---|---|---|---|
| **CEX Smart Maker** | Binance Spot (`BTCUSDT`, `SOLUSDT`) | Despliegue de mallas elásticas por ATR con órdenes Maker `POST_ONLY` (tarifa 0.10%). Salidas dinámicas escalonadas (TP1 al +2.40% / +4.00% según perfil) con Trailing Take Profit y Stop Loss sintético invisible en memoria. | **75.5% a 90.9% Win Rate** en operaciones reales. +0.8% a +1.5% mensual limpio de comisiones. |
| **DEX Concentrated Liquidity** | Aerodrome Slipstream en Base L2 (`WETH-CBBTC`, `USDC-CBBTC`, `AERO-USDC`) | Provisión activa de liquidez concentrada en rangos adaptativos ($\pm 6.5\%$ a $\pm 12\%$) con re-centrado anti-mechazo gobernado por Laya. Cosecha continua de comisiones swap de traders en capa 2. | **68.9% a 384.3% APR** en comisiones de swap. Aporte neto a cartera de +1.5% a +2.5% mensual. |
| **Futures Delta-Neutral Hedge** | Binance Futures Perpetuos (`AEROUSDT`, `ETHUSDT`, `BTCUSDT`) | Cobertura en posición corta (Short 1x) proporcional al capital volátil del DEX con Deadband dinámico (2.5% a 9.5%). Elimina la pérdida impermanente (IL) y cosecha la tasa de financiamiento (Funding Rate) cada 8h. | **+7.5% a +15.6% APR** en tasas de fondeo directas (+2.5% a +3.5% anual extra sobre la cartera global). |
| **Reserva Fiduciaria Líquida** | Billetera Spot (`USDT`) | Mantiene entre el 35% y el 50% de la cuenta en efectivo líquido para absorber choques macro, servir de colateral de margen en futuros y comprar en pisos de descuento. | **0% riesgo de mercado.** Preservación patrimonial activa que redujo el MaxDD histórico al 1.06%. |

---

## 2. Métricas Consolidadas y Auditadas (4,320 Horas / 6 Meses)

Datos forenses auditados mediante replay determinístico sobre datos reales de Binance Spot y Base L2:

- **Retorno Neto Semestral Consolidado (6 Meses):** **+15.27% a +18.05% ROI Neto** (con 23 stops ejecutados con slippage real de -0.25% y choque inyectado del -35%).
- **Rendimiento Anual Proyectado (Interés Compuesto):** **+42.0% a +52.0% Anual en USD** con cobertura de futuros activa.
- **Drawdown Máximo Histórico Combinado (MaxDD):** **1.06% a 1.39% de la cuenta** (frente al -28.22% de Bitcoin en el mismo semestre).
- **Ratio Calmar Semestral:** **> 12.0** (Grado Ultra-Conservador de Élite).
- **Estabilidad Temporal:** **6 de 6 meses consecutivos en terreno positivo** (+1.55% a +3.79% mensual).

---

## 3. Proyección de Rendimiento por Horizontes Temporales

Con la arquitectura completa de cuatro patas en operación continua:

### Escenario Conservador (Régimen BALANCED / DEFENSIVE_STRESS)
*Asume choques de mercado periódicos, pausas defensivas de Laya y comisiones de fondeo promedio de +0.005% / 8h.*

| Horizonte | Aporte CEX Spot | Aporte DEX Swap Fees | Aporte Futures Funding | Rendimiento Neto de Cartera | Retorno Acumulado |
|---|:---:|:---:|:---:|:---:|:---:|
| **30 Días** | +0.65% | +1.40% | +0.45% | **+2.50%** | **+2.50%** |
| **60 Días** | +1.30% | +2.80% | +0.90% | **+5.00%** | **+5.06%** |
| **90 Días** | +1.95% | +4.20% | +1.35% | **+7.50%** | **+7.69%** |
| **180 Días** | +3.90% | +8.40% | +2.70% | **+15.00%** | **+15.97%** |
| **360 Días (1 Año)**| +7.80% | +16.80% | +5.40% | **+30.00%** | **+34.49%** |

### Escenario Expansivo / Bull Market (Régimen AGGRESSIVE_ACCUMULATION)
*Mayor volumen de swaps en Base L2, mallas CEX corriendo con Trailing Take Profit y tasas de fondeo elevadas (+0.015% / 8h).*

| Horizonte | Aporte CEX Spot | Aporte DEX Swap Fees | Aporte Futures Funding | Rendimiento Neto de Cartera | Retorno Acumulado |
|---|:---:|:---:|:---:|:---:|:---:|
| **30 Días** | +1.20% | +2.10% | +0.80% | **+4.10%** | **+4.10%** |
| **60 Días** | +2.40% | +4.20% | +1.60% | **+8.20%** | **+8.37%** |
| **90 Días** | +3.60% | +6.30% | +2.40% | **+12.30%** | **+12.81%** |
| **180 Días** | +7.20% | +12.60% | +4.80% | **+24.60%** | **+27.27%** |
| **360 Días (1 Año)**| +14.40% | +25.20% | +9.60% | **+49.20%** | **+61.98%** |

---

## 4. Proyección en Dinero Real por Niveles de Capital

Modelo de acumulación con reinversión mensual compuesta (~3.2% mensual promedio):

| Nivel de Capital | Capital Inicial | Ingreso Neto Mes 1 | Capital a 1 Año | Capital a 3 Años | Rol Estratégico |
|---|:---:|:---:|:---:|:---:|---|
| **Piloto Operativo** | **$200 USD** | +$6.40 USD | **$292 USD** | **$624 USD** | Calibración de filtros y pruebas vivas en Compute-node. |
| **Cartera Base** | **$1,000 USD** | +$32.00 USD | **$1,460 USD** | **$3,120 USD** | Fondeo personal de validación continua. |
| **Fondo Mediano** | **$5,000 USD** | +$160.00 USD | **$7,300 USD** | **$15,600 USD** | Flujo pasivo para gastos corrientes. |
| **Sindica / Inversores**| **$25,000 USD** | +$800.00 USD | **$36,500 USD** | **$78,000 USD** | Pool sindicado con distribución de rendimientos. |
| **Institucional** | **$100,000 USD**| +$3,200.00 USD | **$146,000 USD**| **$312,000 USD**| Tesorería corporativa o family office (límite de capacidad óptimo). |

---

## 5. Principios Innegociables de Protección de Capital

1. **Delta-Neutralidad Estricta:** Las posiciones volátiles en DEX se cubren 1:1 en futuros; el portafolio no hace apuestas direccionales apalancadas.
2. **Cero Riesgo de Liquidación Forzada:** Los contratos de futuros operan en 1x colateralizados con respaldo de la reserva fiduciaria de USDT. Los precios de liquidación se mantienen a más de un +90% de distancia.
3. **Stops Sintéticos Invisibles:** La salida defensiva en CEX ocurre en milisegundos en la memoria local del servidor, impidiendo la manipulación de precios por market makers.
4. **Preservación Fiduciaria Activa:** Entre el 35% y el 50% de la tesorería permanece siempre en dólares líquidos.
