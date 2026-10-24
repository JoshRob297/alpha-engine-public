import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface LayaState {
  readonly [key: string]: unknown;
}

export interface LayaChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Record<string, string>;
}

export interface LayaNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
}

export interface LayaDecisionRequest {
  readonly state: LayaState;
  readonly questions: Record<string, LayaChoiceQuestion | LayaNoulQuestion>;
  readonly model?: string;
}

export interface LayaChoiceAnswer {
  readonly choice: string;
  readonly confidence: number;
}

export interface LayaNoulAnswer {
  readonly noul: number;
}

export interface LayaJudgments {
  readonly toxicFlow: number | null;
  readonly regimeStress: number | null;
  readonly meanReversion: number | null;
  readonly ok: boolean;
  readonly failure: string | null;
}

/**
 * Consulta Laya System 1 Decision Engine en compute-node via decide CLI
 */
export async function evaluateMarketState(
  state: LayaState,
  timeoutMs = 5000
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
  const escapedPayload = payload.replace(/'/g, "'\\''");

  try {
    const { stdout } = await execAsync(
      `/usr/local/bin/decide -s '${escapedPayload}' -q '{}'`,
      { timeout: timeoutMs }
    );

    const parsed = JSON.parse(stdout);
    const answers = parsed.answers || parsed;

    return {
      toxicFlow: typeof answers.toxic_flow?.noul === "number" ? answers.toxic_flow.noul : null,
      regimeStress: typeof answers.regime_stress?.noul === "number" ? answers.regime_stress.noul : null,
      meanReversion: typeof answers.mean_reversion?.noul === "number" ? answers.mean_reversion.noul : null,
      ok: true,
      failure: null,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      toxicFlow: null,
      regimeStress: null,
      meanReversion: null,
      ok: false,
      failure: errorMsg.includes("timeout") ? "timeout" : "error",
    };
  }
}
