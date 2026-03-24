# Fast Local Memory for Agents — Research Report

**Date:** 2026-03-24
**Status:** Draft / Proposal

---

## 1. Context

NeoKai already handles *short-term* memory via the LLM context window (messages in the session). This report focuses on **long-term persistent memory**: facts, preferences, and decisions that should survive across sessions and be retrievable without reloading every past conversation.

### What agents actually need to remember

| Category | Examples | Frequency |
|----------|----------|-----------|
| **Project conventions** | Coding style, preferred patterns, banned APIs | Per-task lookup |
| **Past decisions** | Why a particular design was chosen, rejected alternatives | Infrequent lookup |
| **User preferences** | Response verbosity, preferred commit message style | Per-session |
| **Codebase facts** | Key module locations, tricky areas, known footguns | Per-query |
| **Cross-session context** | Previous related tasks, PR outcomes | On task start |

### Operations needed

- `store(key, content, tags[])` — save a memory entry
- `search(query)` → `MemoryEntry[]` — retrieve relevant entries
- `update(id, content)` — update an existing entry
- `delete(id)` — remove an entry
- `list(scope)` — enumerate entries for a project/user

### Latency budget

Target: **< 50 ms** for retrieval (acceptable inside agent pre-processing).
For context: a single SQLite full-scan of 10k rows takes ~2–5 ms on modern hardware.

### Memory scopes

- **Global** — cross-project user preferences
- **Project** — tied to a `workspace_path`
- **Session** — ephemeral, already handled by context window (out of scope)

---

## 2. Candidate Approaches

### Approach A — SQLite FTS5 (Full-Text Search)

SQLite ships with the `fts5` extension which enables BM25-ranked keyword search over text columns.

**How it works:**
```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(content, tags, tokenize='porter ascii');

-- Insert
INSERT INTO memory_fts(rowid, content, tags) VALUES (42, 'use tabs not spaces', 'conventions style');

-- Search (BM25 ranked)
SELECT rowid, rank FROM memory_fts WHERE memory_fts MATCH 'tabs indentation' ORDER BY rank;
```

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★★★ | < 5 ms for 100k entries |
| Simplicity | ★★★★★ | Zero new infra; already using Bun SQLite |
| Privacy | ★★★★★ | All data stays on disk, in the existing DB |
| Scalability | ★★★★☆ | Good to ~1M entries; degrades gracefully |
| Semantic search | ★★☆☆☆ | Keyword/BM25 only — misses synonyms |
| NeoKai fit | ★★★★★ | Trivial migration; uses existing ReactiveDatabase |

**Verdict:** Best baseline. Covers 80% of use cases with zero infra cost.

---

### Approach B — In-Process Vector Search (sqlite-vec / usearch)

**sqlite-vec** is a SQLite extension (single `.so`/`.dylib`) that adds HNSW-based approximate nearest-neighbour search directly inside SQLite. It requires a small embedding model to generate vectors.

```sql
CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[384]);

-- Store embedding for entry id=42
INSERT INTO memory_vec(rowid, embedding) VALUES (42, vec_f32('[0.12, -0.07, ...]'));

-- ANN search for top-5 nearest
SELECT rowid, distance FROM memory_vec WHERE embedding MATCH vec_f32('[...]') LIMIT 5;
```

**Embedding model options:**
- `nomic-embed-text` (137M params, runs via `ollama` or `llama.cpp`) — 768-dim
- `all-MiniLM-L6-v2` (23M params, ONNX) — 384-dim, ~15 ms per embedding on CPU
- Bun FFI can call a small ONNX runtime without spawning a subprocess

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★★☆ | ANN query < 5 ms; embedding generation 10–50 ms |
| Simplicity | ★★★☆☆ | Needs sqlite-vec native extension + embedding model |
| Privacy | ★★★★★ | Fully local |
| Scalability | ★★★★☆ | HNSW handles millions of vectors |
| Semantic search | ★★★★★ | True semantic similarity |
| NeoKai fit | ★★★☆☆ | Requires bundling a native `.so` + model download step |

**Verdict:** Excellent long-term solution for semantic recall. Main friction is distributing the native extension and seeding the embedding model.

---

### Approach C — External Vector Database (Qdrant / Chroma / Weaviate)

Runs as a separate process/container alongside NeoKai.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★★☆ | gRPC latency adds 2–10 ms locally |
| Simplicity | ★★☆☆☆ | Extra process, port, health checks |
| Privacy | ★★★★☆ | Local unless cloud-hosted |
| Scalability | ★★★★★ | Built for large-scale vector workloads |
| Semantic search | ★★★★★ | Production-grade |
| NeoKai fit | ★★☆☆☆ | Breaks "zero-infra" design goal; complicates install |

**Verdict:** Over-engineered for the current scale. Only worth it if NeoKai becomes a hosted multi-tenant service with millions of memory entries per tenant.

