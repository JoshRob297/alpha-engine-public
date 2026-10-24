# Directrices OPSEC y Modo Público / SaaS — Alpha Engine

> **Documento histórico (etapa previa a la refutación).** Puede contener proyecciones y cifras que el proyecto refutó. Ver [`HISTORY.md`](HISTORY.md) y [`CONCLUSIONS.md`](CONCLUSIONS.md).

Este documento define la arquitectura de privacidad, protección de alfa y seguridad operacional (OPSEC) para Alpha Engine, concebida para permitir su transición a producto público, SaaS multi-usuario o dashboard de inversores sin exponer vectores de ataque ni vulnerar la rentabilidad algorítmica.

---

## 1. Principio Fundamental de Privacidad de Alfa

En finanzas cuantitativas y provisión de liquidez algorítmica, **hacer público el estado operativo interno destruye la ventaja competitiva**:

1. **Front-running y Arbitraje Inverso:** Si actores externos conocen los precios exactos donde un bot rebalanceará o saldrá del mercado, pueden adelantarse en el libro (CEX) o desbalancear el pool artificialmente (DEX) mediante ataques sandwich o MEV.
2. **Caza de Stops:** Si el nivel de stop loss o invalidación se publica, los creadores de mercado agresivos pueden empujar temporalmente el precio hacia dicho nivel para inducir la liquidación.
3. **Ingeniería Inversa de Genomas:** Revelar simultáneamente el espaciado, multiplicador ATR y tiempos de retención permite reconstruir los parámetros genéticos calibrados durante 2 años de cómputo.

---

## 2. Matriz de Exposición: Modo Privado vs Modo Público (SaaS)

| Dato / Métrica | Dashboard Privado (Operador Interno) | Dashboard Público / Inversores / SaaS | Justificación OPSEC |
|---|---|---|---|
| **NAV Total & PnL Neto** | Visible exacto en USD y % | Visible en % (o base 100 / indexado) | Evita exponer el tamaño real de custodia ante ingeniería social. |
| **Win Rate & Profit Factor** | Visible exacto | Visible exacto | Métrica de rendimiento comercial segura. |
| **Comisiones Ganadas DEX** | Visible en USD exacto | Visible en USD o % acumulado | Demuestra utilidad sin revelar tickets de entrada. |
| **Rango Concentrado DEX (Límites)** | Precios exactos `[lower - upper]` | **Oculto / Censurado** (ej. `[PROTECTED - PROTECTED]`) | Evita sniping de liquidez y desbalanceo forzado de rango en Aerodrome. |
| **Margen restante a las bandas** | % exacto al piso y techo | Visible como estado cualitativo (`IN-RANGE` o `NEAR-EDGE`) | Impide calcular con precisión milimétrica cuándo el bot disparará el rebalanceo. |
| **Triggers de Rebalanceo DEX** | Umbral causal exacto de Laya | **Estrictamente Oculto** | Es el núcleo del alfa proprietario. |
| **Órdenes de Rebalanceo On-Chain** | Visibles internamente | **Transacción Atómica Privada (Flashbots / MEV-Blocker)** | Las txs de rebalanceo (`decrease` + `collect` + `mint`) deben agruparse atómicamente y enviarse vía RPC privado de Base cuando haya capital significativo. |
| **Stop Loss CEX (Binance)** | Precio exacto en USD | **Estrictamente Oculto** (`Protegido Sintético`) | El stop loss de Alpha Engine nunca se publica en el libro; revelarlo en una UI pública anula la ventaja del stop algorítmico interno. |
| **Niveles de Recompra Malla (L2/L3)** | Precios y montos exactos de la orden | Visible sólo como estado (`Malla Activa - 2 Niveles`) | Evita revelar el escalonamiento de inventario. |
| **Dirección de Billeteras** | Dirección pública completa | Dirección truncada (`0xeEa9...3297`) o alias | Higiene básica de seguridad cripto. |

---

## 3. Mecanismos Técnicos para el Modo Público

Para activar la vista pública o multi-tenant sin modificar el motor central, la arquitectura debe implementar los siguientes tres componentes:

### 3.1 Filtro de Sanitización en API (`http-server.ts`)
El servidor HTTP debe soportar dos modos mediante variable de entorno o header de autenticación (`ROLE: ADMIN` vs `ROLE: VIEWER`):

```typescript
// Sanitizador de telemetría para consumo público
export function sanitizeStatusForPublic(payload: any): any {
  const sanitized = JSON.parse(JSON.stringify(payload));

  // 1. Ofuscar rangos exactos de DEX
  if (sanitized.dex) {
    for (const [slot, item] of Object.entries(sanitized.dex)) {
      delete item.lowerRangePrice;
      delete item.upperRangePrice;
      delete item.entryPrice;
      item.rangeStatus = item.status === "ACTIVE" ? "OPTIMAL_BAND" : "REBALANCING_CALM";
    }
  }

  // 2. Ofuscar niveles internos y stops en CEX
  if (sanitized.cex) {
    for (const [ticker, item] of Object.entries(sanitized.cex)) {
      delete item.stopPrice;
      delete item.tpPrice;
      delete item.levels;
      if (item.bot) {
        delete item.bot.stop;
        delete item.bot.tp;
        delete item.bot.levels;
      }
    }
  }

  return sanitized;
}
```

### 3.2 Modo Demo / Inversor en Frontend (`index.html`)
El cliente web debe incluir un toggle de privacidad persistente en `localStorage`:
- **Modo Operador (Full Access):** Revela todos los niveles tácticos, rangos y balances para debugging y monitoreo propio.
- **Modo Público / Showcase:** Reemplaza montos fiduciarios absolutos por porcentajes relativos y enmascara los niveles críticos bajo etiquetas de protección institucional.

### 3.3 Protección contra MEV en Rebalanceos DEX On-Chain
En Base L2, aunque las comisiones de gas son mínimas, los searchers de arbitraje monitorean el mempool para realizar back-running o empujar el precio contra LPs concentrados:
- **Ejecución Atómica:** `DexEngine` nunca emite transacciones separadas para desarmar y rearmar un rango. Toda reestructuración debe ocurrir en un único llamado de contrato multicall o batch transaccional.
- **Retardo Anti-Mechazo (Cooldown Causal):** El motor no rebalancea ante picos momentáneos de volatilidad. Espera que Laya System 1 confirme calma en el Order Flow Imbalance antes de ejecutar.
- **RPC Privado:** En modo LIVE de alta capitalización, las llamadas hacia el secuenciador de Base deben dirigirse a endpoints privados que eviten la exposición en mempools públicos.

---

## 4. Conclusión

Alpha Engine fue diseñado con **separación total entre la intención algorítmica y la visualización externa**. La ejecución en Binance ya cumple con esto al 100% (órdenes Maker Post-Only y stops sintéticos internos). Para DEX, la arquitectura de Aerodrome Slipstream operará bajo las mismas directrices de ofuscación táctica, garantizando que el sistema pueda operar tanto como fondo privado como producto SaaS abierto sin comprometer el rendimiento del capital.
