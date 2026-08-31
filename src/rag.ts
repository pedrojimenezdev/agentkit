/**
 * Retrieval-augmented generation, kept minimal and pluggable. The thing that
 * makes production RAG "boring but right" is tenant isolation + deterministic
 * chunking — so both are first-class here.
 */

export interface Chunk {
  id: string;
  /** Embeddings vector for this chunk. */
  embedding: number[];
  /** Tenant/namespace key — isolation happens on this, not by filtering. */
  scope: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface VectorStore {
  add(chunk: Chunk): Promise<void>;
  /** Top-k nearest neighbours within a scope. */
  search(scope: string, embedding: number[], k: number): Promise<{ id: string; score: number; text: string; metadata?: Record<string, unknown> }[]>;
}

/** In-memory store for demos, tests, and single-tenant dev. Swap for Qdrant /
 *  pgvector / Pinecone by implementing the 36-line interface. */
export function inMemoryStore(): VectorStore {
  const items: Chunk[] = [];
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
  const norm = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0)) || 1;
  return {
    async add(c) {
      items.push(c);
    },
    async search(scope, embedding, k) {
      return items
        .filter((c) => c.scope === scope)
        .map((c) => ({ id: c.id, score: dot(c.embedding, embedding) / (norm(c.embedding) * norm(embedding)), text: c.text, metadata: c.metadata }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
  };
}

/** Deterministic, size-capped chunker. Never splits mid-sentence when it can
 *  help it — keeps each chunk self-contained for retrieval quality.
 *
 *  `size` caps the *new* content in each chunk; `overlap` then prefixes every
 *  chunk after the first with the tail of its predecessor, so a fact straddling
 *  a boundary is retrievable from either side. A sentence longer than `size` is
 *  hard-split rather than truncated — chunking never drops content. */
export function chunk(text: string, opts?: { size?: number; overlap?: number }): string[] {
  const size = Math.max(1, opts?.size ?? 400);
  const overlap = Math.max(0, Math.min(opts?.overlap ?? 40, size - 1));
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim().length > 0) out.push(cur.trim());
    cur = "";
  };

  for (const s of sentences) {
    const candidate = cur ? `${cur} ${s}` : s;
    if (candidate.length <= size) {
      cur = candidate;
      continue;
    }
    flush();
    let rest = s;
    while (rest.length > size) {
      out.push(rest.slice(0, size));
      rest = rest.slice(size);
    }
    cur = rest;
  }
  flush();

  if (overlap > 0 && out.length > 1) {
    const base = [...out];
    for (let i = 1; i < out.length; i++) {
      out[i] = `${base[i - 1].slice(-overlap)} ${base[i]}`;
    }
  }
  return out;
}

export interface RAGOptions {
  store: VectorStore;
  embedder: { embed(text: string): Promise<number[]> };
  scope: string;
  topK?: number;
}

/** Retrieve the most relevant chunks for a query within a scope. */
export async function retrieve(opts: RAGOptions, query: string): Promise<{ text: string; metadata?: Record<string, unknown>; score: number }[]> {
  const embedding = await opts.embedder.embed(query);
  return opts.store.search(opts.scope, embedding, opts.topK ?? 4);
}

/** Build a grounded prompt from retrieved chunks — the standard RAG bridge. */
export function groundPrompt(retrieved: { text: string }[], question: string): string {
  const context = retrieved.map((r, i) => `[${i + 1}] ${r.text}`).join("\n\n");
  return `Use the following context to answer. If the answer is not in the context, say so plainly rather than guessing.\n\nContext:\n${context || "(no relevant context)"}\n\nQuestion: ${question}`;
}
