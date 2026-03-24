# Fast Local Memory for Agents — Research Report

**Date:** 2026-03-24
**Status:** Updated — based on internet research (2025–2026 data)

---

## 1. Context

NeoKai already handles *short-term* memory via the LLM context window (messages in the session). This report focuses on **long-term persistent memory**: facts, preferences, and decisions that should survive across sessions and be retrievable without reloading every past conversation.

### What agents actually need to remember

| Category | Examples | Access frequency |
|----------|----------|-----------------|
| **Project conventions** | Coding style, preferred patterns, banned APIs | Per-task |
| **Past decisions** | Why a particular design was chosen, rejected alternatives | Infrequent |
| **User preferences** | Response verbosity, preferred commit message style | Per-session |
| **Codebase facts** | Key module locations, tricky areas, known footguns | Per-query |
| **Cross-session context** | Previous related tasks, PR outcomes, failed experiments | On task start |

### Operations needed

- `store(content, tags[], scope)` — persist a memory entry
- `search(query, scope)` → `MemoryEntry[]` — retrieve relevant entries by relevance
- `update(id, content)` — update an existing entry
- `delete(id)` — remove an entry
- `list(scope)` — enumerate entries for a project/user

### Latency budget

Target: **< 50 ms** for retrieval (acceptable inside agent pre-processing).
Embedding generation on CPU: typically **10–50 ms** per sentence.
SQLite FTS5 full-scan of 100k rows: **< 5 ms**.

### Memory scopes

- **Global** — cross-project user preferences
- **Project** — tied to a `workspace_path` / room
- **Session** — ephemeral; already handled by context window (out of scope)

---

## 2. Landscape Overview (2025–2026)

The memory space has matured significantly. The key frameworks to know:

| Framework | Approach | Local? | Open source? | Key differentiator |
|-----------|----------|--------|-------------|-------------------|
| **Mem0** | Vector + graph hybrid | Yes (OSS tier) | Yes | Production-proven; 91% latency reduction vs full-context; $24M raised |
| **Zep / Graphiti** | Temporal knowledge graph | Yes (Community) | Yes (Graphiti) | Temporal reasoning; tracks how facts change over time |
| **Letta (MemGPT)** | LLM-as-OS (in-context + archival) | Yes | Yes | Self-editing agent memory; sleep-time async management |
| **sqlite-memory** | Markdown + FTS5 + vector (SQLite) | Yes | Yes | Zero-infra; offline-first; hybrid retrieval |
| **sqlite-rag** | FTS5 + sqlite-vector + RRF | Yes | Yes | Pure SQLite hybrid search reference impl |

---

## 3. Candidate Approaches

### Approach A — SQLite FTS5 (Full-Text Search)

SQLite ships with the `fts5` extension which enables BM25-ranked keyword search over text columns.

**How it works:**
```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content, tags,
  tokenize='porter ascii'
);

-- BM25-ranked search
SELECT rowid, rank FROM memory_fts
WHERE memory_fts MATCH 'tabs indentation'
ORDER BY rank;
```

**Benchmark (2025, 100k entries):** < 5 ms end-to-end on an M1 MacBook Pro.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★★★ | < 5 ms for 100k entries |
| Simplicity | ★★★★★ | Zero new infra; Bun SQLite already used |
| Privacy | ★★★★★ | All data stays on-disk, same DB file |
| Scalability | ★★★★☆ | Good to ~1M entries; degrades gracefully |
| Semantic search | ★★☆☆☆ | Keyword/BM25 only — misses synonyms & paraphrase |
| NeoKai fit | ★★★★★ | One migration; uses existing ReactiveDatabase |

**Verdict:** Best baseline. Covers ~70% of use cases with zero infra cost. Used as the **Phase 1** foundation.

---

### Approach B — sqlite-vector (Quantized In-Process Vector Search)

**sqlite-vector** (by sqliteai.com, distinct from `sqlite-vec`) is a cross-platform SQLite extension that delivers HNSW-grade vector search with quantization, running entirely in-process.

**2025 benchmark (100k vectors, 384-dim FLOAT32, Apple M1 Pro):**

| Mode | Latency |
|------|---------|
| Full-scan (exact) | 56.65 ms |
| 8-bit quantized scan | 17.44 ms |
| Quantized + preloaded in memory | **3.97 ms** |

With quantization + preload, it runs **17× faster than sqlite-vec** while maintaining perfect recall.

