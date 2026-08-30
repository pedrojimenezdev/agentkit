import type { LLM, ChatMessage, LLMReply } from "./llm.ts";
import { executeTool, toolSchema, type Tool } from "./tools.ts";
import type { Budget } from "./budget.ts";

export interface AgentOptions {
  llm: LLM;
  tools?: Tool<any, unknown>[];
  /** Max model→tool→model iterations (default 8). A runaway agent is a bill. */
  maxSteps?: number;
  system: string;
  /**
   * Callback per step — hook for logging/metrics. Return true to stop early.
   */
  onStep?: (step: { step: number; messages: ChatMessage[]; reply: LLMReply }) => boolean | void;
  /** Budget guardrail — when exhausted, the loop stops before another call. */
  budget?: Budget;
  signal?: AbortSignal;
}

/**
 * The agent loop: system → model → (tool calls) → execute → append → repeat,
 * until the model answers without tool calls, steps run out, or the budget
 * stops it. Deliberately small — the production value is in *what you wrap*
 * (tools + retrieval + cost caps), not a framework.
 */
export async function agent(opts: AgentOptions): Promise<string> {
  const maxSteps = opts.maxSteps ?? 8;
  const messages: ChatMessage[] = [{ role: "system", content: opts.system }];
  let final = "";

  for (let step = 0; step < maxSteps; step++) {
    opts.budget?.check();

    const reply = await opts.llm.complete(messages, {
      tools: opts.tools?.length ? opts.tools.map(toolSchema) : undefined,
      signal: opts.signal,
    });
    opts.budget?.record(reply.usage ?? { input: 0, output: 0 });

    messages.push({ role: "assistant", content: reply.text });
    opts.onStep?.({ step, messages, reply });
    if (opts.onStep?.({ step, messages, reply }) === true) break;

    if (!reply.toolCalls?.length) {
      final = reply.text;
      break;
    }

    for (const tc of reply.toolCalls) {
      const outcome = await executeTool(opts.tools ?? ([] as Tool<any, unknown>[]), tc.name, tc.arguments);
      messages.push({
        role: "tool",
        // Match the tool-call id when a provider wants one; plain text otherwise.
        content: JSON.stringify({ ok: outcome.ok, result: outcome.result }),
      });
    }
    if (step === maxSteps - 1) final = reply.text;
  }

  return final;
}
