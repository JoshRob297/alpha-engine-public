#!/usr/bin/env bun
/**
 * Prospeccion de bots publicos para auditar con el kit.
 *
 * Que hace:
 *  1. Busca repos en GitHub (API publica) por consultas de bots/backtests.
 *  2. Inspecciona el arbol de cada repo y clasifica:
 *       - AUDITABLE: tiene `backtest-result*.json` con trades individuales (Freqtrade),
 *       - SOLO AGREGADOS: publica reportes `.txt`/capturas sin trades,
 *       - SIN DATOS.
 *  3. Para los auditables: descarga el JSON, lo adapta (`adaptFreqtradeBacktest`) y corre
 *     `runAudit` (bootstrap por bloques, binomial, walk-forward, escalado).
 *  4. Escribe un ranking JSON +Markdown.
 *
 * Reglas: solo datos publicos, lectura, 1 JSON por repo, pausas de cortesia y corte limpio
 * si la API agota la cuota. Los backtests son IN-SAMPLE: el reporte lo declara.
 *
 * Uso:
 *   bun run scripts/prospect-freqtrade.ts [--max-repos 18] [--out data/prospect] [--md docs/AUDITS_PROSPECT.md]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adaptFreqtradeBacktest } from "../src/audit/adapters/freqtrade.js";
import { runAudit } from "../src/audit/audit-run.js";

const get = (flag: string, def: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const MAX_REPOS = parseInt(get("--max-repos", "18"), 10);
const MAX_JSON_PER_REPO = parseInt(get("--max-json-per-repo", "1"), 10);
const REPOS_ARG = get("--repos", "");
const OUT_DIR = get("--out", "data/prospect");
const MD_PATH = get("--md", "docs/AUDITS_PROSPECT.md");
const CACHE_DIR = join(OUT_DIR, "cache");
const GH = "https://api.github.com";

const QUERIES = [
  "freqtrade backtest",
  "freqtrade strategy",
  "freqtrade bot",
  "grid bot backtest",
  "crypto trading bot backtest",
  "binance trading bot strategy",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Cache en disco de respuestas de la API (evita re-gastar cuota en re-runs). */
function cacheGet<T>(name: string): T | null {
  const path = join(CACHE_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}
function cacheSet(name: string, value: unknown): void {
  try {
    writeFileSync(join(CACHE_DIR, `${name}.json`), JSON.stringify(value), "utf-8");
  } catch {}
}
let apiRemaining: number | null = null;
let apiExhausted = false;

async function gh(path: string, accept = "application/vnd.github+json"): Promise<any | null> {
  if (apiExhausted) return null;
  try {
    const res = await fetch(`${GH}${path}`, {
      headers: { "User-Agent": "alpha-audit-prospector", Accept: accept },
      signal: AbortSignal.timeout(20_000),
    });
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining !== null) apiRemaining = Number(remaining);
    if (res.status === 403 || res.status === 429 || (apiRemaining !== null && apiRemaining <= 0)) {
      apiExhausted = true;
      console.warn(`[PROSPECT] Cuota de API agotada (${res.status}); se corta limpio y se reporta parcial.`);
      return null;
    }
    if (!res.ok) return null;
    return await res.json();
  } catch (err: any) {
    console.warn(`[PROSPECT] Error de red: ${err?.message || err}`);
    return null;
  }
}

async function raw(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "alpha-audit-prospector" }, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

interface RepoInfo {
  fullName: string;
  stars: number;
  description: string;
  branch: string;
  updated: string;
}

interface ProspectResult {
  repo: string;
  stars: number;
  updated: string;
  status: "AUDITABLE" | "SOLO_AGREGADOS" | "SOLO_CAPTURAS" | "FIXTURE" | "SIN_DATOS" | "JSON_INVALIDO" | "ERROR";
  strategy?: string;
  trades?: number;
  window?: { from: string | null; to: string | null };
  netPct?: number | null;
  profitFactor?: number | null;
  winRatePct?: number;
  breakevenWinRatePct?: number;
  feesOverGrossPct?: number | null;
  bestTradeSharePct?: number | null;
  bootstrapCi?: [number, number];
  binomialPValue?: number;
  positiveFolds?: string;
  verdict?: string;
  reported?: { profitAbs?: number; profitFactor?: number; winrate?: number; maxDrawdown?: number };
  jsonFiles?: number;
  txtReports?: number;
  note?: string;
}

