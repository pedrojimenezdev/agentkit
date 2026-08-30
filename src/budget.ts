/**
 * Cost/token guardrails — the "boring but necessary" part that keeps a runaway
 * agent from being a bill. A `Budget` is a hard ceiling: check before each
 * model call, record what was spent, throw the moment it's blown.
 */
export interface BudgetLimits {
  maxTokens?: number;
  maxCostUsd?: number;
  /** Price per 1M tokens, for cost accounting. */
  inputCostPerM?: number;
  outputCostPerM?: number;
}

export class Budget {
  private limits: Required<Pick<BudgetLimits, "inputCostPerM" | "outputCostPerM">> & BudgetLimits;
  private used = { input: 0, output: 0, cost: 0 };

  constructor(limits: BudgetLimits) {
    this.limits = {
      inputCostPerM: limits.inputCostPerM ?? 0.5,
      outputCostPerM: limits.outputCostPerM ?? 1.5,
      ...limits,
    };
  }

  /** Throws if we're already at/over a ceiling — call before a model call. */
  check(): void {
    const { maxTokens, maxCostUsd } = this.limits;
    if (maxTokens !== undefined && this.used.input + this.used.output >= maxTokens) {
      throw new Error(`Budget exceeded: ${this.used.input + this.used.output} tokens >= ${maxTokens}`);
    }
    if (maxCostUsd !== undefined && this.used.cost >= maxCostUsd) {
      throw new Error(`Budget exceeded: $${this.used.cost.toFixed(4)} >= $${maxCostUsd}`);
    }
  }

  /** Record a model call's usage. */
  record(usage: { input: number; output: number }): void {
    this.used.input += usage.input;
    this.used.output += usage.output;
    this.used.cost +=
      (usage.input / 1_000_000) * this.limits.inputCostPerM +
      (usage.output / 1_000_000) * this.limits.outputCostPerM;
  }

  get spent() {
    return { ...this.used };
  }
}

/** Retry a call with exponential backoff + jitter, for transient failures. */
export async function retry<T>(fn: () => Promise<T>, opts?: { attempts?: number; baseMs?: number; maxMs?: number; shouldRetry?: (e: unknown) => boolean }): Promise<T> {
  const attempts = opts?.attempts ?? 3;
  const baseMs = opts?.baseMs ?? 150;
  const maxMs = opts?.maxMs ?? 5000;
  const shouldRetry = opts?.shouldRetry ?? (() => true);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !shouldRetry(err)) throw err;
      const backoff = Math.min(maxMs, baseMs * 2 ** i) + Math.random() * baseMs;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}
