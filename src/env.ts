/**
 * Type-safe environment parsing with two things agents actually need:
 *  - secret-stripping (a `#` comment terminates a value — the pattern the
 *    Social Command Center uses so a trailing comment never leaks into a key)
 *  - zod-style validation without the dependency, so it's zero-dep
 */
type Field = {
  required?: boolean;
  default?: string;
  /** "secret" values are stripped of anything after `#` in the source line. */
  sensitive?: boolean;
};

type Schema = Record<string, Field>;

/** Validate process.env against a Schema. Throws on a missing required field. */
export function env<T extends Record<string, string | undefined>>(schema: Schema): T {
  const out: Record<string, string | undefined> = {};
  for (const [key, field] of Object.entries(schema)) {
    const raw = process.env[key];
    const value = field.sensitive && raw ? raw.split("#")[0]!.trim() : raw?.trim();
    if ((!value || value === "") && field.default !== undefined) {
      out[key] = field.default;
    } else if (!value && field.required) {
      throw new Error(`Missing required env var: ${key}`);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Redact secrets before logging/printing — never echo an API key. */
export function redact(record: Record<string, unknown>, sensitiveKeys: string[]): Record<string, unknown> {
  const out = { ...record };
  for (const k of sensitiveKeys) {
    if (typeof out[k] === "string" && (out[k] as string).length > 0) {
      out[k] = `${(out[k] as string).slice(0, 3)}…(${(out[k] as string).length})`;
    }
  }
  return out;
}