Supports Float32, Float16, BFloat16, Int8, UInt8, and 1-bit quantization. Works out of the box — **no pre-indexing required**, unlike HNSW/IVF.

```sql
CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[384]);

INSERT INTO memory_vec(rowid, embedding)
VALUES (42, '[0.12, -0.07, ...]');

-- ANN search
SELECT rowid, distance FROM memory_vec
WHERE embedding MATCH '[...]' LIMIT 10;
```

Note: **sqlite-vec** (by Alex Garcia, `asg017/sqlite-vec`) is the older extension now merged into SQLite core as `vec1`. It performs brute-force ANN in pure C, but is ~17× slower than sqlite-vector's quantized mode. For NeoKai, **sqlite-vector is the better choice**.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★★★ | 4 ms with quantized preload |
| Simplicity | ★★★★☆ | One native `.so`/`.dylib` extension |
| Privacy | ★★★★★ | Fully local |
| Scalability | ★★★★☆ | Handles millions of vectors |
| Semantic search | ★★★★★ | True semantic similarity |
| NeoKai fit | ★★★★☆ | Needs extension bundling + embedding model |

**Verdict:** Excellent for Phase 2. The quantization support eliminates the embedding latency bottleneck.

---

### Approach C — sqlite-rag (Pre-Built Hybrid FTS5 + Vector)

**sqlite-rag** (by sqliteai.com, `sqliteai/sqlite-rag`) is an open-source reference implementation of a hybrid search engine built entirely on SQLite combining FTS5 and sqlite-vector via **Reciprocal Rank Fusion (RRF)**.

It already solves the hybrid-merge problem and has a stable Python API. For NeoKai (Bun/TypeScript), it would serve as an **architectural reference** rather than a direct dependency. The key logic to port:

```
Query
  ├─ FTS5 search → top-N keyword hits (BM25 ranked)
  ├─ sqlite-vector ANN → top-N semantic hits
  └─ RRF merge → final top-K results
```

RRF formula: `score(d) = Σ 1 / (k + rank_i(d))` where k=60 is standard.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★★★ | < 10 ms with preloaded quantized vectors |
| Simplicity | ★★★☆☆ | Reference code available; porting needed |
| Privacy | ★★★★★ | Fully local |
| Scalability | ★★★★☆ | SQLite limits apply |
| Semantic search | ★★★★★ | Best of both worlds |
| NeoKai fit | ★★★★☆ | Direct architectural model for our use case |

**Verdict:** This is the exact architecture we want. Use it as a blueprint for Phase 2.

---

### Approach D — Mem0 (Memory Layer Library)

**Mem0** is an open-source production memory layer for AI agents. It recently published a paper demonstrating 26% accuracy improvement over OpenAI full-context approaches, with 91% latency reduction and 90%+ token savings. Raised $24M, adopted by CrewAI, Flowise, Langflow, and AWS's Agent SDK.

**Architecture:** Extracts key facts from conversations using an LLM, deduplicates, stores in a vector store + optional graph DB, retrieves by semantic similarity.

**Local OSS tier:**
```typescript
import { Memory } from 'mem0ai';
const memory = new Memory(); // uses local in-memory store by default

await memory.add('User prefers tabs over spaces', { userId: 'user-1' });
const results = await memory.search('indentation preference', { userId: 'user-1' });
```

**Key limitation for NeoKai:** Mem0's default extraction step requires an LLM call on every `add()` — this is not "fast local memory" out of the box. The open-source version can be configured with local embeddings but the extraction LLM is still required. Total `add()` latency: 200–2000 ms. Retrieval: ~20 ms.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed (write) | ★★☆☆☆ | Requires LLM extraction per write |
| Speed (read) | ★★★★☆ | ~20 ms semantic retrieval |
| Simplicity | ★★★☆☆ | npm package; significant dependency tree |
| Privacy | ★★★★☆ | Local embeddings possible; extraction LLM can be local |
| Semantic search | ★★★★★ | LLM-quality fact extraction + semantic retrieval |
| NeoKai fit | ★★★☆☆ | Powerful but heavy; extraction latency is a concern |

**Verdict:** Best-in-class quality but write latency is prohibitive for per-message use. Suitable as an optional background memory enrichment process, not the primary retrieval path.

---

### Approach E — Zep / Graphiti (Temporal Knowledge Graph)

**Zep** builds a temporal knowledge graph (via their OSS **Graphiti** library) that tracks how facts evolve over time. Every memory is time-anchored. Achieves 18.5% accuracy improvement over baselines and 90% latency reduction vs full-context.

