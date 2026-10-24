# Hoja de Ruta Comercial y Fases de Monetización — Alpha Engine

> **Documento histórico (etapa previa a la refutación).** Puede contener proyecciones y cifras que el proyecto refutó. Ver [`HISTORY.md`](HISTORY.md) y [`CONCLUSIONS.md`](CONCLUSIONS.md).

Este documento establece la estrategia corporativa, etapas de escalamiento de capital y modelo de negocio para Alpha Engine, diseñado para transicionar de laboratorio cuantitativo a producto comercial de alto valor y eventual adquisición tecnológica (Exit).

---

## 1. El Playbook de 4 Fases de Escalamiento

```
[ ETAPA 1: VALIDACIÓN SILENCIOSA ]
├── Capital: $60 - $100 USD (Binance Spot)
├── Foco: Correlación Paper vs Live en Compute-node (30-60 días)
└── Objetivo: Fills Maker 0.10% limpios y cero errores de ejecución
         │
         ▼
[ ETAPA 2: CÍRCULO CERCANO (F&F ALPHA SYNDICATE) ]
├── Modelo: 100% No-Custodial (API Keys con retiros bloqueados)
├── Regulación: Cero captación bancaria directa (Usuario custodia sus fondos)
├── Monetización: 20% Performance Fee sobre ganancia neta (High-Water Mark)
└── Objetivo: Construcción de Track Record Real Auditado con múltiples cuentas
         │
         ▼
[ ETAPA 3: SUITE SAAS COMERCIAL SEMI-PÚBLICA ]
├── Modelo: Open-Core Híbrido (Framework visible, Cerebro Laya/SETS privado en Black-Box API)
├── Catálogo: 4 Productos (Dual Híbrido, CEX Spot, DEX Vault, Equities TradFi)
├── Monetización: Suscripción SaaS ($50 - $150 USD/mes) + % sobre PnL neto
└── Objetivo: Escalabilidad de software y base recurrente de clientes
         │
         ▼
[ ETAPA 4: ADQUISICIÓN ESTRATÉGICA / EXIT ]
├── Compradores Potenciales:
│   ├── Exchanges Cripto Nivel 2 (Bitget, Kraken) buscando Vaults de Rendimiento nativos
│   ├── Plataformas de Trading (Pionex, 3Commas) para renovar bots obsoletos con IA causal
│   └── Fondos Web3 / DAOs de Ecosistema (Base / Optimism Eco-Funds)
└── Factor de Valor: 12 meses de track record en vivo con Drawdown < 2% y ROI > 30% anual
```

---

## 2. Gobernanza No-Custodial (Protección Legal y Fiscal)

Para operar la **Etapa 2 (Amigos y Conocidos)** sin incurrir en figuras de intermediación financiera no autorizada ni captación fiduciaria:

1. **Custodia Cero:**
   - Alpha Engine **nunca** recibe transferencias bancarias, depósitos en efectivo ni criptomonedas de terceros.
   - Cada participante mantiene su propia cuenta verificada en el exchange (Binance / Coinbase).
2. **Restricción Criptográfica en API Keys:**
   - La API Key entregada al orquestador en Compute-node debe tener configurado:
     - Permiso de Lectura: Habilitado.
     - Permiso de Trading Spot: Habilitado.
     - **Permiso de Retiros / Transferencias: ESTRICTAMENTE BLOQUEADO.**
     - **IP Whitelist:** Restringido a la IP fija del nodo de cómputo Compute-node.
3. **Liquidación de Comisiones de Éxito:**
   - Las comisiones por rendimiento (*performance fee*) son liquidadas manualmente por el usuario al cierre de cada mes según el reporte emitido por el dashboard.

---

## 3. Modelo "Open-Core" y Protección de Propiedad Intelectual

Ante el avance acelerado de modelos de inteligencia artificial y agentes autónomos, la ventaja temporal de Alpha Engine se preserva mediante la arquitectura de **Caja Negra Distribuida**:

* **Capa Abierta / Conectores:**
  - Controladores de API pública (Binance, Aerodrome, Alpaca).
  - Estructura de mallas elásticas y persistencia ACID.
  - Dashboard web de monitoreo institucional.
* **Capa Propietaria / Cerrada (El Núcleo No Replicable):**
  - **Pesos de Laya System 1:** El microservicio local en `:8088` que procesa Order Flow Imbalance en <1 ms.
  - **Genomas de SETS Bicentenarios:** Calibraciones genéticas de 2 años de klines que dictan los multiplicadores térmicos.
  - **Mempool Execution Guards:** Enrutamiento atómico anti-MEV para Base L2.

Esta separación permite publicar el producto o venderlo como SaaS sin entregar jamás los algoritmos internos que generan la rentabilidad.
