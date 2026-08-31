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

/** A Zod-shaped schema — structurally compatible, but not Zod. The point is
 *  that railguard never imports a validation library. */
function fakeUserSchema(): {
  safeParse(v: unknown): { success: true; data: User } | { success: false; error: { message: string } };
} {
  return {
    safeParse(v: unknown) {
      const o = v as Partial<User> | null;
      if (!o || typeof o !== "object") {
        return { success: false as const, error: { message: "Expected object, received " + typeof v } };
      }
      if (typeof o.name !== "string") {
        return { success: false as const, error: { message: "name: Expected string" } };
      }
      if (typeof o.age !== "number") {
        return { success: false as const, error: { message: "age: Expected number" } };
      }
      return { success: true as const, data: { name: o.name, age: o.age } };
    },
  };
}

test("structured accepts a Zod-compatible schema", async () => {
  const llm = mockLLM(['{"name":"Pedro","age":30}']);
  const value = await structured<User>(llm, {
    system: "Return a user.",
    messages: (system) => [{ role: "system", content: system }, { role: "user", content: "x" }],
    schema: fakeUserSchema(),
  });
  assert.deepEqual(value, { name: "Pedro", age: 30 });
});

test("structured self-corrects using the schema's error message", async () => {
  const seen: string[] = [];
  let i = 0;
  const responses = ['{"name":"Pedro"}', '{"name":"Pedro","age":30}'];
  const llm: LLM = {
    async complete(messages) {
      seen.push(messages[messages.length - 1].content);
      return { text: responses[Math.min(i++, responses.length - 1)] };
    },
  };

  const value = await structured<User>(llm, {
    system: "Return a user.",
    messages: (system) => [{ role: "system", content: system }, { role: "user", content: "x" }],
    schema: fakeUserSchema(),
  });

  assert.deepEqual(value, { name: "Pedro", age: 30 });
  // The corrective turn quotes the schema's own message back at the model.
  assert.match(seen[1], /age: Expected number/);
});

test("structured throws with the schema error after exhausting attempts", async () => {
  const llm = mockLLM(['{"name":"Pedro"}']);
  await assert.rejects(
    () =>
      structured<User>(llm, {
        system: "s",
        messages: (system) => [{ role: "system", content: system }],
        schema: fakeUserSchema(),
        attempts: 2,
      }),
    /exhausted 2 attempts — age: Expected number/,
  );
});

test("schema wins when both schema and validate are passed", async () => {
  const llm = mockLLM(['{"name":"Pedro","age":30}']);
  await assert.rejects(
    () =>
      structured<User>(llm, {
        system: "s",
        messages: (system) => [{ role: "system", content: system }],
        schema: {
          safeParse: () => ({ success: false as const, error: { message: "schema said no" } }),
        },
        // validate would accept — it must be ignored in favour of the schema
        validate: (v) => ({ ok: true as const, value: v as User }),
        attempts: 1,
      }),
    /schema said no/,
  );
});

test("structured refuses a call with neither schema nor validate", async () => {
  const llm = mockLLM(["{}"]);
  await assert.rejects(
    () =>
      structured<User>(llm, {
        system: "s",
        messages: (system) => [{ role: "system", content: system }],
      }),
    /pass either a `schema` or a `validate` function/,
  );
});