**Graphiti** is the open-source engine; Zep wraps it with enterprise features. Community edition supports local deployment.

**Key strength:** Multi-hop relational reasoning. "What were the user's architectural preferences in Q1 vs now?" is trivial with a graph but complex with vectors. Supports Neo4j and in-memory graph backends.

**Key limitation for NeoKai:** Graph initialization requires an LLM to extract entities and relationships. Cold-start cost is high. Best suited for long-lived persistent agents that accumulate months of history.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed (write) | ★★☆☆☆ | LLM extraction for entity/relation parsing |
| Speed (read) | ★★★★☆ | Graph traversal < 20 ms locally |
| Simplicity | ★★☆☆☆ | Requires Neo4j or in-memory graph engine |
| Privacy | ★★★★☆ | Local with Graphiti + local LLM |
| Semantic search | ★★★★★ | Temporal + relational + semantic |
| NeoKai fit | ★★☆☆☆ | Over-engineered for current scale; high cold-start cost |

**Verdict:** Compelling long-term vision but significant infra overhead. Revisit when NeoKai agents accumulate months of interaction history per project.

---

### Approach F — Letta / MemGPT Architecture (LLM-as-OS)

**Letta** (formerly MemGPT) treats the LLM as an OS: in-context core memory (editable system prompt blocks) + archival memory (external vector/graph DB). The agent itself decides what to move in and out of context using self-editing tool calls.

**Key innovation:** "Sleep-time agents" run async memory consolidation in the background, improving both response time and memory quality.

**2025 addition:** Letta agents now leverage Claude Sonnet's native memory tool capabilities for dynamic block management.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★☆☆ | Self-editing adds 1–3 tool calls per turn |
| Simplicity | ★★★☆☆ | Framework has good TypeScript bindings |
| Privacy | ★★★★★ | Fully local |
| Semantic search | ★★★★★ | Agent-directed; maximum flexibility |
| NeoKai fit | ★★★☆☆ | Interesting for the "Task Agent" concept; adds overhead |

**Verdict:** The "sleep-time agent" pattern (background memory consolidation) is worth adopting as a design pattern regardless of framework choice.

---

### Approach G — External Vector Database (Qdrant / Chroma)

**Qdrant (2025):** Enterprise-grade HNSW with asymmetric quantization (24× compression, minimal accuracy loss). Hybrid Cloud for on-prem. 3–4× faster than Chroma but requires a running service.

**Chroma (2025):** Rewrote core in Rust — now 4× faster writes/queries. Can run embedded (no separate process). Growing embedded usage for local AI apps.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★★☆ | Qdrant/Chroma: 2–10 ms locally |
| Simplicity | ★★★☆☆ | Chroma embedded is reasonable; Qdrant needs a process |
| Privacy | ★★★★☆ | Local deployment available |
| Scalability | ★★★★★ | Production-grade |
| Semantic search | ★★★★★ | Best-in-class ANN |
| NeoKai fit | ★★☆☆☆ | Chroma embedded is viable; Qdrant breaks zero-infra goal |

**Verdict:** Chroma's 2025 embedded mode is now viable as a fallback if sqlite-vector proves insufficient. Qdrant remains over-engineered for local use. Neither is necessary for Phase 1–2.

---

### Approach H — FastEmbed-js (Embedding Generation)

Regardless of the vector store, an embedding model is needed. **fastembed-js** (`Anush008/fastembed-js`) is a Node.js port of Qdrant's FastEmbed library using ONNX Runtime. It:

- Runs on CPU with no GPU required
- Achieves **sub-10 ms inference** on modern hardware (92% of practitioners in 2025 surveys)
- Default model: `BGESmallEN` (~25 MB ONNX) — small enough for bundling
- 12× speedup over PyTorch baselines
- No subprocess — pure Node.js FFI via ONNX Runtime Node

**Alternatives:**
- `onnxruntime-node` directly with `all-MiniLM-L6-v2` (384-dim, ~25 MB)
- BGE-M3 for multilingual (larger: ~560 MB)
- `nomic-embed-text` via Ollama (requires running Ollama daemon)

**Verdict:** fastembed-js is the correct embedding solution for NeoKai. Zero external service, Bun-compatible via Node.js compatibility mode, sub-10 ms per sentence.

---

## 4. Recommendation

### Phased Approach: SQLite-Native Hybrid

