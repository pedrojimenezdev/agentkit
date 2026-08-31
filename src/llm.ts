/**
 * LLM provider abstraction. A provider just turns messages into a reply —
 * swapping Anthropic / DeepSeek / OpenAI / a mock is a one-liner. This is the
 * seam that keeps the agent loop testable without a network.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** On assistant messages: the tool calls the model issued. */
  toolCalls?: ToolCallResult[];
  /** On tool messages: which assistant tool call this answers. */
  toolCallId?: string;
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
      // Serialize into the OpenAI-compatible wire format: assistant messages
      // carry `tool_calls`, tool messages carry `tool_call_id`. Dropping the
      // ids is what makes real providers reject the turn.
      const wire = messages.map((m) => {
        if (m.role === "assistant" && m.toolCalls?.length) {
          return {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            })),
          };
        }
        if (m.role === "tool") {
          return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
        }
        return { role: m.role, content: m.content };
      });
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: wire,
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

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  /** On tool_result blocks: which tool_use block this answers. */
  tool_use_id?: string;
  /** On tool_result blocks: the serialized tool outcome. */
  content?: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

/** Anthropic takes tool arguments as a JSON *object*, not the JSON string the
 *  OpenAI wire format uses. A misshapen string becomes `{}` rather than a
 *  request the API will reject outright. */
function toolInput(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Translate the shared ChatMessage history into Anthropic's block format:
 *  assistant tool calls become `tool_use` blocks, and tool results become
 *  `tool_result` blocks on a user turn. Dropping either half is what makes the
 *  API reject the next turn with "unexpected tool_use id". */
export function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "tool") {
      const block: AnthropicBlock = {
        type: "tool_result",
        tool_use_id: m.toolCallId ?? "",
        content: m.content,
      };
      // Every tool_result answering one assistant turn must ride in a single
      // user message, so append to the block list already being built.
      const prev = out[out.length - 1];
      if (prev && prev.role === "user" && Array.isArray(prev.content)) {
        prev.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (m.role === "assistant" && m.toolCalls?.length) {
      const content: AnthropicBlock[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: toolInput(tc.arguments) });
      }
      out.push({ role: "assistant", content });
      continue;
    }

    // Anthropic rejects empty-string content, so skip a contentless turn.
    if (!m.content) continue;
    out.push({ role: m.role as "user" | "assistant", content: m.content });
  }
  return out;
}

function anthropicToolCalls(content: AnthropicBlock[]): ToolCallResult[] | undefined {
  const uses = content.filter((c) => c.type === "tool_use");
  if (!uses.length) return undefined;
  return uses.map((c) => ({
    id: c.id ?? "",
    name: c.name ?? "",
    arguments: JSON.stringify(c.input ?? {}),
  }));
}

/** Fetch client for the Anthropic Messages API. */
export function createAnthropic(opts: { apiKey: string; model: string }): LLM {
  return {
    async complete(messages, o) {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      const body: Record<string, unknown> = {
        model: opts.model,
        max_tokens: o?.maxTokens ?? 1024,
        system: system || undefined,
        messages: toAnthropicMessages(messages),
      };
      if (o?.temperature !== undefined) body.temperature = o.temperature;
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
        content: AnthropicBlock[];
        usage?: { input_tokens: number; output_tokens: number };
      };
      const content = data.content ?? [];
      return {
        text: content.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""),
        toolCalls: anthropicToolCalls(content),
        usage: data.usage
          ? { input: data.usage.input_tokens, output: data.usage.output_tokens }
          : undefined,
      };
    },
  };
}
