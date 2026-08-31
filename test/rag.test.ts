import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk, groundPrompt, inMemoryStore, retrieve } from "../src/rag.ts";

test("chunk splits deterministically without dropping content", () => {
  const text = "Sentence one is here. Sentence two follows. And a third. Fourth.";
  const parts = chunk(text, { size: 30, overlap: 10 });
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length > 0));
  assert.ok(parts.join(" ").includes("Sentence one"));
});

test("chunk overlaps every boundary, not just the last", () => {
  const text = "Alpha one here. Bravo two here. Charlie three here. Delta four here.";
  const parts = chunk(text, { size: 32, overlap: 8 });
  assert.ok(parts.length >= 3, `expected 3+ chunks, got ${parts.length}`);
  // Each chunk after the first carries the tail of its predecessor.
  for (let i = 1; i < parts.length; i++) {
    const tail = parts[i - 1].slice(-8);
    assert.ok(parts[i].startsWith(tail), `chunk ${i} does not overlap chunk ${i - 1}`);
  }
});

test("chunk hard-splits an oversized sentence instead of dropping content", () => {
  const long = "x".repeat(250) + ".";
  const parts = chunk(long, { size: 100, overlap: 0 });
  assert.equal(parts.join(""), long);
});

test("chunk with zero overlap leaves chunks untouched", () => {
  const parts = chunk("One here. Two here. Three here.", { size: 12, overlap: 0 });
  assert.deepEqual(parts, ["One here.", "Two here.", "Three here."]);
});

test("inMemoryStore isolates by scope and ranks by similarity", async () => {
  const store = inMemoryStore();
  await store.add({ id: "a", scope: "tenant-1", embedding: [1, 0], text: "alpha" });
  await store.add({ id: "b", scope: "tenant-1", embedding: [0, 1], text: "beta" });
  await store.add({ id: "c", scope: "tenant-2", embedding: [1, 0], text: "gamma" });

  const t1 = await store.search("tenant-1", [1, 0], 4);
  assert.equal(t1.length, 2); // only tenant-1
  assert.equal(t1[0].text, "alpha");

  const t2 = await store.search("tenant-2", [1, 0], 4);
  assert.equal(t2[0].text, "gamma");
});

test("retrieve + groundPrompt produce a grounded question", async () => {
  const store = inMemoryStore();
  await store.add({ id: "1", scope: "docs", embedding: [1, 0, 0], text: "The product is amber." });
  const embedder = { embed: async (text: string) => (text.includes("amber") ? [1, 0, 0] : [0, 1, 0]) };
  const hits = await retrieve({ store, embedder, scope: "docs", topK: 1 }, "what is amber?");
  assert.equal(hits[0].text, "The product is amber.");
  const prompt = groundPrompt(hits, "what color is it?");
  assert.ok(prompt.includes("The product is amber"));
  assert.ok(prompt.includes("Question: what color is it?"));
});