**Phase 1 — FTS5 baseline (complexity: 2/5, ~1 week)**

Zero new dependencies. Delivers a working memory system immediately:

1. `memory_entries` table + `memory_fts` virtual table (FTS5 content table with Porter stemmer)
2. `MemoryRepository` with `store / search / update / delete / list`
3. `MemoryManager` exposed through `DaemonApp`
4. RPC handlers: `memory.store`, `memory.search`, `memory.delete`, `memory.list`, `memory.update`
5. Agent tool integration: `store_memory` / `search_memory` tools in system prompt
6. Scope: `global` (user preferences) and `project` (workspace_path-scoped)

**Phase 2 — Hybrid FTS5 + sqlite-vector (complexity: 3/5, ~2 weeks)**

Modeled on `sqliteai/sqlite-rag` architecture:

1. Add `sqlite-vector` native extension (Bun FFI / prebuilt binary)
2. Add `fastembed-js` for in-process ONNX embedding (`BGESmallEN`, ~25 MB)
3. Generate embeddings asynchronously via the existing `job_queue` on memory write
4. Add `memory_vectors` shadow table via `sqlite-vector`
5. Implement RRF merge in `MemoryManager.search()` (k=60, standard)
6. Optional: enable quantized preload mode for < 5 ms retrieval on warm cache

**Phase 3 — Background consolidation (complexity: 3/5, future)**

Inspired by Letta's "sleep-time agents" and Mem0's extraction pattern:

- A background agent periodically reviews recent memories and:
  - Deduplicates related entries
  - Promotes frequently-accessed entries to a "core memory" block injected at session start
  - Prunes stale entries beyond a configurable TTL
- This runs outside of request latency so it doesn't affect agent response times

---

## 5. Implementation Sketch (Phase 1)

### 5.1 Schema (new migration)

```sql
-- Core entries table
CREATE TABLE memory_entries (
  id         TEXT PRIMARY KEY,           -- UUID v4
  scope      TEXT NOT NULL,              -- 'global' | 'project'
  scope_key  TEXT,                       -- workspace_path for project scope, NULL for global
  content    TEXT NOT NULL,              -- The memory text
  tags       TEXT NOT NULL DEFAULT '',   -- Space-separated tags
  source     TEXT,                       -- 'agent' | 'user' | 'system'
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- FTS5 virtual table — content table mode (no data duplication)
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content,
  tags,
  content='memory_entries',
  content_rowid='rowid',
  tokenize='porter ascii'
);

-- Sync triggers
CREATE TRIGGER memory_ai AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;
CREATE TRIGGER memory_ad AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags)
  VALUES ('delete', old.rowid, old.content, old.tags);
END;
CREATE TRIGGER memory_au AFTER UPDATE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags)
  VALUES ('delete', old.rowid, old.content, old.tags);
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;

-- Indexes
CREATE INDEX memory_entries_scope ON memory_entries(scope, scope_key);
CREATE INDEX memory_entries_updated ON memory_entries(updated_at DESC);
CREATE INDEX memory_entries_access ON memory_entries(last_accessed_at DESC);
```

### 5.2 Repository interface

```typescript
// packages/daemon/src/storage/repositories/memory-repository.ts

export type MemoryScope = { type: 'global' } | { type: 'project'; key: string };

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  content: string;
  tags: string[];
  source?: 'agent' | 'user' | 'system';
  accessCount: number;
  lastAccessedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  rank: number;       // BM25 rank from FTS5 (Phase 1) or RRF score (Phase 2)
}

export class MemoryRepository {
  store(payload: Omit<MemoryEntry, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'updatedAt'>): MemoryEntry;
  search(query: string, scope?: MemoryScope, limit?: number): MemorySearchResult[];
  get(id: string): MemoryEntry | undefined;
  update(id: string, patch: Partial<Pick<MemoryEntry, 'content' | 'tags'>>): MemoryEntry;
  delete(id: string): void;
  list(scope?: MemoryScope, limit?: number): MemoryEntry[];
  recordAccess(id: string): void;  // bump access_count + last_accessed_at
}
```

### 5.3 RPC handlers

