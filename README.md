# railguard

> Production-hardened AI agent toolkit, extracted from real client work — an agent loop that can't run away with your bill, reliable JSON from models that love prose, typed tool calling, tenant-safe RAG, and cost guardrails. **Zero runtime dependencies.**

This is the distilled core of what made real systems work in production: the multi-tenant dental-copilot agent (RAG + tool calling over WhatsApp) and a social-publishing bot that turned one prompt into per-platform copy and images. The client-specific parts stay private; the reusable engineering is here.

## Why this exists

Frameworks make the demo easy. The hard part of production agents is everything else:

- **The model sometimes returns prose or a broken shape** when you asked for JSON → `structured()` re-asks with the exact error until it's valid.
- **A runaway tool loop is a bill** → `Budget` is a hard ceiling checked *before* every model call.
- **Tenants must never see each other's documents** → retrieval is scoped by tenant key, not by filtering afterwards.
- **Providers come and go** → one `LLM` interface, swap Anthropic/DeepSeek/OpenAI/mocks in a line.

## Install / run

```bash
npm i                    # typescript only (dev)
npm test                 # node:test — 11 tests, no network, mocked LLM
npm run build            # emits dist/ with .d.ts
```

## Modules

| Module | What it does |
|---|---|
| `agent()` | The loop: system → model → execute tool calls → append → repeat, capped by `maxSteps` + `Budget` |
| `structured()` | JSON out of an LLM, validated, self-corrected on miss (strip fences, re-ask with the error) |
| `defineTool` / `executeTool` | Typed tool registry; the library never trusts model-supplied shapes |
| `rag` (`chunk`, `retrieve`, `inMemoryStore`, `groundPrompt`) | Pluggable vector store + deterministic chunker; search is scoped per tenant |
| `Budget` / `retry` | Token + cost ceilings, exponential backoff with jitter |
| `env` / `redact` | Type-safe env parsing with secret-stripping and redaction |
| `createOpenAICompatible` / `createAnthropic` | fetch-based providers — no SDK dependency |

## Examples

**Reliable structured output** (the model is told JSON, then *held to it*):

```ts
import { structured } from "railguard";

const user = await structured<{ name: string }>(llm, {
  system: "Extract the user's name.",
  messages: (system) => [
    { role: "system", content: system },
    { role: "user", content: "My name is Ana." },
  ],
  validate: (v) =>
    v && typeof v === "object" && typeof (v as any).name === "string"
      ? { ok: true, value: v as { name: string } }
      : { ok: false, error: "missing 'name'" },
});
```

**A tool-calling agent with a budget**:

```ts
import { agent, defineTool, Budget } from "railguard";

const search = defineTool<{ q: string }>({
  name: "search",
  description: "Search the knowledge base",
  parameters: { type: "object", properties: { q: { type: "string" } } },
  run: ({ q }) => lookUp(q),
});

const answer = await agent({
  llm,
  tools: [search],
  system: "Answer using the search tool when needed.",
  maxSteps: 8,
  budget: new Budget({ maxTokens: 4000, maxCostUsd: 0.5 }),
});
```

**Tenant-safe RAG**:

```ts
import { chunk, inMemoryStore, retrieve, groundPrompt } from "railguard";

const store = inMemoryStore();
for (const piece of chunk(docs)) {
  await store.add({ id: nanoid(), scope: tenantId, embedding: await embed(piece), text: piece });
}
const hits = await retrieve({ store, embedder: { embed }, scope: tenantId }, question);
const prompt = groundPrompt(hits, question);
```

## Design decisions

- **Zero runtime deps** — `fetch` + `node:test`. The only dev dep is TypeScript.
- **Strings in, validation out** — model-supplied JSON is never trusted (`parseToolArguments` coerces, tools validate).
- **Hard ceilings, not soft** — `Budget.check()` throws *before* the next call, so the worst case is bounded by construction.
- **Isolation by scope, not filter** — `VectorStore.search(scope, …)` never sees other tenants' chunks.

## Status

Extracted from production systems; the client-specific integrations (Telegram, WhatsApp, Zernio, Qdrant plugins) live in the private repos. This library is the reusable, tested core — use it, fork it, port the interesting parts.

## License

MIT — see [LICENSE](LICENSE).
