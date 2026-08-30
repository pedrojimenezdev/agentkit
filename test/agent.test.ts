import { test } from "node:test";
import assert from "node:assert/strict";
import { agent } from "../src/agent.ts";
import { Budget } from "../src/budget.ts";
import type { LLM, LLMReply, ToolCallResult } from "../src/llm.ts";
import { defineTool, parseToolArguments, executeTool } from "../src/tools.ts";

// A scripted LLM that returns tool calls on step 0 and a final answer on step 1.
function scriptedLLM(steps: (LLMReply)[]): LLM {
  let i = 0;
  return {
    async complete() {
      const r = steps[Math.min(i, steps.length - 1)];
      i++;
      return r;
    },
  };
}

test("parseToolArguments tolerates garbage", () => {
  assert.deepEqual(parseToolArguments("not json"), {});
  assert.deepEqual(parseToolArguments('[1,2]'), {});
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseToolArguments(""), {});
});

test("executeTool returns a clean outcome", async () => {
  const double = defineTool<{ n: number }>({
    name: "double",
    description: "double a number",
    parameters: { type: "object", properties: { n: { type: "number" } } },
    run: ({ n }) => n * 2,
  });
  const ok = await executeTool([double], "double", '{"n":21}');
  assert.equal(ok.ok, true);
  assert.equal(ok.result, 42);
  const missing = await executeTool([double], "nope", "");
  assert.equal(missing.ok, false);
});

test("agent runs loop until the model stops calling tools", async () => {
  const search = defineTool<{ q: string }>({
    name: "search",
    description: "search",
    parameters: { type: "object", properties: { q: { type: "string" } } },
    run: ({ q }) => `result for ${q}`,
  });
  const llm = scriptedLLM([
    { text: "", toolCalls: [{ id: "1", name: "search", arguments: '{"q":"dogs"}' }] as ToolCallResult[], usage: { input: 1, output: 1 } },
    { text: "dogs are great", usage: { input: 1, output: 1 } },
  ]);
  const out = await agent({
    llm,
    tools: [search],
    system: "You answer questions.",
  });
  assert.equal(out, "dogs are great");
});

test("budget stops a runaway agent", async () => {
  const llm = scriptedLLM([
    { text: "", toolCalls: [{ id: "1", name: "x", arguments: "{}" } as ToolCallResult, { id: "2", name: "y", arguments: "{}" } as ToolCallResult], usage: { input: 100, output: 100 } },
    { text: "still going", usage: { input: 100, output: 100 } },
  ]);
  const budget = new Budget({ maxTokens: 150 });
  await assert.rejects(
    () =>
      agent({
        llm,
        tools: [],
        system: "s",
        maxSteps: 4,
        budget,
      }),
    /Budget exceeded/,
  );
});

test("budget records cost and retry backs off", async () => {
  const b = new Budget({ inputCostPerM: 1, outputCostPerM: 2 });
  b.record({ input: 1_000_000, output: 500_000 });
  assert.equal(b.spent.cost, 2);
  b.check();
});
