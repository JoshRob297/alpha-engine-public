# Refutar el propio motor: caso de estudio de un laboratorio de validacion

**Alpha Validation Lab — Documento 1 — 2026-10-24**

## Resumen

Este documento describe como un motor de trading automatizado (CEX spot + liquidez concentrada en
DEX + hedge de futuros) que **se publicitaba con Sharpe 4.22 y +57-65% anual** fue refutado por su
propio sistema de medicion en 30 dias de operacion simulada, y que instrumentos fueron necesarios
para que la refutacion fuera **creible y reproducible**: ventana out-of-sample pre-registrada,
inferencia sin supuesto de normalidad, auditoria contable con invariante y reparacion trazable,
cadena de hashes sobre el log forense, replay determinista y auditoria on-chain de las fees.

El resultado no es "el motor gana menos de lo esperado". Es que **no tiene ventaja demostrable**, que
la arquitectura de riesgo estaba invertida (win rate 82% con expectancy negativa) y que la fuente de
señal no predice nada medible. El aporte transferible es el **protocolo y el stack de auditoria**, no
la estrategia.

## 1. La afirmacion original

| Metrica publicada por el proyecto | Valor |
|---|---|
| Version | `3.2.0-evolved-shielded` |
| Retorno anual | +57% a +65% |
| Sharpe | 4.22 |
| Max drawdown | 1.85% |
| "Preservacion del capital" | 99.44% |

Esas cifras provenian de backtests in-sample con optimizacion genetica sobre el mismo periodo
evaluado. El propio proyecto las refuto el 2026-10-02 con validacion out-of-sample:

| Activo | Estrategia OOS 1 año | Buy & Hold |
|---|---|---|
| BTC | +3.66% | **+35.50%** |
| SOL | -2.10% | **+80.89%** |

## 2. Metodo (pre-registrado antes de medir)

1. **Ventana OOS congelada:** genomas y recalibracion congelados (`GENOME_FREEZE`), inicio de ventana
   fijado en el estado y en el reporte. Todo trade anterior queda fuera del computo.
2. **Universo congelado:** activos y pools fijados al inicio. Cualquier admision posterior se bloquea
   y se registra (en la ventana de octubre se bloquearon 12 pools externos que antes habrian rotado).
3. **Inferencia robusta, sin normalidad:** bootstrap circular por bloques del promedio, test binomial
   exacto del win rate contra el win rate de breakeven, autocorrelacion lag-1 y tamaño efectivo.
   El t de Student se reporta solo como referencia y se declara inapropiado cuando el perfil es bimodal.
4. **Estabilidad y escala:** walk-forward por folds temporales y curva de escalado con impacto y fees.
5. **Contabilidad auditada:** identidad de conservacion por tick, reparacion automatica con evento
   forense, auditoria independiente de PnL y cadena de hashes sobre el log.
6. **Regla de parada pre-registrada:** REFUTADO si el IC95% bootstrap queda bajo cero y el binomial
   rechaza el breakeven, con muestra minima.

## 3. Resultados (corrida Paper, 24 sep - 24 oct)

| Metrica | Valor | Lectura |
|---|---|---|
| Cierres | 204 (169W/35L) | Win rate 82.84% |
| Profit factor | 0.4985 | Cada dolar ganado acompanado de dos perdidos |
| Expectancy | -0.0163 USD/trade | t = -2.151 |
| Payoff | 1:9.5 | Gana +0.61%, pierde -3.4% |
| Breakeven WR | 90.47% | Deficit de 8.85 pp |
| Muestra OOS (archivada) | n=136 | Bootstrap IC95% [-0.039, +0.002]; binomial p=0.0011 |
| Autocorrelacion | lag-1 0.199 | n efectivo 90.9 de 136 |
| Walk-forward | 1/4 folds positivos | Inestable |
| Edge bruto por nocional | -0.00275 | Breakeven de capital = 0 |

