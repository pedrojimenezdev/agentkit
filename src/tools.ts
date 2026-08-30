/**
 * Typed tool registry. Tools are the agent's hands — but the model hands them
 * *strings*, so the library never trusts the shape: it coerce-parses arguments
 * and lets a tool refuse cleanly.
 */
export interface Tool<TArgs = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  /** An example of the arguments (also used as the JSON schema for the LLM). */
  parameters: Record<string, unknown>;
  /** Runs the tool; thrown errors are surfaced to the agent as a failed call. */
  run: (args: TArgs) => Promise<TResult> | TResult;
}

export function defineTool<TArgs, TResult = unknown>(tool: Tool<TArgs, TResult>): Tool<TArgs, TResult> {
  return tool;
}

export function toolSchema(tool: Tool): { name: string; description: string; parameters: unknown } {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** Coerce the model's JSON-encoded arguments into an object. Never throws on a
 *  misshapen string — returns {} so the tool can decide. */
export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Execute a tool by name; wraps errors so the agent sees a readable failure. */
export async function executeTool(
  tools: Tool<any, unknown>[],
  name: string,
  rawArguments: string,
): Promise<{ ok: boolean; result: unknown }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, result: `Unknown tool: ${name}` };
  const args = parseToolArguments(rawArguments);
  try {
    return { ok: true, result: await tool.run(args as never) };
  } catch (err) {
    return { ok: false, result: `Tool ${name} failed: ${(err as Error).message}` };
  }
}