```typescript
// packages/daemon/src/lib/rpc-handlers/memory-handlers.ts
// Registered in packages/daemon/src/app.ts alongside other RPC handlers

hub.handle('memory.store',  handler_store);   // { scope, scopeKey?, content, tags?, source? } → MemoryEntry
hub.handle('memory.search', handler_search);  // { query, scope?, limit? } → MemorySearchResult[]
hub.handle('memory.list',   handler_list);    // { scope? } → MemoryEntry[]
hub.handle('memory.get',    handler_get);     // { id } → MemoryEntry
hub.handle('memory.update', handler_update);  // { id, content?, tags? } → MemoryEntry
hub.handle('memory.delete', handler_delete);  // { id } → void
```

### 5.4 Agent tools (system prompt injection)

Agents receive these two tools in their system prompt:

```xml
<tool name="store_memory">
  Store a fact, decision, or preference to persistent memory for future sessions.
  Use for: coding conventions, user preferences, past decisions, project facts.
  <param name="content"  type="string"  required="true">The memory text (1–3 sentences).</param>
  <param name="tags"     type="string[]"              >Keyword tags for retrieval.</param>
  <param name="scope"    type="string"  default="project">
    'global' for user preferences; 'project' for this codebase.
  </param>
</tool>

<tool name="search_memory">
  Retrieve relevant memories from previous sessions.
  <param name="query"  type="string"  required="true">Natural language query.</param>
  <param name="limit"  type="integer" default="5">Max results to return.</param>
</tool>
```

### 5.5 Phase 2 additions (sketch)

```sql
-- Shadow vector table (added in Phase 2 migration)
CREATE VIRTUAL TABLE memory_vectors USING vec0(embedding float[384]);
-- Rows are inserted asynchronously by the embedding background job
```

```typescript
// RRF merge in MemoryManager.search()
function reciprocalRankFusion(
  ftsResults: MemorySearchResult[],
  vecResults: MemorySearchResult[],
  k = 60,
): MemorySearchResult[] {
  const scores = new Map<string, number>();
  for (const [i, r] of ftsResults.entries()) {
    scores.set(r.entry.id, (scores.get(r.entry.id) ?? 0) + 1 / (k + i + 1));
  }
  for (const [i, r] of vecResults.entries()) {
    scores.set(r.entry.id, (scores.get(r.entry.id) ?? 0) + 1 / (k + i + 1));
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, rank]) => ({ entry: allEntries.get(id)!, rank }));
}
```

---

## 6. Complexity & Effort Estimates

| Approach | Complexity (1–5) | Wall-clock effort | Notes |
|----------|-----------------|------------------|-------|
| FTS5 baseline | **2** | ~1 week | One migration, ~250 LOC |
| + sqlite-vector (Phase 2) | **3** | +1–2 weeks | Native ext bundling + fastembed-js |
| + Background consolidation (Phase 3) | **3** | +1 week | New job type; reuses job_queue |
| Mem0 integration | **3** | ~1 week | npm pkg; high write latency |
| Zep / Graphiti | **4** | 2–3 weeks | Graph infra; LLM extraction overhead |
| Letta/MemGPT full | **4** | 2–3 weeks | Framework integration |
| External vector DB (Qdrant) | **4** | 1–2 weeks | Extra process; breaks zero-infra |
| Chroma embedded | **3** | ~1 week | Viable fallback; Rust rewrite made it faster |

---

## 7. Performance Summary

| Approach | Write latency | Read latency | Semantic? | Zero infra? |
|----------|--------------|-------------|-----------|------------|
| SQLite FTS5 | < 1 ms | < 5 ms | No | Yes |
| sqlite-vector (quantized+preload) | 5–10 ms (async) | **< 4 ms** | Yes | Yes (native ext) |
| Hybrid FTS5 + sqlite-vector | 5–10 ms (async) | < 10 ms | Yes | Yes (native ext) |
| Mem0 OSS | 200–2000 ms (LLM) | ~20 ms | Yes | Needs LLM |
| Zep / Graphiti | 200–2000 ms (LLM) | < 20 ms | Yes | Needs graph |
| Chroma embedded | ~5 ms | ~5 ms | Yes | Yes (after 2025 rewrite) |
| Qdrant local | ~2 ms | ~2 ms | Yes | No (separate process) |

---

## 8. Open Questions for User Input

1. **Embedding model distribution:** Should NeoKai bundle `BGESmallEN` (~25 MB ONNX) via `fastembed-js`, or rely on a user-installed Ollama instance? Bundling simplifies setup but adds to binary size.

2. **Memory injection strategy:** Should agents search memory explicitly via tool calls, or should top-N memories be auto-injected into the system prompt at session start? Auto-injection is simpler but consumes context tokens on every session regardless of relevance.

