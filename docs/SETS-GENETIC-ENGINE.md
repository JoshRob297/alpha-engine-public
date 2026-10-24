# SETS: SUPER EVOLUTIONARY TRADING SYSTEM

> **Documento histórico (etapa previa a la refutación).** Puede contener proyecciones y cifras que el proyecto refutó. Ver [`HISTORY.md`](HISTORY.md) y [`CONCLUSIONS.md`](CONCLUSIONS.md).

**SETS** es el motor genético y de optimización paramétrica continua de Alpha Engine. Su función es erradicar constantes fijas (*hardcoding*) y sobreajuste (*overfitting*), haciendo evolucionar genomas cuantitativos que se adaptan a la volatilidad real del mercado mediante computación paralela de alto rendimiento.

---

## 1. ¿QUÉ ES Y QUÉ PROBLEMA RESUELVE?

En los mercados financieros, los parámetros estáticos (como un porcentaje de compra al -1.5% o un Take Profit fijo al +2%) están condenados a fallar debido al **Concept Drift (envejecimiento del régimen de mercado)**:
- Una malla fija diseñada para baja volatilidad se convierte en una trampa de liquidación durante un choque macro.
- Una malla fija diseñada para tormentas se queda paralizada y no genera operaciones durante semanas de consolidación.

**SETS resuelve este problema tratando a la estrategia como un organismo biológico adaptable:**
En lugar de ajustar precios o porcentajes directos, SETS optimiza **múltiplos físicos universales** sobre el Average True Range ($\text{ATR}_{14}$) y el Spread del libro de órdenes, garantizando que la estrategia se expanda o se contraiga automáticamente según la temperatura real del activo.

---

## 2. EL ESPACIO GENÓMICO (EL CROMOSOMA CUANTITATIVO)

Cada individuo o genoma dentro de la población de SETS se define mediante un vector de 5 genes continuos:

$$G = \begin{bmatrix} k_{\text{spacing}} \\ k_{\text{tp}} \\ k_{\text{stop}} \\ k_{\text{discount}} \\ \text{trailingGap} \end{bmatrix}$$

- **$k_{\text{spacing}}$ (Gen de Espaciado):** Multiplicador de entrada sobre $\text{ATR}_{14}$ [$0.5\times$ a $1.8\times$]. Dicta a qué profundidad por debajo del precio actual debe situarse la orden Maker pasiva.
- **$k_{\text{tp}}$ (Gen de Cosecha):** Multiplicador de Take Profit sobre $\text{ATR}_{14}$ [$1.8\times$ a $4.8\times$]. Asegura que el objetivo de salida supere con creces el doble peaje de comisiones del exchange.
- **$k_{\text{stop}}$ (Gen de Blindaje):** Multiplicador de Stop Defensivo sobre $\text{ATR}_{14}$ [$2.5\times$ a $6.8\times$]. Fija el fusible de seguridad para permitir que el activo respire su ruido normal sin falsos cortes.
- **$k_{\text{discount}}$ (Gen de Re-centrado Post-SL):** Multiplicador de descuento sobre $\text{ATR}_{14}$ [$1.2\times$ a $3.2\times$]. Determina qué tan abajo debe reubicarse la malla tras un choque para comprar únicamente con descuento institucional.
- **$\text{trailingGap}$ (Gen de Persecución Tendencial):** Holgura porcentual de seguimiento detrás de los máximos en fases de rally.

---

## 3. LA FUNCIÓN DE APTITUD MULTIOBJETIVO (FITNESS FUNCTION)

SETS no optimiza ganancia bruta en dólares (lo cual llevaría a sobreajuste ciego y ruina). Su función de selección penaliza severamente el riesgo y premia la robustez estadística:

$$\text{Fitness} = \Big( \text{PF} \times 0.45 + \text{WR} \times 0.35 + (1 - \text{DD}_{\%}) \times 0.20 \Big) \times \log_{10}\big(\max(2, N_{\text{trades}})\big) \times \Psi$$

