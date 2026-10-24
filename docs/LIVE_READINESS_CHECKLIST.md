# Lista de Verificación para Transición a Producción Real (Live Readiness Checklist)

> **Documento histórico (etapa previa a la refutación).** Puede contener proyecciones y cifras que el proyecto refutó. Ver [`HISTORY.md`](HISTORY.md) y [`CONCLUSIONS.md`](CONCLUSIONS.md).

Documento normativo de seguridad operacional previo al cambio de bandera `LIVE_TRADING_ENABLED=true` y `EXECUTION_MODE=LIVE` en **Alpha Engine v1.0.0**.
Cada criterio debe ser auditado formalmente antes de permitir la colocación de órdenes vivas con fondos reales en Binance Spot o transacciones de mint en Base L2.

---

## 1. Candados Estructurales de Código y Seguridad (OPSEC)

- [x] **Candado Maestro Verificado:**
  - `process.env.LIVE_TRADING_ENABLED === "true"` y `process.env.EXECUTION_MODE === "LIVE"` son los únicos mecanismos capaces de autorizar envíos de órdenes reales a las APIs de intercambio.
  - En `data/engine_state.json`, la configuración por defecto corre en modo seguro `PAPER` hasta el fondeo manual del usuario.
- [x] **Aislamiento Contable Absoluto:**
  - `data/engine_state.json` administra exclusivamente la simulación de capital institucional y coberturas (Modo Paper).
  - `data/real_accounting_ledger.json` administra de forma independiente la tesorería real fondeada en producción (Modo Live en Binance Spot y Base L2).
  - Comprobado que ningún trade del simulador contamina el saldo real ni viceversa.
- [x] **Cero Secretos en Repositorio:**
  - Claves API de Binance (`BINANCE_API_KEY`, `BINANCE_API_SECRET`) residen en `/home/user/.env.secrets` en Compute-node con permisos Unix `chmod 600`.
  - IP Whitelist estricta configurada en Binance: `201.123.5.60` (Nodo Compute-node).
  - Permiso de Retiros / Transferencias: **ESTRICTAMENTE BLOQUEADO** en la API key de Binance.
  - Clave privada de la Hot Wallet en Base L2 reside estrictamente fuera del árbol de Git (`.gitignore` auditado).
- [x] **Directiva Clean UI Estricta:**
  - Cero emojis en logs de producción, commits y mensajes del bot de Telegram. Única excepción: los 4 semáforos de estado permitidos por la regla oficial (`/root/.opencode/rules/telegram-ui.md`).

---

## 2. Validación de Infraestructura y Servicios Locales en Compute-node

- [x] **Daemon de Inferencia Local Laya (:8088):**
  ```bash
  systemctl --user status laya.service
  curl -s http://127.0.0.1:8088/health | jq .
  ```
  - Latencia HTTP media `< 1.0 ms`.
  - Checkpoints pre-cargados en memoria: `english`, `multilingual`, `typed-decisions`.
- [x] **Servidor de Telemetría Alpha Engine (:3001):**
  ```bash
  systemctl --user status alpha-engine.service
  curl -s http://127.0.0.1:3001/status | jq '{status: "ok", lastUpdated: .lastUpdated}'
  ```
  - Archivo de persistencia atómica responde sin errores de parseo JSON.
  - Submotores activos: CEX Engine, DEX Engine, Futures Hedge Engine, Capital Allocator.
- [x] **Túnel Seguro UI:**
  - Acceso verificado a la consola web en el puerto 3001.
  - Ambos paneles (Simulador y Modo Real) renderizan métricas reactivas, órdenes de mallas, observabilidad táctica y tarjetas de cobertura de futuros.

---

## 3. Conectividad y Controladores de Mercado (CEX, DEX y Futuros)

- [x] **Conexión a Base L2 Mainnet RPC:**
  ```bash
  bun test src/dex/aerodrome-rpc.test.ts
  ```
  - Consulta de bloque y saldo en Base RPC con latencia `< 300 ms`.
  - Dirección pública oficial: `<wallet-address>`.
  - Selectores ABI oficiales verificados: `decreaseLiquidity` (`0x0c49ccbe`) y `collect` (`0xfc6f7865`).
- [x] **Autenticación Binance Spot API v3:**
  ```bash
  bun test src/cex/binance-live-driver.test.ts
  ```
  - Firmas HMAC-SHA256 con timestamp y `recvWindow` válidas.
  - Candado `LIMIT_MAKER` (Post-Only) activo en el driver para garantizar tarifas Maker pasivas del 0.10% y rechazar cruces Taker accidentales.
  - Sincronización automática de filtros de mercado (`MarketRulesManager`): `minNotional` ($5.00 USD), `stepSize` y `tickSize`.