**Diagnostico estructural:** cortar ganadores en +0.61% y dejar correr perdidas a -3.4% exige un
win rate de 90.5% para no perder; el sistema entrega 82%. Ningun ajuste de parametros cambia esa
aritmetica. El contrafactual confirmo que **mantener la posicion superaba a las salidas del motor**
en casi todas las categorias, incluidas las de emergencia: el motor destruia valor al operar.

**Señal:** Laya (modelo local) y Jev (terceros) fueron medidos contra OFI crudo y contra azar; su
poder predictivo es indistinguible de una moneda a los horizontes operados. Los genomas "evolucionados"
con 100% de win rate in-sample resultaron negativos out-of-sample: ajustaban ruido.

## 4. Lo que la auditoria encontro (y por que importa)

Una refutacion solo vale si la medicion es confiable. El stack contable encontro defectos que ningun
reporte tradicional habria visto:

| Hallazgo | Magnitud | Como se detecto |
|---|---|---|
| Capital acunado (creacion de slots DEX sin debito + poda sin credito + churn de regimen) | **+173.07 USD** sobre 200 (86.5%) en 2.9 dias | Identidad de conservacion + `CAPITAL_REPAIR` |
| Segunda fuga (regimen moviendo el objetivo ~40 USD cada 5-9 h) | **10.28 USD** (5.1%) | Misma identidad, reparada y ventana invalidada |
| IL subestimado (formula de rango completo en LP concentrado) | **29-47x** | Comparacion analitica + tests de convergencia |
| Fee APR DEX realizado vs modelado (on-chain) | **10.6%** (pool 192% APR) y **82.7%** (pool 34%) | `feeGrowthInside` leido del contrato |
| Gas vs fees DEX | **119%** y **507%** de las fees | Contabilidad DEX persistida |
| Dashboard mostrando "+5 USD" | Falso: suma de PnL bruto, fees sin gas/IL y funding de un hedge **simulado** | Reconciliacion contra la equity auditada |
| Reportes diarios con estado congelado (3 dias) | Cifras viejas como actuales | Guardia de frescura + dead-man switch |

La conclusion incomoda: **el motor no "empezo a perder" con las correcciones; siempre perdio.** Lo que
cambio fue la medicion. Cada correccion de realismo (fills con cola e impacto, IL concentrado, fee APR
on-chain, inferencia robusta) movio el resultado en la misma direccion: peor.

## 5. Que hace el laboratorio (producto)

Entrada: estado persistido + historial de operaciones + logs de un bot o estrategia de terceros.
Proceso: reconstruccion independiente de PnL -> inferencia robusta -> walk-forward -> analisis de
escalado -> (si hay DEX) auditoria de fee growth on-chain -> dictamen con evidencia cruda.
Salida: veredicto clasificado (REFUTADO / PARADA RECOMENDADA / NO CONCLUYENTE / NO REFUTADO),
con la muestra, los intervalos, la regla de parada y el rastro auditable (hash chain).

Instrumentos reutilizables: `verify:open-items`, `audit:pnl`, `audit:dex-fees`, `audit:scaling`,
`walk-forward`, `replay:decisions`, `verify:chain`, `monitor:equity`, `validate:paper`.

## 6. Limitaciones

- Es un caso: refuta **esta** estrategia, no una clase entera. El metodo es transferible; el veredicto no.
- La ventana OOS se reinicio dos veces por derivas contables. La regla conservadora (reiniciar) costo
  muestra y se mantuvo por credibilidad.
- La comparacion DEX se hizo con amplitud relativa de rango equivalente, no con la posicion exacta
  (el estado no persistia la direccion del pool).
- El hedge de futuros es simulacion sin ordenes reales: no es evidencia de nada.
- Sin capital real en riesgo en ningun momento (ledger real: ~7 USD, ganancia 0.00).

## 7. Conclusion

El valor del proyecto no es el retorno: es haber construido la maquina que demuestra que el retorno
publicado era falso, y haberla aplicado a si mismo con evidencia reproducible. **Un laboratorio que
refuta su propio motor es mas creible que mil dashboards en verde.** Ese es el producto.
