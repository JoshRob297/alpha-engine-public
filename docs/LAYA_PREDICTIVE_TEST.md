# Test de Poder Predictivo de Laya (Fase 2)

Determina si la señal de Laya aporta información predictiva sobre el futuro inmediato
del mercado, comparada contra baselines crudos (OFI y spread). Es la prueba fundacional:
si Laya no bate al OFI crudo, es un wrapper sin valor añadido.

## Componentes

| Archivo | Rol |
|---|---|
| `scripts/collect-l2.ts` | Recolecta libro L2 real de Binance (partial depth 100ms) a JSONL |
| `scripts/laya-predictive-test.ts` | Calcula features+consultas Laya y mide IC/AUC vs baseline |
| `src/research/predictive-stats.ts` | Estadística: Spearman IC y AUC (Mann-Whitney) |

## Procedimiento

### 1. Recolectar datos L2 (mínimo recomendado: 60–120 min por activo)

```bash
bun run scripts/collect-l2.ts --symbol BTCUSDT --minutes 90
bun run scripts/collect-l2.ts --symbol SOLUSDT --minutes 90
```

Escribe en `data/l2/<SIMBOLO>_<timestamp>.jsonl`.

### 2. Correr el test (con Laya activa en Compute-node)

Con Laya accesible por HTTP local (si corres el test en Compute-node):

```bash
bun run scripts/laya-predictive-test.ts --file data/l2/BTCUSDT_*.jsonl --symbol BTCUSDT
```

Desde orchestrator con Laya en Compute-node vía SSH:

```bash
bun run scripts/laya-predictive-test.ts --file data/l2/BTCUSDT_*.jsonl --symbol BTCUSDT --laya-ssh
```

Solo baselines (sin Laya), para verificar el pipeline:

```bash
bun run scripts/laya-predictive-test.ts --file data/l2/BTCUSDT_*.jsonl --no-laya
```

### 3. Leer el veredicto

El test imprime IC (Spearman) y AUC para evento adverso (retorno < umbral en bps) por horizonte, y compara:

- **Laya toxicFlow** vs **-OFI crudo** vs **spread**.
- **Laya meanReversion** como predictor de rebote.

Criterio:
- **Laya APORTA** si su AUC supera al mejor baseline en la mayoría de horizontes (con IC coherente).
- **Laya NO APORTA** si no supera al OFI crudo → es un wrapper.

Reporte: `data/laya_predictive_report.json`.

## Notas metodológicas

- El baseline **-OFI** es la referencia más dura: es información que ya tienes sin modelo. Si Laya no lo bate, no justifica su existencia en el pipeline.
- Los umbrales de "evento adverso" (default 2 bps) y los horizontes (1s/5s/30s/60s) son configurables con `--threshold-bps` y `--horizons`.
- Requiere Compute-node encendido (Laya corre en `:8088`). Sin Laya, usar `--no-laya` para validar solo el pipeline.