Donde:
- **$\text{PF}$ (Profit Factor):** Relación matemática entre Ganancia Bruta y Pérdida Bruta ($\text{GrossProfit} / \text{GrossLoss}$).
- **$\text{WR}$ (Win Rate):** Tasa de acierto porcentual de operaciones ganadoras sobre el total.
- **$\text{DD}_{\%}$ (Max Drawdown):** Caída máxima sufrida por el capital respecto a su pico más alto.
- **$\log_{10}(N_{\text{trades}})$:** Factor de penalización por muestra pequeña (premia genomas con alta representatividad estadística).
- **$\Psi$:** Multiplicador de penalización asimétrica ($\Psi = 1.2$ si el PnL neto es positivo; $\Psi = 0.8$ si es negativo).

---

## 4. EL PROTOCOLO DE EVOLUCIÓN EN CACHY (22 HILOS)

SETS explota la arquitectura de hardware del nodo Compute-node (HP EliteBook G11, 22 hilos de CPU, 30 GB de RAM):

```
                   [ POBLACIÓN INICIAL (40 - 50 GENOMAS) ]
                                      |
         +----------------------------+----------------------------+
         |                                                         |
         v                                                         v
  [ HILO 1 ... HILO 22 ]                                    [ EVALUACIÓN ÁCIDA ]
  - Simulación paralela en Bun / TS.                        - Deducción de comisiones Maker.
  - Backtest sobre 4,705 horas históricas.                  - Cero lookahead bias.
                                      |
                                      v
                        [ SELECCIÓN DE ÉLITE (TOP 20%) ]
                        - Los mejores genomas sobreviven intactos.
                                      |
                                      v
                        [ CRUCE Y MUTACIÓN GAUSSIANA ]
                        - Crossover uniforme entre padres de élite.
                        - Mutación estocástica (15% probabilidad).
                                      |
                                      v
                     ¿Se alcanzaron 30 generaciones?
                                    /     \
                                  [NO]    [SÍ]
                                   |        |
                         (Siguiente Gen)    v
                                    [ GENOMA ÉLITE GANADOR ]
                                    - Despliegue en JSON a CEX / FX / DEX
```

---

## 5. GENOMAS ÉLITE ACTIVOS EN PRODUCCIÓN

Tras 30 generaciones evolutivas sobre 4,705 horas continuas de mercado real, SETS sintetizó los genomas que hoy gobiernan a Alpha Engine:

| Perfil de Activo | Spacing | Take Profit | Stop Loss | Descuento Post-SL | Win Rate Auditado | Profit Factor | Dataset Base |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **`BETA` (Solana - SOL)** | $0.78\times \text{ATR}$ | $2.91\times \text{ATR}$ | $3.90\times \text{ATR}$ | $3.07\times \text{ATR}$ | **80.0%** | **2.85** | 17,520h (2 Años) |
| **`BETA` (Avalanche - AVAX)**| $0.94\times \text{ATR}$ | $2.54\times \text{ATR}$ | $3.61\times \text{ATR}$ | $2.36\times \text{ATR}$ | **75.3%** | **2.16** | 18,000h (Binance) |
| **`BETA` (SUI Network - SUI)**| $1.30\times \text{ATR}$ | $2.56\times \text{ATR}$ | $2.99\times \text{ATR}$ | $1.93\times \text{ATR}$ | **70.4%** | **2.03** | 18,000h (Binance) |
| **`BETA` (Near Protocol - NEAR)**| $0.85\times \text{ATR}$ | $2.70\times \text{ATR}$ | $3.40\times \text{ATR}$ | $2.10\times \text{ATR}$ | **72.1%** | **2.10** | 17,520h (Binance) |
| **`ANCHOR` (Bitcoin - BTC)** | $1.21\times \text{ATR}$ | $3.47\times \text{ATR}$ | $3.23\times \text{ATR}$ | $2.36\times \text{ATR}$ | **75.0%** | **2.96** | 17,520h (2 Años) |

### Despliegue sin Downtime
SETS exporta sus resultados a `/home/user/proyectos/alpha-engine/data/evolved_atr_genomes.json`. Los demonios en producción leen este estado dinámicamente, permitiendo actualizar la agresividad y el blindaje del sistema sin reiniciar los servicios systemd.
