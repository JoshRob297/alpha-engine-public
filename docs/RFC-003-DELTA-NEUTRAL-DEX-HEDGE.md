# RFC-003: ARQUITECTURA DE COBERTURA DELTA-NEUTRAL EN FUTUROS

> **Documento histórico (etapa previa a la refutación).** Puede contener proyecciones y cifras que el proyecto refutó. Ver [`HISTORY.md`](HISTORY.md) y [`CONCLUSIONS.md`](CONCLUSIONS.md).

**Estado:** IMPLEMENTADO Y EN PRODUCCIÓN (MODO SIMULACIÓN / LIVE-READY)  
**Fecha de Implementación:** 28 de Septiembre de 2026  
**Módulos:** `src/daemon/futures-hedge-engine.ts`, `src/cex/binance-futures-feeder.ts`, `src/daemon/dynamic-orchestrator.ts`

---

## 1. Justificación y Fundamento Cuantitativo

En la provisión de liquidez concentrada en **Aerodrome Slipstream (Base L2)**, los pools de alto rendimiento (ej. `AERO-USDC` con >100% APR o `USDC-CBBTC` con >380% APR) presentan dos componentes de rendimiento contrapuestos:
- **Ingresos Positivos:** Comisiones de intercambio (Swap Fees) generadas 24/7 por el volumen de los traders.
- **Arrastre Negativo:** Impermanent Loss (IL) y depreciación del activo volátil cuando el mercado cae.

Para neutralizar la volatilidad del activo y capturar el 100% de las comisiones limpias sin riesgo direccional, se implementó el submotor de **Cobertura Delta-Neutral Sintética (Short 1x)** en Binance Futures.

---

## 2. Arquitectura Implementada: Cadena de Mando DEX-Maestro

El sistema opera bajo una regla de subordinación estricta:
> **El DEX es el "Maestro" (la realidad del inventario); el Futuro es el "Esclavo" (la sombra que lo equilibra).**

```
           [ POSICIÓN CONCENTRADA LP EN BASE L2 (MAESTRO) ]
           - Aporta liquidez en Aerodrome Slipstream.
           - Emite eventos de rebalanceo y cambios de inventario on-chain.
                              │
                              ▼
           [ CENTINELA DE DEADBAND DINÁMICO (SETS + JEV) ]
           - Calcula la tolerancia óptima: Deadband = 4.5% * ATR_Mult * Regime_Mult.
           - Bounds adaptativos: ±2.5% (baja volatilidad) a ±9.5% (alta volatilidad).
           - Evita el sobre-ajuste y el churn de comisiones en Binance.
                              │
                              ▼
           [ COBERTURA CORTA 1X EN BINANCE FUTURES (ESCLAVO) ]
           - Abre y ajusta Shorts 1x proporcionales (AEROUSDT, ETHUSDT, BTCUSDT).
           - Monitorea el margen de mantenimiento (Health Ratio > 70%).
           - Inyecta colateral automático desde la Reserva en USDT si el margen cae de 40%.
                              │
                              ▼
           [ FLUJO DE COBRO BIDIRECCIONAL ]
           - Cosecha de Swap Fees en Base L2 (68% a 384% APR).
           - Cosecha pasiva de Funding Rates en Binance Futures (7% a 15% APR).
           - $\Delta_{\text{Total}} = \Delta_{LP} + \Delta_{\text{Short}} \approx 0.00$.
```

---

## 3. Gobernanza de Márgenes y Blindaje Anti-Liquidación

Para eliminar el riesgo de liquidación forzada en derivados:
1. **Apalancamiento Estricto 1x:** El valor nocional cubierto está respaldado 1:1 con colateral en USDT. No se utiliza apalancamiento multiplicador (5x, 10x o 20x).
2. **Colchón de Liquidación (+90% a +100%):** El precio de liquidación teórico de cada Short se ubica a más de un 90% de distancia del precio actual.
3. **Inyección Automática desde la Reserva:** Si el mercado experimenta un rally alcista extremo y el ratio de salud de margen baja del 40%, el submotor toma automáticamente fondos de la reserva fiduciaria de USDT para alejar el precio de liquidación.
4. **Destrucción de Coberturas Huérfanas:** Si un pool en Base L2 es retirado, sufre rotación a otro activo o se ejecuta un comando `FLATTEN`, el Short correspondiente se destruye de inmediato en Binance Futures.

---

## 4. Estado de Despliegue en Compute-node

- **Servicio:** Activo dentro de `alpha-engine.service` (puerto 3001).
- **Contratos en Cobertura Viva:**
  - `AEROUSDT`: Cubriendo el slot AERO con **+15.62% APR** de tasa de fondeo.
  - `ETHUSDT`: Cubriendo el slot BTC (WETH-cbBTC) con **+7.67% APR**.
  - `BTCUSDT`: Cubriendo el slot YIELD (USDC-cbBTC) con **+3.46% APR**.
- **Visualización:** Tarjetas violetas de derivados activas en el dashboard con métricas de salud de margen, tasa de fondeo en vivo y PnL acumulado.