3. **Memory scope:** Should project memory be scoped to `workspace_path` (current session model) or to a NeoKai "room"? Room-scoped memory might be more intuitive for multi-project rooms and aligns better with the existing room/goal system.

4. **Expiry and pruning:** Should entries expire after a configurable TTL (e.g., 90 days without access)? Or indefinite retention? Background consolidation (Phase 3) can handle deduplication, but a hard TTL policy needs a decision upfront.

5. **Encryption at rest:** Current SQLite file relies on filesystem permissions. Should memory entries be encrypted at the column level? Adds ~1 ms per operation; most relevant if NeoKai is deployed in shared/cloud environments.

6. **Multi-agent sharing:** In a Leader + Worker space, should all agents share one memory store per project, or should each agent type have an isolated memory namespace? Shared memory enables cross-agent learning; isolation prevents agents contaminating each other's context.

7. **Write strategy:** Should `store_memory` be synchronous (agent waits for write to complete) or fire-and-forget (agent gets immediate `ok`, embedding happens in background)? The latter keeps agent latency low but means semantic search may lag keyword search by a few seconds after write.

8. **Mem0 as an optional layer:** Given Mem0's strong production adoption, should we offer it as an optional enrichment layer (background extraction + deduplication) that writes into our FTS5/vector store? This would give high-quality memories without blocking the agent on LLM extraction.

---

## 9. Recommendation Summary

| Phase | What | Why |
|-------|------|-----|
| **Phase 1** (now) | SQLite FTS5 memory store + RPC + agent tools | Zero deps, ships fast, covers most use cases |
| **Phase 2** (+2 weeks) | Add sqlite-vector (quantized) + fastembed-js | True semantic search, < 5 ms with preload |
| **Phase 3** (future) | Background consolidation job + optional Mem0 layer | Quality improvement without blocking agents |

Skip: Zep, Letta framework, Qdrant (too heavy for current scale).
Revisit: Chroma embedded (now viable), Zep (when project lifespans exceed 6+ months).

---

## 10. References

- [sqlite-vector (sqliteai)](https://github.com/sqliteai/sqlite-vector) — Quantized in-process vector search for SQLite
- [sqlite-vec (asg017)](https://github.com/asg017/sqlite-vec) — Original SQLite vector extension (now `vec1` in SQLite core)
- [sqlite-rag (sqliteai)](https://github.com/sqliteai/sqlite-rag) — Hybrid FTS5 + vector search reference implementation
- [sqlite-memory (sqliteai)](https://github.com/sqliteai/sqlite-memory) — Markdown-based agent memory with offline-first sync
- [Hybrid FTS5 + vector search — Alex Garcia's blog](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html)
- [State of Vector Search in SQLite — Marco Bambini](https://marcobambini.substack.com/p/the-state-of-vector-search-in-sqlite)
- [fastembed-js](https://github.com/Anush008/fastembed-js) — Node.js ONNX embedding library
- [FastEmbed ONNX performance (2025)](https://johal.in/fastembed-onnx-lightweight-embedding-inference-2025/)
- [Mem0 paper (arXiv 2504.19413)](https://arxiv.org/abs/2504.19413)
- [Mem0 graph memory — Jan 2026](https://mem0.ai/blog/graph-memory-solutions-ai-agents)
- [Zep temporal knowledge graph (arXiv 2501.13956)](https://arxiv.org/abs/2501.13956)
- [Graphiti — open-source temporal graph engine](https://github.com/getzep/graphiti)
- [Letta / MemGPT architecture](https://docs.letta.com/concepts/memgpt/)
- [AI Agent Memory Systems 2026 comparison — Yogesh Yadav](https://yogeshyadav.medium.com/ai-agent-memory-systems-in-2026-mem0-zep-hindsight-memvid-and-everything-in-between-compared-96e35b818da8)
- [Best vector databases 2026 — Firecrawl](https://www.firecrawl.dev/blog/best-vector-databases)
- [Hybrid search: BM25 + vectors without lag](https://medium.com/@connect.hashblock/7-hybrid-search-recipes-bm25-vectors-without-lag-467189542bf0)
- [Reciprocal Rank Fusion paper](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [A-MEM: Agentic Memory for LLM Agents (arXiv 2502.12110)](https://arxiv.org/pdf/2502.12110)
- [ICLR 2026 Workshop: MemAgents](https://openreview.net/pdf?id=U51WxL382H)
