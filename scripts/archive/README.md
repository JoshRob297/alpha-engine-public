# Scripts archivados

Codigo de la etapa **previa a la refutacion** (motor FX + harness de replay viejo). Sus modulos
de origen fueron eliminados del codigo (`src/guardrails/fx-dynamic-sets.ts`,
`src/guardrails/event-driven-allocator.ts`, `src/guardrails/dual-regime-failover.ts`,
`src/research/historical-feed.ts`), por lo que **no compilan ni se mantienen**.

Se conservan como historia tecnica y quedan **excluidos** de `tsconfig.scripts.json`.

Reemplazos vigentes:

| Script viejo | Reemplazo |
|---|---|
| `replay-harness.ts`, `replay-forensic.ts` | `scripts/replay-decisions.ts` + `src/guardrails/input-recorder.ts` |
| `run-step1-fx-isolated.ts`, `simulate-orchestrated-sets.ts` | Linea FX eliminada (ver `docs/CONCLUSIONS.md`) |
| `test-parity-failover.ts` | Logica de regimen en `src/daemon/regime-hysteresis.ts` |
| `run-evolved-60days-audit.ts` | `src/research/backtest-six-months*.ts` + `scripts/walk-forward-stability.ts` |
