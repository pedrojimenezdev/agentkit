import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, structured } from "../src/structured.ts";
import type { LLM } from "../src/llm.ts";

test("extractJson strips fences and prose", () => {
  assert.deepEqual(JSON.parse(extractJson('```json\n{"a":1}\n```')), { a: 1 });
  assert.deepEqual(JSON.parse(extractJson('Here you go: {"a":1} thanks')), { a: 1 });
  assert.deepEqual(JSON.parse(extractJson("[1,2]")), [1, 2]);
});

function mockLLM(responses: string[]): LLM {
  let i = 0;
  return {
    async complete() {
      const text = responses[Math.min(i, responses.length - 1)];
      i++;
      return { text, usage: { input: 10, output: 5 } };
    },
  };
}

interface User {
  name: string;
  age: number;
}

test("structured returns a validated value on first try", async () => {
  const llm = mockLLM(['{"name":"Pedro","age":30}']);
  const value = await structured<User>(llm, {
    system: "Return a user.",
    messages: (system) => [{ role: "system", content: system }, { role: "user", content: "x" }],
    validate: (v) =>
      v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string"
        ? { ok: true, value: v as User }
        : { ok: false, error: "missing name" },
  });
  assert.equal(value.name, "Pedro");
});

test("structured self-corrects once, then gives up", async () => {
  const llm = mockLLM(['"not json', '{"ok":1}']);
  const value = await structured<{ ok: number }>(llm, {
    system: "s",
    messages: (system) => [{ role: "system", content: system }],
    validate: (v) => ({ ok: true, value: v as { ok: number } }),
  });
  assert.deepEqual(value, { ok: 1 });
});
