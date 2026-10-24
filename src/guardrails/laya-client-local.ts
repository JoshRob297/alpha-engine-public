import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface LayaState {
  readonly [key: string]: unknown;
}

export interface LayaJudgments {
  readonly toxicFlow: number | null;
  readonly regimeStress: number | null;
  readonly meanReversion: number | null;
  readonly ok: boolean;
  readonly failure: string | null;
}

/**
 * Consulta Laya System 1 Decision Engine en localhost (sub-milisegundo en compute-node)
 * Si falla o hay timeout (>150ms), activa FAIL-SAFE defensivo (toxicFlow = 1.0)
 */
export async function evaluateMarketStateLocal(
  state: LayaState,
  timeoutMs = 150
): Promise<LayaJudgments> {
  const questions = {
    toxic_flow: {
      type: "noul",
      instructions: "Is this aggressive/informed directional volume that will cause adverse selection?",
    },
    regime_stress: {
      type: "noul",
      instructions: "Is this book in systemic stress or abnormal spread expansion where quoting should pause?",
    },
    mean_reversion: {
      type: "noul",
      instructions: "Is the current price excursion likely to mean-revert within the near-term window?",
    },
  };

  const payload = JSON.stringify({ state, questions });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("http://127.0.0.1:8088/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`Laya HTTP status ${res.status}`);
    }

    const parsed = (await res.json()) as any;
    const answers = parsed.answers || parsed;

    return {
      toxicFlow: typeof answers.toxic_flow?.noul === "number" ? answers.toxic_flow.noul : null,
      regimeStress: typeof answers.regime_stress?.noul === "number" ? answers.regime_stress.noul : null,
      meanReversion: typeof answers.mean_reversion?.noul === "number" ? answers.mean_reversion.noul : null,
      ok: true,
      failure: null,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    // FAIL-SAFE DEFENSIVO: Si Laya no responde en el tiempo limite, asumimos toxicFlow = 1.0
    return {
      toxicFlow: 1.0,
      regimeStress: 1.0,
      meanReversion: 0.0,
      ok: false,
      failure: err instanceof Error ? err.message : String(err),
    };
  }
}
