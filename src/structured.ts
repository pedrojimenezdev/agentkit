import type { LLM, ChatMessage } from "./llm.ts";

/** The slice of a Zod schema this library actually uses. Structural typing
 *  only — any object with a matching `safeParse` works, so Zod (or Valibot,
 *  or a hand-rolled parser) stays out of the dependency list. */
export interface ParseSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } };
}

export type Validator<T> = (value: unknown) => { ok: true; value: T } | { ok: false; error?: string };

export interface StructuredOptions<T> {
  messages: (system: string) => ChatMessage[];
  system: string;
  /**
   * Predicate validator. Ignored when `schema` is also passed — `schema` wins,
   * so the two never disagree about what shape is acceptable.
   */
  validate?: Validator<T>;
  /** A Zod-compatible schema, used in preference to `validate` when both are given. */
  schema?: ParseSchema<T>;
  /** Max attempts before giving up (default 2). */
  attempts?: number;
  temperature?: number;
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

/** Resolve the two ways of describing a valid shape into one predicate.
 *  `schema` takes precedence over `validate` when both are supplied. */
function toValidator<T>(opts: StructuredOptions<T>): Validator<T> {
  const { schema } = opts;
  if (schema) {
    return (value: unknown) => {
      const result = schema.safeParse(value);
      return result.success
        ? { ok: true, value: result.data }
        : { ok: false, error: result.error?.message ?? "failed schema validation" };
    };
  }
  if (opts.validate) return opts.validate;
  throw new Error("structured(): pass either a `schema` or a `validate` function");
}

/**
 * Reliable structured output from an LLM. The hard part of production agents is
 * not the model — it's the model *sometimes* returning prose or a broken shape.
 * This wraps that: ask for JSON, validate, and on a miss re-ask with the exact
 * error so the model can self-correct.
 *
 * Validation comes from either a `schema` (anything with Zod's `safeParse`) or a
 * `validate` predicate. If both are passed, `schema` is used and `validate` is
 * ignored. The library stays dependency-free either way.
 */
export async function structured<T>(llm: LLM, opts: StructuredOptions<T>): Promise<T> {
  const validate = toValidator(opts);
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
    const check = validate(parsed);
    if (check.ok) return check.value;
    lastError = check.error ?? "failed validation";
  }
  throw new Error(`structured(): exhausted ${attempts} attempts — ${lastError}`);
}