- [x] **Conexión a Binance Futures (/fapi/v1):**
  - Consulta en tiempo real de Mark Price y tasas de fondeo (*Funding Rates*) para `AEROUSDT`, `ETHUSDT` y `BTCUSDT`.
  - Submotor de cobertura delta-neutral con Deadband Dinámico (SETS + Jev) activo.

---

## 4. Protocolo de Fondeo y Activación en Vivo

Cuando el usuario decida realizar el depósito operativo ($60 a $100 USD iniciales en Binance):

1. **Paso 1: Fondeo Manual Vía SPEI:**
   - Depositar en la cuenta de Binance vía SPEI en pesos mexicanos o transferir USDT directo.
2. **Paso 2: Activar Switches en Compute-node:**
   - En `/home/user/.env.secrets` de Compute-node, verificar o añadir:
     ```bash
     EXECUTION_MODE=LIVE
     LIVE_TRADING_ENABLED=true
     ```
3. **Paso 3: Reinicio Controlado del Daemon:**
   ```bash
   systemctl --user restart alpha-engine.service
   ```
4. **Paso 4: Auditoría Inmediata:**
   - Abrir el dashboard en `http://<compute-node-ip>:3001`.
   - Verificar en la pestaña **Live** que el saldo de Binance se actualice de `$0.00 USDT` al monto depositado y que el bot empiece a colocar las primeras órdenes Maker Post-Only en el libro.

---

## 5. Alcance Real de Ejecución en Modo LIVE (Guardias de Seguridad)

Alpha Engine v1.0.0 implementa ejecución real **únicamente en CEX Spot (Binance)**. Los demás submotores se mantienen en simulación con guardias explícitas de código:

- [x] **CEX Spot (Binance) — OPERATIVO EN LIVE:**
  - Órdenes Maker reales vía `POST /api/v3/order` con `LIMIT_MAKER (Post-Only)`.
  - Salidas defensivas vía `POST /api/v3/order` tipo `MARKET`.
  - **Reconciliación de fills:** el estado interno solo se muta cuando Binance confirma `FILLED` (`GET /api/v3/order`). No hay fills optimistas.
  - TTL de órdenes resting: cancelación automática a los 30 minutos sin ejecución.
- [x] **DEX (Aerodrome Slipstream / Base L2) — SOLO SIMULACIÓN:**
  - Guardia `[DEX LIVE GUARD]`: no existe ejecución on-chain real conectada (mint/collect). Los valores DEX son sombra.
- [x] **Futuros (Binance Futures) — SOLO SIMULACIÓN:**
  - Guardia `[FUTURES LIVE GUARD]`: la cobertura delta-neutral no envía órdenes reales a `/fapi`. El funding y el PnL del short son sombra.
- [x] **Sin enrutamiento cruzado de exchanges:**
  - Si un ticker no tiene par Binance resuelto, la orden se aborta (`SYMBOL_NOT_RESOLVED`). Cero fallback a otros exchanges.

---

## 6. Fase 0 — Observabilidad, Atribución y Guardarraíles de Riesgo

- [x] **Atribución de PnL por componente** (`GET /metrics/attribution`):
  - Agrupa PnL bruto, fees, slippage y win rate por `GRID_FILL`, `PINGPONG`, `DCA_OUT`, `FRONT_RUN`, `TAKE_PROFIT`, `HARD_STOP`, `EMERGENCY`, `DEX_FEE`.
- [x] **Costos reales medidos** (Maker/Taker + slippage): visibles en `paperMetrics.totalFeePaidUsd`, `totalSlippageUsd` y `netPnlAfterCostsUsd`.
- [x] **Guardarraíles duros** (`GET /risk`, `POST /kill`, `POST /unkill`):
  - Kill-switch automático por límite de pérdida diaria (`RISK_MAX_DAILY_LOSS_USD`).
  - Exposición agregada y por activo (`RISK_MAX_AGGREGATE_EXPOSURE_PCT`, `RISK_MAX_SINGLE_ASSET_EXPOSURE_PCT`).
  - El kill-switch bloquea NUEVAS entradas pero nunca bloquea salidas.
- [x] **Heartbeat / Health** (`GET /health`): reporta `stalenessSeconds` y devuelve HTTP 503 si el daemon no late en >60s (apto para monitor externo).