---

### Approach D — BM25 via Tantivy / Sonic

**Tantivy** is a pure-Rust full-text search library. **Sonic** is a lightweight search backend. Both can be called from Bun (Tantivy via `@napi-rs/tantivy` or a WASM build; Sonic via its ingest/search protocol).

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★★★ | Tantivy is extremely fast (< 1 ms for BM25) |
| Simplicity | ★★★☆☆ | Tantivy needs native bindings; Sonic is a separate process |
| Privacy | ★★★★★ | Local |
| Scalability | ★★★★★ | Handles 100M+ documents |
| Semantic search | ★★☆☆☆ | BM25 only |
| NeoKai fit | ★★★☆☆ | Extra native dep; SQLite FTS5 gives 90% for free |

**Verdict:** Marginal improvement over SQLite FTS5 for keyword search. Not worth the extra dependency unless scale becomes an issue (> 10M entries).

---

### Approach E — LLM-Backed Retrieval

Use the LLM itself to filter/summarize stored memories. Store everything as text, pass a compressed summary into the context window.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★☆☆☆☆ | Requires an API call (200–2000 ms) |
| Simplicity | ★★★★☆ | No new infra; uses existing SDK |
| Privacy | ★★★★★ | Depends on provider |
| Scalability | ★★☆☆☆ | Cost and latency blow up at scale |
| Semantic search | ★★★★★ | Perfect semantic understanding |
| NeoKai fit | ★★★☆☆ | Useful as a *layer on top of* fast retrieval, not standalone |

**Verdict:** Not a standalone memory engine. Excellent as a post-retrieval re-ranking or summarization step.

---

### Approach F — Hybrid: FTS5 + Vector (Recommended)

Combine SQLite FTS5 for fast keyword retrieval with an in-process vector index (`sqlite-vec`) for semantic recall. Results are merged via **Reciprocal Rank Fusion (RRF)**.

```
Query
  ├─ FTS5 search → top-20 keyword matches
  ├─ ANN vector search → top-20 semantic matches
  └─ RRF merge → top-5 final results
```

This matches the architecture used by modern RAG systems (e.g. pgvector + pg_trgm in PostgreSQL) but entirely in-process.

| Criterion | Score | Notes |
|-----------|-------|-------|
| Speed | ★★★★☆ | ~50 ms total (dominated by embedding generation) |
| Simplicity | ★★★☆☆ | Two search paths; manageable |
| Privacy | ★★★★★ | Fully local |
| Scalability | ★★★★☆ | Good to a few million entries |
| Semantic search | ★★★★★ | Best of both worlds |
| NeoKai fit | ★★★★☆ | SQLite-native; integrates with ReactiveDatabase |

---

## 3. Recommendation

### Phase 1 — SQLite FTS5 (implement now, ~1 week)

Deliver a working memory system in the current sprint with **zero new dependencies**:

1. New `memory_entries` table + `memory_fts` virtual table
2. `MemoryRepository` with `store / search / update / delete`
3. `MemoryManager` exposed through `DaemonApp`
4. RPC handlers: `memory.store`, `memory.search`, `memory.delete`, `memory.list`
5. Agent tool integration: agents can call `store_memory` / `search_memory` via MCP or slash command

### Phase 2 — Add Vector Layer (after Phase 1 is stable, ~2 weeks)

1. Integrate `sqlite-vec` as a Bun native extension
2. Add a small bundled ONNX embedding model (e.g., `all-MiniLM-L6-v2`, ~25 MB)
3. Generate embeddings asynchronously on memory write (background job)
4. Implement RRF merge in `MemoryManager.search()`

---

## 4. Implementation Sketch (Phase 1)

### 4.1 Schema

```sql
-- Core entries table
CREATE TABLE memory_entries (
  id         TEXT PRIMARY KEY,           -- UUID
  scope      TEXT NOT NULL,              -- 'global' | 'project'
  scope_key  TEXT,                       -- workspace_path for project scope
  content    TEXT NOT NULL,              -- The memory text
  tags       TEXT NOT NULL DEFAULT '',   -- Space-separated tags
  source     TEXT,                       -- 'agent' | 'user' | 'system'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- FTS5 virtual table (shadow table for memory_entries)
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content,
  tags,
  content='memory_entries',   -- content table mode (no duplication)
  content_rowid='rowid',
  tokenize='porter ascii'
);

-- Triggers to keep FTS5 in sync
CREATE TRIGGER memory_entries_ai AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;
CREATE TRIGGER memory_entries_ad AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
END;
CREATE TRIGGER memory_entries_au AFTER UPDATE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, tags) VALUES ('delete', old.rowid, old.content, old.tags);
  INSERT INTO memory_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
END;

CREATE INDEX memory_entries_scope ON memory_entries(scope, scope_key);
CREATE INDEX memory_entries_updated ON memory_entries(updated_at DESC);
```

