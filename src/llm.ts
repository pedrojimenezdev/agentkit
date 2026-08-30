/**
 * LLM provider abstraction. A provider just turns messages into a reply —
 * swapping Anthropic / DeepSeek / OpenAI / a mock is a one-liner. This is the
 * seam that keeps the agent loop testable without a network.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ToolCallRequest {
  /** Tool name the model wants to run. */
  name: string;
  /** JSON-encoded arguments (the model may misshape them — tools must not trust). */
  arguments: string;
}

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: string;
}

export interface LLMReply {
  text: string;
  /** Present when the model requested one or more tool calls. */
  toolCalls?: ToolCallResult[];
  /** Number of tokens the call consumed (for budgeting). */
  usage?: { input: number; output: number };
}

export interface LLM {
  /** Single completion against a message list. */
  complete(messages: ChatMessage[], opts?: {
    temperature?: number;
    maxTokens?: number;
    tools?: { name: string; description: string; parameters: unknown }[];
    signal?: AbortSignal;
  }): Promise<LLMReply>;
}

/** A fetch-based client for the OpenAI-compatible chat completions API
 *  (DeepSeek, OpenRouter, vLLM, and OpenAI itself all speak this). */
export function createOpenAICompatible(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): LLM {
  return {
    async complete(messages, o) {
      const body: Record<string, unknown> = {
        model: opts.model,
        messages,
        temperature: o?.temperature ?? 0.2,
        max_tokens: o?.maxTokens ?? 1024,
      };
      if (o?.tools?.length) {
        body.tools = o.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }
      const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body),
        signal: o?.signal,
      });
      if (!res.ok) {
        throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        choices: { message: { content?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      const choice = data.choices[0];
      return {
        text: choice?.message?.content ?? "",
        toolCalls: choice?.message?.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })),
        usage: data.usage
          ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens }
          : undefined,
      };
    },
  };
}

/** Fetch client for the Anthropic Messages API. */
export function createAnthropic(opts: { apiKey: string; model: string }): LLM {
  return {
    async complete(messages, o) {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      const rest = messages.filter((m) => m.role !== "system");
      const body: Record<string, unknown> = {
        model: opts.model,
        max_tokens: o?.maxTokens ?? 1024,
        system: system || undefined,
        messages: rest
          .filter((m) => m.role !== "tool")
          .map((m) => ({ role: m.role, content: m.content })),
      };
      if (o?.tools?.length) {
        body.tools = o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      }
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: o?.signal,
      });
      if (!res.ok) {
        throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        content: { type: string; text?: string }[];
        usage?: { input_tokens: number; output_tokens: number };
      };
      return {
        text: data.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""),
        usage: data.usage
          ? { input: data.usage.input_tokens, output: data.usage.output_tokens }
          : undefined,
      };
    },
  };
}
