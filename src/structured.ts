import type { LLM, ChatMessage } from "./llm.ts";

export interface StructuredOptions {
  /** Max attempts before giving up (default 2). */
  attempts?: number;
  temperature?: number;
  /** Extra guidance appended to the system prompt. */
  extra?: string;
  signal?: AbortSignal;
}

const FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

/** Strip markdown fences and any prose — the model is told to emit only JSON but
 *  often doesn't. Be lenient on the way in, strict on the way out. */
export function extractJson(text: string): string {
  const fenced = FENCE_RE.exec(text.trim());
  if (fenced) return fenced[1].trim();
  // Fall back to the outermost `{...}` or `[...]` block if anything is wrapped.
  const start = Math.min(...["{", "["].map((c) => text.indexOf(c)).filter((i) => i >= 0));
  if (Number.isFinite(start)) {
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    const end = text.lastIndexOf(close);
    if (end > start) return text.slice(start, end + 1);
  }
  return text.trim();
}

/**
 * Reliable structured output from an LLM. The hard part of production agents is
 * not the model — it's the model *sometimes* returning prose or a broken shape.
 * This wraps that: ask for JSON, validate against a zod-ish schema, and on a
 * miss re-ask once with the exact error so it can self-correct.
 *
 * `validate` is a predicate + the schema name for the corrective message. Pass a
 * real zod or json-schema validator; the library stays dependency-free.
 */
export async function structured<T>(
  llm: LLM,
  opts: {
    messages: (system: string) => ChatMessage[];
    system: string;
    validate: (value: unknown) => { ok: true; value: T } | { ok: false; error?: string };
    attempts?: number;
    temperature?: number;
    signal?: AbortSignal;
  },
): Promise<T> {
  const attempts = opts.attempts ?? 2;
  let lastError = "";
  for (let i = 0; i < attempts; i++) {
    const system =
      opts.system +
      "\n\nResponse rules: return ONLY a single valid JSON value. No markdown fences, no code blocks, no prose before or after. If asked for a record, use double-quoted keys and strings.";
    const messages = opts.messages(system);
    if (lastError) {
      messages.push({
        role: "user",
        content: `Your previous response was not valid for this task: ${lastError}\n\nReturn ONLY a corrected JSON value.`,
      });
    }
    const reply = await llm.complete(messages, { temperature: opts.temperature ?? 0, signal: opts.signal });
    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(reply.text));
    } catch (err) {
      lastError = `not valid JSON (${(err as Error).message})`;
      continue;
    }
    const check = opts.validate(parsed);
    if (check.ok) return check.value;
    lastError = check.error ?? "failed validation";
  }
  throw new Error(`structured(): exhausted ${attempts} attempts — ${lastError}`);
}