### 4.2 Repository

```typescript
// packages/daemon/src/storage/repositories/memory-repository.ts

export interface MemoryEntry {
  id: string;
  scope: 'global' | 'project';
  scopeKey?: string;
  content: string;
  tags: string[];
  source?: 'agent' | 'user' | 'system';
  createdAt: number;
  updatedAt: number;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  rank: number;
}

export class MemoryRepository {
  store(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): MemoryEntry;
  search(query: string, scope?: { type: 'global' | 'project'; key?: string }, limit?: number): MemorySearchResult[];
  get(id: string): MemoryEntry | undefined;
  update(id: string, patch: Partial<Pick<MemoryEntry, 'content' | 'tags'>>): void;
  delete(id: string): void;
  list(scope?: { type: 'global' | 'project'; key?: string }): MemoryEntry[];
}
```

### 4.3 RPC Handlers

```typescript
// memory.store  { scope, scopeKey?, content, tags? } → MemoryEntry
// memory.search { query, scope?, limit? } → MemorySearchResult[]
// memory.delete { id } → void
// memory.list   { scope? } → MemoryEntry[]
// memory.update { id, content?, tags? } → MemoryEntry
```

### 4.4 Agent Tool Integration

Expose as Claude tools via the system prompt or a dedicated MCP server:

```xml
<tool name="store_memory">
  <description>Save a fact or decision to persistent memory for future sessions.</description>
  <parameter name="content" type="string" required="true"/>
  <parameter name="tags" type="array" items="string"/>
  <parameter name="scope" type="string" enum="global,project" default="project"/>
</tool>

<tool name="search_memory">
  <description>Search persistent memory for relevant facts or past decisions.</description>
  <parameter name="query" type="string" required="true"/>
  <parameter name="limit" type="integer" default="5"/>
</tool>
```

---

## 5. Complexity Estimates

| Approach | Complexity (1–5) | Notes |
|----------|-----------------|-------|
| A — SQLite FTS5 | **2** | One new table, one virtual table, ~200 LOC |
| B — sqlite-vec | **3** | Native extension bundling + embedding model |
| C — External vector DB | **4** | Service management, port, health checks |
| D — Tantivy/Sonic | **3** | Native bindings or extra process |
| E — LLM retrieval | **2** | Simple but slow; best as a layer |
| F — Hybrid FTS5 + vector | **4** | Combines A + B; complex RRF merge |

Recommended phased approach total: **2 → 4** (Phase 1 then Phase 2).

---

## 6. Open Questions for User Input

1. **Embedding model distribution**: Should NeoKai bundle a small (~25 MB) ONNX model for semantic embeddings, or rely on a user-installed Ollama instance? Bundling simplifies setup but increases binary size.

2. **Memory visibility**: Should agents be able to *read* all memory automatically (injected into system prompt), or only when they explicitly call `search_memory`? Automatic injection is simpler but wastes context tokens.

3. **Memory scope defaults**: Should project memory be scoped to `workspace_path` (current behavior for sessions) or to a NeoKai "room"? Room-scoped memory might be more intuitive for multi-project rooms.

4. **Memory expiry / pruning**: Should old memories expire (e.g., entries older than 90 days with no recent access get deleted)? Or is indefinite retention preferred?

5. **Memory encryption**: The existing `auth_config` row encrypts credentials. Should memory entries containing sensitive information also be encrypted at rest? (Adds complexity; current SQLite file is already protected by filesystem permissions.)

6. **Cross-agent sharing**: In a multi-agent space (Leader + Workers), should all agents share one memory store, or should each agent have its own isolated memory?

7. **Memory injection timing**: For Phase 1 (FTS5 only), the simplest approach is to let agents call `search_memory` as a tool. For Phase 2, should we also auto-inject the top-N memories into the system prompt at session start?

---

## 7. Summary Table

| | A: FTS5 | B: sqlite-vec | C: Qdrant | D: Tantivy | E: LLM | F: Hybrid |
|--|---------|--------------|-----------|-----------|--------|-----------|
| Retrieval latency | < 5 ms | ~50 ms | ~10 ms | < 1 ms | 200 ms+ | ~50 ms |
| Semantic search | No | Yes | Yes | No | Yes | Yes |
| New infra required | None | Native ext + model | Separate process | Native or process | None | Native ext + model |
| Implementation effort | Low | Medium | High | Medium | Low | High |
| Recommended phase | **Phase 1** | Phase 2 | Skip | Skip | Layer | **Long-term** |

---

## References

- [sqlite-vec](https://github.com/asg017/sqlite-vec) — SQLite vector search extension
- [SQLite FTS5](https://www.sqlite.org/fts5.html) — Official FTS5 documentation
- [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) — RRF paper
- [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) — Lightweight embedding model
- [HNSW algorithm](https://arxiv.org/abs/1603.09320) — Hierarchical Navigable Small World graphs