function pct(part: number, total: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total === 0) return null;
  return Math.round((part / total) * 1000) / 10;
}

async function inspectRepo(repo: RepoInfo): Promise<ProspectResult[]> {
  const base: ProspectResult = {
    repo: repo.fullName,
    stars: repo.stars,
    updated: repo.updated,
    status: "SIN_DATOS",
    note: repo.description.slice(0, 140),
  };

  let tree = null;
  const candidates = repo.branch ? [repo.branch] : [];
  for (const b of ["develop", "main", "master"]) if (!candidates.includes(b)) candidates.push(b);
  for (const b of candidates) {
    const cacheKey = `tree_${repo.fullName.replace("/", "__")}__${b}`;
    const cached = cacheGet<any>(cacheKey);
    if (cached?.tree) {
      tree = cached;
      repo.branch = b;
      break;
    }
    tree = await gh(`/repos/${repo.fullName}/git/trees/${b}?recursive=1`);
    if (tree?.tree) {
      repo.branch = b;
      cacheSet(cacheKey, tree);
      break;
    }
    if (apiExhausted) break;
  }
  if (!tree?.tree) return [{ ...base, status: "ERROR", note: "arbol no disponible" }];
  const files: Array<{ path: string; size: number }> = tree.tree
    .filter((t: any) => t.type === "blob")
    .map((t: any) => ({ path: t.path, size: t.size ?? 0 }));

  const jsonFiles = files.filter(
    (f) =>
      f.size > 5_000 &&
      (/(^|\/)backtest-result[^/]*\.json$/i.test(f.path) || /backtest_results\/[^/]+\.json$/i.test(f.path))
  );
  const txtReports = files.filter((f) => /\.txt$/i.test(f.path) && /backtest/i.test(f.path));
  const images = files.filter((f) => /\.(png|jpg|jpeg|gif)$/i.test(f.path));
  base.jsonFiles = jsonFiles.length;
  base.txtReports = txtReports.length;

  if (jsonFiles.length === 0) {
    if (txtReports.length > 0) {
      return [{ ...base, status: "SOLO_AGREGADOS", note: `${txtReports.length} reportes .txt sin trades individuales` }];
    }
    // Sin archivos de datos: si el README habla de backtests y hay capturas, es "solo capturas".
    const readme = files.find((f) => /^readme\.md$/i.test(f.path));
    if (readme && images.length > 0) {
      const text = await raw(`https://raw.githubusercontent.com/${repo.fullName}/${repo.branch}/${readme.path}`);
      if (text && /backtest|results|profit/i.test(text)) {
        return [{ ...base, status: "SOLO_CAPTURAS", note: `${images.length} imagenes y README sin datos legibles` }];
      }
    }
    return [{ ...base, status: "SIN_DATOS" }];
  }

  // Hasta MAX_JSON_PER_REPO archivos, del mas grande al mas chico (mas trades probables).
  const chosenList = jsonFiles.sort((a, b) => b.size - a.size).slice(0, MAX_JSON_PER_REPO);
  const rows: ProspectResult[] = [];
  for (const chosen of chosenList) {
    if (chosen.size > 20_000_000) {
      rows.push({ ...base, status: "SIN_DATOS", note: "JSON demasiado grande (>20MB)" });
      continue;
    }
    const url = `https://raw.githubusercontent.com/${repo.fullName}/${repo.branch}/${encodeURI(chosen.path)}`;
    const text = await raw(url);
    if (!text) {
      rows.push({ ...base, status: "ERROR", note: "no se pudo descargar el JSON" });
      continue;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      rows.push({ ...base, status: "JSON_INVALIDO", note: chosen.path });
      continue;
    }
    let adapted;
    try {
      adapted = adaptFreqtradeBacktest(parsed, undefined, chosen.path);
    } catch (err: any) {
      rows.push({ ...base, status: "JSON_INVALIDO", note: `${chosen.path}: ${err?.message || err}` });
      continue;
    }

    // Datos sinteticos de test (fixtures del repo del framework): no son una estrategia.
    const zeroShare = adapted.dataset.trades.filter((t) => t.netPnlUsd === 0).length / Math.max(1, adapted.dataset.trades.length);
    if (/test/i.test(adapted.strategy) || zeroShare > 0.5) {
      rows.push({
        ...base,
        status: "FIXTURE",
        strategy: adapted.strategy,
        trades: adapted.dataset.trades.length,
        note: `${chosen.path} | datos sinteticos de test (${Math.round(zeroShare * 100)}% con PnL 0)`,
      });
      continue;
    }

    const capital = adapted.meta.startingBalance ?? 1000;
    const audit = runAudit(adapted.dataset, { capitalUsd: capital, folds: 4 });
    const pnls = adapted.dataset.trades.map((t) => t.netPnlUsd);
    const total = pnls.reduce((a, v) => a + v, 0);
    const best = Math.max(...pnls);
    const feesShare = adapted.meta.grossUsd > 0 ? pct(adapted.meta.feesUsd, adapted.meta.grossUsd) : null;

    rows.push({
      ...base,
      status: "AUDITABLE",
      strategy: adapted.strategy,
      trades: adapted.dataset.trades.length,
      window: { from: adapted.meta.from, to: adapted.meta.to },
      netPct: capital > 0 ? pct(adapted.meta.netUsd, capital) : null,
      profitFactor: audit.sample?.profitFactor ?? adapted.meta.reportedProfitFactor ?? null,
      winRatePct: audit.sample?.winRatePct,
      breakevenWinRatePct: audit.sample?.breakevenWinRatePct,
      feesOverGrossPct: feesShare,
      bestTradeSharePct: total !== 0 ? Math.round((best / total) * 1000) / 10 : null,
      bootstrapCi: audit.inference ? [audit.inference.bootstrap.ci95LowUsd, audit.inference.bootstrap.ci95HighUsd] : undefined,
      binomialPValue: audit.inference?.binomialPValue,
      positiveFolds: audit.walkForward ? `${audit.walkForward.positiveFolds}/${audit.walkForward.folds}` : undefined,
      verdict: audit.verdict,
      reported: {
        profitAbs: adapted.meta.reportedProfitAbs,
        profitFactor: adapted.meta.reportedProfitFactor,
        winrate: adapted.meta.reportedWinrate,
        maxDrawdown: adapted.meta.reportedMaxDrawdown,
      },
      note: `${chosen.path} | ${adapted.strategies.length} estrategia(s)`,
    });
  }
  return rows;
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  const repos = new Map<string, RepoInfo>();
  if (REPOS_ARG.trim()) {
    for (const spec of REPOS_ARG.split(",").map((x) => x.trim()).filter(Boolean)) {
      const [full, branch] = spec.split("@");
      let stars = 0;
      let defaultBranch = branch || "";
      let desc = "";
      let updated = "";
      const cacheKey = `meta_${full.replace("/", "__")}`;
      let meta = cacheGet<any>(cacheKey);
      const lowBudget = apiRemaining !== null && apiRemaining < repos.size * 2 + 3;
      if (!meta && !lowBudget) {
        meta = await gh(`/repos/${full}`);
        if (meta) cacheSet(cacheKey, { stargazers_count: meta.stargazers_count, default_branch: meta.default_branch, description: meta.description, updated_at: meta.updated_at });
      }
      if (meta) {
        stars = meta.stargazers_count ?? 0;
        defaultBranch = branch || meta.default_branch || "";
        desc = meta.description ?? "";
        updated = meta.updated_at ?? "";
      }
      repos.set(full, { fullName: full, stars, description: desc, branch: defaultBranch, updated });
      await sleep(250);
    }
  }
  for (const q of QUERIES) {
    if (REPOS_ARG.trim()) break;
    if (repos.size >= MAX_REPOS || apiExhausted) break;
    const j = await gh(`/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=8`);
    await sleep(400);
    for (const it of j?.items ?? []) {
      if (repos.size >= MAX_REPOS) break;
      const key = it.full_name as string;
      if (!repos.has(key)) {
        repos.set(key, {
          fullName: key,
          stars: it.stargazers_count ?? 0,
          description: it.description ?? "",
          branch: it.default_branch ?? "main",
          updated: it.updated_at ?? "",
        });
      }
    }
  }

  console.log(`[PROSPECT] Repos a inspeccionar: ${repos.size} (API restante: ${apiRemaining ?? "n/d"})`);
  const results: ProspectResult[] = [];
  for (const repo of repos.values()) {
    if (apiExhausted && !REPOS_ARG.trim()) {
      results.push({ repo: repo.fullName, stars: repo.stars, updated: repo.updated, status: "ERROR", note: "no inspeccionado (cuota de API)" });
      continue;
    }
    const rows = await inspectRepo(repo);
    for (const r of rows) {
      results.push(r);
      console.log(
        `  ${r.status.padEnd(16)} ${r.repo.padEnd(44)} ${r.trades ? `n=${r.trades}` : ""} ${r.verdict ? `-> ${r.verdict}` : ""} ${r.note && r.status !== "AUDITABLE" ? `(${r.note})` : ""}`
      );
    }
    await sleep(350);
  }

  const auditable = results.filter((r) => r.status === "AUDITABLE");
  const aggregates = results.filter((r) => r.status === "SOLO_AGREGADOS");
  const summary = {
    generatedAt: new Date().toISOString(),
    partial: apiExhausted,
    apiRemaining,
    reposScanned: results.length,
    auditable: auditable.length,
    aggregatesOnly: aggregates.length,
    noData: results.filter((r) => r.status === "SIN_DATOS").length,
    capturesOnly: results.filter((r) => r.status === "SOLO_CAPTURAS").length,
    fixtures: results.filter((r) => r.status === "FIXTURE").length,
    errors: results.filter((r) => r.status === "ERROR" || r.status === "JSON_INVALIDO").length,
    verdicts: auditable.reduce<Record<string, number>>((acc, r) => {
      acc[r.verdict ?? "?"] = (acc[r.verdict ?? "?"] ?? 0) + 1;
      return acc;
    }, {}),
    medianFeesOverGrossPct: (() => {
      const vals = auditable.map((r) => r.feesOverGrossPct).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
      return vals.length ? vals[Math.floor(vals.length / 2)] : null;
    })(),
  };

  const outJson = join(OUT_DIR, "freqtrade_prospect.json");
  writeFileSync(outJson, JSON.stringify({ summary, results }, null, 2), "utf-8");

  const md: string[] = [];
  md.push("# Prospeccion de bots publicos con backtests auditables (2026-10-24)");
  md.push("");
  md.push("Datos publicos de GitHub, solo lectura. **Todos los casos son backtests: in-sample.**");
  md.push("Un veredicto aqui mide robustez interna del backtest, no evidencia out-of-sample.");
  md.push("");
  md.push("## Resumen");
  md.push("");
  md.push(`- Repos inspeccionados: **${summary.reposScanned}**${summary.partial ? " (parcial: cuota de API agotada)" : ""}`);
  md.push(`- Con trades individuales (auditables): **${summary.auditable}**`);
  md.push(`- Solo agregados (\`.txt\`): **${summary.aggregatesOnly}**`);
  md.push(`- Solo capturas/README: **${summary.capturesOnly}**`);
  md.push(`- Datos sinteticos de test (fixtures, no estrategias): **${summary.fixtures}**`);
  md.push(`- Sin datos / errores: **${summary.noData + summary.errors}**`);
  md.push(`- Veredictos: ${Object.entries(summary.verdicts).map(([k, v]) => `${k}=${v}`).join(", ") || "n/d"}`);
  md.push(`- Fees como % del bruto (mediana de los auditables): **${summary.medianFeesOverGrossPct ?? "n/d"}%**`);
  md.push("");
  if (auditable.length) {
    md.push("## Auditables");
    md.push("");
    md.push("| Repo | Estrellas | Estrategia | n | Neto % | PF | WR vs BE | Fees/bruto | Bootstrap IC95% | p binomial | Folds | Veredicto |");
    md.push("|---|---:|---|---:|---:|---:|---:|---:|---|---:|---|---|");
    for (const r of auditable.sort((a, b) => (b.trades ?? 0) - (a.trades ?? 0))) {
      md.push(
        `| ${r.repo} | ${r.stars} | ${r.strategy} | ${r.trades} | ${r.netPct ?? "n/d"} | ${r.profitFactor ?? "n/d"} | ${r.winRatePct ?? "?"}% vs ${r.breakevenWinRatePct ?? "?"}% | ${r.feesOverGrossPct ?? "n/d"}% | [${r.bootstrapCi?.map((v) => v.toFixed(3)).join(", ")}] | ${r.binomialPValue} | ${r.positiveFolds} | **${r.verdict}** |`
      );
    }
    md.push("");
  }
  const fixtures = results.filter((r) => r.status === "FIXTURE");
  if (fixtures.length) {
    md.push("## Fixtures (no son estrategias)");
    md.push("");
    for (const r of fixtures) md.push(`- ${r.repo} — ${r.strategy} (${r.trades} trades) · ${r.note ?? ""}`);
    md.push("");
  }
  const captures = results.filter((r) => r.status === "SOLO_CAPTURAS");
  if (captures.length) {
    md.push("## Solo capturas / README (no auditables)");
    md.push("");
    for (const r of captures) md.push(`- ${r.repo} — ${r.note ?? ""}`);
    md.push("");
  }
  if (aggregates.length) {
    md.push("## Solo agregados (no auditables)");
    md.push("");
    md.push("| Repo | Estrellas | Reportes .txt | Nota |");
    md.push("|---|---:|---:|---|");
    for (const r of aggregates) md.push(`| ${r.repo} | ${r.stars} | ${r.txtReports} | ${r.note ?? ""} |`);
    md.push("");
  }
  md.push("## Metodo");
  md.push("");
  md.push("1. Busqueda de repos por consultas de bots/backtests; arbol de cada repo por API.");
  md.push("2. Deteccion de `backtest-result*.json` (trades) y de reportes `.txt` (agregados).");
  md.push("3. Descarga de **1 JSON por repo** (el mas grande), adaptado con `adaptFreqtradeBacktest` (fees derivadas de `fee_open`/`fee_close`) y auditado con `runAudit`.");
  md.push("4. Reglas: pausas de cortesia, corte limpio al agotar la cuota, sin datos privados.");
  md.push("");
  md.push("## Lectura");
  md.push("");
  md.push(
    `De ${summary.reposScanned} repos inspeccionados, **${summary.auditable}** publican trades individuales auditables, **${summary.aggregatesOnly + summary.capturesOnly}** publican solo agregados o capturas y **${summary.fixtures}** son fixtures de test. Es decir: **la mayoria de los bots publicos no publica lo que hace falta para auditarlos**.`
  );
  md.push("");
  md.push(
    `En los auditables, las fees consumieron una mediana de **${summary.medianFeesOverGrossPct ?? "n/d"}%** del PnL bruto. Ese es el hallazgo repetido: el coste de operar se lleva la mayor parte de lo que el backtest muestra como ganancia, y el veredicto estadistico (muestras chicas) no alcanza para afirmar ventaja.`
  );
  md.push("");
  const highWrNegative = auditable.filter(
    (r) => (r.winRatePct ?? 0) > 60 && (r.breakevenWinRatePct ?? 0) > (r.winRatePct ?? 0)
  );
  md.push("## Hallazgo transversal");
  md.push("");
  md.push(
    `${highWrNegative.length} de ${auditable.length} datasets auditables tienen **win rate > 60% y breakeven por encima del observado**: el patron repetido es "gana muchas veces, pierde mas por vez". El win rate alto es la parte visible; la expectancy negativa, la que importa.`
  );
  md.push("");
  md.push("## Limites");
  md.push("");
  md.push("- Backtests in-sample; muchas veces optimizados por el autor sobre el mismo periodo.");
  md.push("- Muestras chicas (decenas de trades) y estrategias distintas entre repos: no se comparan entre si como si fueran un ranking de calidad.");
  md.push("- Solo se audita el primer JSON de cada repo; puede no ser la version que el autor considera vigente.");
  md.push("- Los repos 'solo agregados' no se auditan: el kit no emite veredicto sin trades.");
  md.push("");
  if (!existsSync(MD_PATH)) mkdirSync(MD_PATH.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  writeFileSync(MD_PATH, md.join("\n"), "utf-8");

  console.log(`\n[PROSPECT] JSON: ${outJson}`);
  console.log(`[PROSPECT] Markdown: ${MD_PATH}`);
  console.log(
    `[PROSPECT] ${summary.reposScanned} repos | ${summary.auditable} auditables | ${summary.aggregatesOnly} solo agregados | veredictos ${JSON.stringify(summary.verdicts)}`
  );
}

main().catch((err) => {
  console.error("[PROSPECT ERROR]", err);
  process.exit(1);
});
