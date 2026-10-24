# Resultados: Poder Predictivo de Laya (Fase 2)

Datos: libro L2 real de Binance (partial depth 100ms), ~68 min por activo (BTC 40,927 / SOL 35,972 snapshots).
403 muestras por activo (submuestreo 10s). Estado enviado a Laya en **texto natural** (su mejor caso).
Evento adverso: retorno futuro < -2 bps. Métrica: AUC (Mann-Whitney) y IC (Spearman).

## Resultado: Laya NO APORTA

### BTC — AUC para predecir movimiento adverso

| Horizonte | Laya `toxicFlow` | Baseline `-OFI` crudo |
|---|---|---|
| 1s | 0.5524 | **0.5860** |
| 5s | 0.5742 | **0.6610** |
| 30s | 0.5373 | **0.6418** |
| 60s | 0.5761 | **0.6342** |

### SOL — AUC

| Horizonte | Laya `toxicFlow` | Baseline `-OFI` crudo |
|---|---|---|
| 5s | 0.5452 | **0.6100** |
| 30s | 0.5263 | **0.5369** |
| 60s | 0.5080 | **0.5763** |

**En todos los horizontes y en ambos activos, el OFI crudo (que ya tenemos gratis) predice el movimiento adverso MEJOR que Laya.**

## Hallazgos

1. **Laya no supera al OFI crudo.** No añade valor predictivo. Veredicto del test: *"Laya NO APORTA: es un wrapper sin valor predictivo añadido."*
2. **El OFI crudo SÍ tiene poder predictivo real** (AUC 0.59–0.66; IC hasta -0.47). Es decir: **la idea subyacente (desequilibrio de flujo de órdenes anticipa movimientos adversos) es real — pero la señal ya la tienes sin ningún modelo.**
3. **La integración en producción estaba rota.** Laya es un modelo de TEXTO; el sistema le enviaba **números en JSON**, que el modelo ignora:
   - JSON: OFI de +0.9 a -0.9 → `toxicFlow` casi constante (~0.28).
   - Texto natural: calma → 0.0813; pánico → 0.7637.
   - **En producción, el `toxicFlow` de Laya era prácticamente una constante**, no una lectura del mercado.
4. **Latencia real ~242ms**, no el "< 1 ms" declarado en la documentación del proyecto.

## Conclusión

- **Laya (Convai, Apache-2.0) no aporta.** Ni en su mejor formato de entrada.
- **La señal que sí funciona es el OFI crudo**, que ya está implementado en el proyecto (`ofi-analyzer.ts`) y es gratis.
- Por tanto: si se construye algo con base microestructural, debe usar **OFI directo**, no Laya ni Jev.

## Implicaciones para el proyecto

- Se cierra la hipótesis "Jev/Laya son el valor diferencial". **No lo son.**
- Queda un activo real: **el OFI** como señal de flujo de órdenes con poder predictivo medido (AUC ~0.6). Es la única pieza de "inteligencia" con evidencia a favor — y es pública/trivial.
- Construir DEX o CEX sobre Laya/Jev no tiene sustento. Sobre OFI, hay una pista, pero la señal es débil (AUC ~0.6) y de seguro ya está arbitrada.

## Reproducir

```bash
# en Compute-node (Laya local)
bun run scripts/laya-predictive-test.ts --file data/l2/BTCUSDT_*.jsonl --symbol BTCUSDT --sample-ms 10000
# estado JSON (integración de producción) para comparar:
bun run scripts/laya-predictive-test.ts --file data/l2/BTCUSDT_*.jsonl --symbol BTCUSDT --sample-ms 10000 --state-format json
```
