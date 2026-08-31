import { test } from "node:test";
import assert from "node:assert/strict";
import { toAnthropicMessages } from "../src/llm.ts";
import type { ChatMessage } from "../src/llm.ts";

test("toAnthropicMessages turns assistant tool calls into tool_use blocks", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "be helpful" },
    { role: "user", content: "what is 6*7?" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "toolu_1", name: "multiply", arguments: '{"a":6,"b":7}' }],
    },
    { role: "tool", toolCallId: "toolu_1", content: '{"ok":true,"result":42}' },
  ];

  const out = toAnthropicMessages(messages);
  // system is hoisted out of the message list by the caller
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { role: "user", content: "what is 6*7?" });

  const assistant = out[1];
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.content, [
    { type: "tool_use", id: "toolu_1", name: "multiply", input: { a: 6, b: 7 } },
  ]);

  const result = out[2];
  assert.equal(result.role, "user");
  assert.deepEqual(result.content, [
    { type: "tool_result", tool_use_id: "toolu_1", content: '{"ok":true,"result":42}' },
  ]);
});

test("toAnthropicMessages groups sibling tool results into one user turn", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "working",
      toolCalls: [
        { id: "a", name: "one", arguments: "{}" },
        { id: "b", name: "two", arguments: "{}" },
      ],
    },
    { role: "tool", toolCallId: "a", content: "1" },
    { role: "tool", toolCallId: "b", content: "2" },
  ];

  const out = toAnthropicMessages(messages);
  assert.equal(out.length, 3);
  // text block first, then both tool_use blocks, in call order
  assert.deepEqual(out[1].content, [
    { type: "text", text: "working" },
    { type: "tool_use", id: "a", name: "one", input: {} },
    { type: "tool_use", id: "b", name: "two", input: {} },
  ]);
  // both results ride in a single user message
  assert.equal((out[2].content as unknown[]).length, 2);
});

test("toAnthropicMessages tolerates misshapen tool arguments", () => {
  const out = toAnthropicMessages([
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "x", name: "t", arguments: "not json" }] },
  ]);
  assert.deepEqual(out[1].content, [{ type: "tool_use", id: "x", name: "t", input: {} }]);
});
