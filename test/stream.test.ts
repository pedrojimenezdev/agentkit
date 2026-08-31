import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicDeltas, openAIDeltas, sseData, streamToString } from "../src/llm.ts";

/** A mocked SSE body — an async iterable of string chunks, no network. */
async function* chunks(...parts: string[]): AsyncGenerator<string> {
  for (const p of parts) yield p;
}

const openAIDelta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;

const anthropicDelta = (text: string) =>
  `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n`;

test("openAIDeltas yields text deltas in order", async () => {
  const stream = openAIDeltas(chunks(openAIDelta("Hello"), openAIDelta(", "), openAIDelta("world")));
  assert.equal(await streamToString(stream), "Hello, world");
});

test("openAIDeltas skips empty and absent deltas", async () => {
  const stream = openAIDeltas(
    chunks(
      openAIDelta("a"),
      openAIDelta(""), // empty string delta — must not be yielded
      `data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n`, // role-only opener
      `data: ${JSON.stringify({ choices: [{ delta: { content: null } }] })}\n`,
      "data: {not json}\n", // a malformed frame must not kill the stream
      ": keep-alive comment\n",
      "\n",
      openAIDelta("b"),
    ),
  );
  const out: string[] = [];
  for await (const piece of stream) out.push(piece);
  assert.deepEqual(out, ["a", "b"]);
});

test("openAIDeltas stops at [DONE] and ignores anything after", async () => {
  const stream = openAIDeltas(
    chunks(openAIDelta("kept"), "data: [DONE]\n", openAIDelta("never emitted")),
  );
  assert.equal(await streamToString(stream), "kept");
});

test("sseData reassembles a payload split across chunks", async () => {
  // A real network chunk boundary can land mid-JSON; buffering is what keeps
  // half a token from being dropped.
  const frame = openAIDelta("split me");
  const cut = Math.floor(frame.length / 2);
  const stream = openAIDeltas(chunks(frame.slice(0, cut), frame.slice(cut)));
  assert.equal(await streamToString(stream), "split me");
});

test("sseData emits a trailing frame with no final newline", async () => {
  const out: string[] = [];
  for await (const payload of sseData(chunks('data: {"a":1}'))) out.push(payload);
  assert.deepEqual(out, ['{"a":1}']);
});

test("anthropicDeltas yields content_block_delta text only", async () => {
  const stream = anthropicDeltas(
    chunks(
      `data: ${JSON.stringify({ type: "message_start", message: { id: "m" } })}\n`,
      `data: ${JSON.stringify({ type: "content_block_start", index: 0 })}\n`,
      anthropicDelta("Nice "),
      anthropicDelta("to meet you"),
      `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n`,
    ),
  );
  assert.equal(await streamToString(stream), "Nice to meet you");
});

test("anthropicDeltas stops at message_stop", async () => {
  const stream = anthropicDeltas(
    chunks(
      anthropicDelta("kept"),
      `data: ${JSON.stringify({ type: "message_stop" })}\n`,
      anthropicDelta("never emitted"),
    ),
  );
  assert.equal(await streamToString(stream), "kept");
});

test("anthropicDeltas skips empty text and non-text deltas", async () => {
  const stream = anthropicDeltas(
    chunks(
      anthropicDelta("a"),
      anthropicDelta(""),
      // input_json_delta belongs to a tool call, not the text stream
      `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"x":' } })}\n`,
      `data: ${JSON.stringify({ type: "ping" })}\n`,
      anthropicDelta("b"),
    ),
  );
  const out: string[] = [];
  for await (const piece of stream) out.push(piece);
  assert.deepEqual(out, ["a", "b"]);
});

test("streamToString collects an empty stream to an empty string", async () => {
  assert.equal(await streamToString(chunks()), "");
});
