# Validación del repositorio — 2026-10-24

Alcance: todo el árbol (`src/` + `scripts/` + `docs/` + configuración), con verificación
reproducible. No se modifica el motor en producción; los cambios de esta pasada son de higiene,
tipado y CI.

## Resultados

| Check | Comando | Resultado |
|---|---|---|
| Instalación reproducible | `bun install --frozen-lockfile` | OK (lock actualizado con `ethers@6.17.0`) |
| Typecheck del motor | `bun run typecheck` | **limpio** |
| Typecheck de scripts | `bun run typecheck:scripts` | **limpio** (antes: 24 errores) |
| Tests | `bun test` | **288 pass / 0 fail** (13.964 asserts) |
| Tests sin red (CI) | `OFFLINE=1 bun test` | **280 pass / 8 skip / 0 fail** |
| Demo del kit | `bun run audit:demo` | exit 0 (3/3 casos correctos) |
| CLI | `bun run audit:cli --help` | exit 0 |
| Cadena de hashes | `bun run verify:chain --all` | 26/26 archivos íntegros |
| Puntos abiertos | `bun run verify:open-items --state ...` | 5/5 PASS |
| PnL independiente | `bun run audit:pnl --state ...` | CUADRA (desvío CEX 0.0268) |
| Walk-forward | `bun run walk-forward --state ...` | OK |
| Escalado | `bun run audit:scaling --state ...` | OK (breakeven 0) |
| Import Freqtrade | `bun run import:freqtrade --file ...` | OK |
| Monitor de equity (compute-node, en vivo) | `bun run monitor:equity` | **SANO** (residuo -0.004, pendiente -0.0003/h) |
| Monitor de equity (local, serie vieja) | idem | ANOMALIA esperada: la serie traída contiene la invalidación del 22-10 |
| Documentación | script de links relativos | 7 links revisados, **0 rotos** |
| Secretos en archivos versionados | `git grep` de patrones (tokens, claves, AWS, `sk-`) | **0 hallazgos** |
| Runtime versionado | `git ls-files` | solo `data/evolved_atr_genomes.json` (intencional: almacén limpio de referencia) |
| `package.json` | scripts y bin | 29 scripts, 0 archivos faltantes; `bin.alpha-audit` existe |

## Hallazgos y correcciones

1. **`ethers` faltaba en `package.json`.** `scripts/deploy-pool.ts` (watcher de Base) lo importa y
   funcionaba solo porque estaba instalado a mano en compute-node: una instalación limpia habría roto el
   watcher. **Corregido**: `dependencies.ethers@^6.17.0` + lock actualizado.
2. **Seis scripts legacy no compilaban** (importaban módulos eliminados de la etapa FX:
   `fx-dynamic-sets`, `event-driven-allocator`, `dual-regime-failover`, `historical-feed`).
   **Corregido**: movidos a `scripts/archive/legacy/` con `scripts/archive/README.md` que indica el
   reemplazo vigente de cada uno; excluidos de `tsconfig.scripts.json`.
3. **Dos scripts llamaban a `evaluateMarketWithJev` con firma obsoleta** (sin `book`, `midPrice`,
   profundidades; con `timestamp` inexistente). **Corregido** en `benchmark-jev-vs-laya.ts` y
   `test-jev-direct.ts`.
4. **`prospect-freqtrade.ts`** usaba estados (`SOLO_CAPTURAS`, `FIXTURE`) fuera de la unión de tipos.
   **Corregido**.
5. **No había CI.** Agregado `.github/workflows/ci.yml`: instalación frozen, ambos typechecks, tests
   con `OFFLINE=1` y demo del kit.
6. **Tests con red** (DeFiLlama, funding, onboarding JIT): 8 tests ahora se saltan con `OFFLINE=1`
   para que CI sea hermético; localmente corren (280 + 8).
7. **README desactualizado** (decía 280 tests). **Corregido** a 288 + sección de validación.

## Riesgos residuales (declarados)

- Los scripts se typechequean con `typecheck:scripts` (ahora en CI); antes no se typechequeaban.
- `data/evolved_atr_genomes.json` se versiona a propósito (referencia limpia); el resto de `data/`
  está ignorado. No contiene secretos ni el token de test.
- El `data/` local del orquestador conserva artefactos de la ventana anterior; por eso el monitor
  local marca ANOMALIA. El nodo en vivo (compute-node) está SANO.
- Los scripts archivados no compilan por diseño (dependen de módulos eliminados).

## Cómo re-validar

```bash
bun install --frozen-lockfile
bun run typecheck && bun run typecheck:scripts
bun test                # completo (con red)
OFFLINE=1 bun test      # hermético (lo que corre CI)
bun run audit:demo
bun run verify:chain --all
bun run verify:open-items --state data-runtime/engine_state.json
```
