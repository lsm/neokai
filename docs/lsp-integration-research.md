# LSP Integration Research: Claude Agent SDK & Native LSP for NeoKai

_Research date: 2026-03-24_

---

## Part 1: Claude Agent SDK Code Intelligence Capabilities

### 1.1 Built-in LSP Support

The `@anthropic-ai/claude-agent-sdk` (v0.2.81, currently used by NeoKai) does **not** embed LSP functionality natively. LSP in the Claude ecosystem lives as an extension layer in the Claude Code CLI binary. The SDK orchestrates an agent loop that calls into the CLI binary, which may or may not have LSP activated.

**Key facts:**
- The `LSP` tool was added in Claude Code v2.0.74 (December 2025)
- It is gated behind `ENABLE_LSP_TOOL=1` environment variable OR having a compatible Claude Code plugin installed
- There is a known race-condition bug (Issue #123 in `anthropics/claude-agent-sdk-typescript`): the CLI builds its tool list at startup before LSP finishes async initialization (~1.3 seconds). In SDK `query()` mode, the first API call fires immediately, permanently excluding LSP from the tool list. The issue was marked closed but user reports as late as February 2026 (v0.2.47+) confirm it persists.
- **Workaround**: Set `ENABLE_LSP_TOOL=1` in the daemon environment when spawning agents.

### 1.2 SDK Code Intelligence Primitives

| Capability | Available? | Notes |
|---|---|---|
| Tree-sitter / AST parsing | No | Open feature request (#34304) for `mode: "map"` in `Read` tool; third-party MCP only |
| Go-to-definition | Via `LSP` tool only | Requires plugin + language server binary installed |
| Find references | Via `LSP` tool only | Same requirement |
| Hover (type/docs) | Via `LSP` tool only | Same requirement |
| Inline diff primitives | No | SDK exposes `Edit` (string replace), `MultiEdit` (batch), `Write` (overwrite) |
| Multi-file edit coordination | Compositional | Agents sequence multiple `Edit`/`MultiEdit` calls; no atomic cross-file transaction |
| Diagnostics | Via `LSP` tool | Auto-injected after `Edit` calls when LSP is active |

### 1.3 Official Anthropic MCP Tools for Code Intelligence

Anthropic distributes LSP as **Claude Code plugins** (not MCP servers). Official plugins are in `anthropics/claude-plugins-official`:

| Language | Plugin | Binary Required |
|---|---|---|
| TypeScript/JS | `typescript-lsp` | `typescript-language-server` |
| Python | `pyright-lsp` | `pyright-langserver` |
| Go | `gopls-lsp` | `gopls` |
| Rust | `rust-analyzer-lsp` | `rust-analyzer` |
| C/C++ | `clangd-lsp` | `clangd` |
| Ruby | `ruby-lsp` | `ruby-lsp` |
| C# | `csharp-lsp` | `csharp-ls` |

These plugins configure LSP server connections that the CLI `LSP` tool then uses. The `modelcontextprotocol/servers` reference collection does **not** include an LSP or tree-sitter server from Anthropic. Third-party options exist (`wrale/mcp-server-tree-sitter`, Sourcegraph MCP integration).

### 1.4 How Claude Code CLI Handles LSP

The `LSP` tool supports these sub-operations:
- `goToDefinition`
- `findReferences`
- `hover` (type info + docs)
- `documentSymbol` (file structure: classes, functions)
- `getDiagnostics` (errors/warnings)
- `goToImplementation`
- Call hierarchy tracing

After every `Edit`, the language server automatically injects diagnostics back to the agent without explicit calls. Navigation ops use `file:line:col` addressing. Performance benefit: symbol-level lookups at ~50ms vs. text grep at tens of seconds for large codebases.

### 1.5 How NeoKai Could Leverage SDK LSP Today

**Immediate action (low effort, partial benefit):**
1. Set `ENABLE_LSP_TOOL=1` in the daemon's environment (in `packages/daemon/src/lib/agent/query-options-builder.ts` or as an env var in startup config)
2. Document that users need Claude Code LSP plugins installed (`~/.claude/plugins/`) for code intelligence to work

**Limitation**: This only works if the end user already has the relevant LSP binaries (`typescript-language-server`, `rust-analyzer`, etc.) installed locally and the appropriate Claude Code plugin configured. NeoKai has no control over this, and in cloud/container deployments there are no local LSP binaries.

### 1.6 Gaps Requiring Custom LSP Support

- No LSP in containerized/cloud deployments (no local binary access)
- No control over which language servers are installed
- The SDK race-condition bug means even with `ENABLE_LSP_TOOL=1` it may not be reliably active
- No structured code intelligence API for programmatic access from NeoKai daemon
- Agents have no code intelligence in the default NeoKai configuration today

---

## Part 2: Native LSP Integration Evaluation

### 2.1 Current NeoKai State

From codebase exploration:
- **No LSP infrastructure** currently exists
- **No AST/parsing libraries** installed (`tree-sitter`, TypeScript compiler API, etc.)
- **Clean handler architecture** makes it straightforward to add LSP as a new subsystem
- Agents have workspace context (`workspacePath`) and file system access
- MCP tool infrastructure exists and is well-understood

### 2.2 Approach Evaluation

#### Approach A: Enable Claude Code's Built-in LSP Tool

**Description**: Set `ENABLE_LSP_TOOL=1` and rely on the Claude Code CLI's native LSP tool with user-installed language server plugins.

| Factor | Rating | Notes |
|---|---|---|
| Implementation complexity | 1/5 | One env var + documentation |
| Feature completeness | 2/5 | All LSP features available IF user has binaries |
| Reliability | 2/5 | SDK race-condition bug; plugin dependency on user |
| Works in cloud/containers | 1/5 | No — requires local language server binaries |
| Maintenance burden | 1/5 | Anthropic maintains the feature |

**Verdict**: Good quick win for local dev scenarios but fails in cloud/container deployments. Not a standalone solution.

---

#### Approach B: MCP-Based LSP Proxy

**Description**: NeoKai spawns a local MCP server that proxies LSP protocol to standard language server processes (`tsserver`, `rust-analyzer`, `pylsp`). Agents call `mcp__lsp__goto_definition(file, position)`.

```
Agent → MCP Tool Call → NeoKai MCP Server → LSP stdio → tsserver
                                           ← JSON result ←
```

| Factor | Rating | Notes |
|---|---|---|
| Implementation complexity | 3/5 | Need LSP client implementation + MCP server glue |
| Feature completeness | 5/5 | Full LSP feature set via standard servers |
| Reliability | 4/5 | Standard language servers are battle-tested |
| Works in cloud/containers | 3/5 | Needs language servers in container image |
| Maintenance burden | 2/5 | LSP protocol changes are rare; server binaries maintained by community |
| Latency | ~50-200ms | One extra MCP hop; LSP itself is fast |

**Pros:**
- Works with all existing language servers without reimplementation
- Agents get well-structured tools with typed parameters
- Standard LSP semantics (no reinventing the wheel)
- Language server binaries are small and easily containerized

**Cons:**
- Need to ship language server binaries in container images or require user installation
- Each language requires a separate binary
- LSP server startup latency (first request cold start: 1-5 seconds)
- MCP tool call overhead per request

**Verdict**: Best balance of completeness and implementation effort. Recommended as primary approach.

---

#### Approach C: Embedded Tree-sitter

**Description**: NeoKai embeds Tree-sitter for parsing + custom symbol analysis. Provides LSP-like primitives (go-to-definition, find references) without external servers.

```
Agent → MCP Tool Call → NeoKai daemon → tree-sitter WASM → symbol result
```

| Factor | Rating | Notes |
|---|---|---|
| Implementation complexity | 4/5 | Need parser grammars + custom analysis per language |
| Feature completeness | 3/5 | Navigation OK; semantic type info limited |
| Reliability | 4/5 | No external process dependencies |
| Works in cloud/containers | 5/5 | WASM bundle, no external deps |
| Maintenance burden | 4/5 | Must maintain symbol analysis per language |
| Latency | ~5-20ms | Very fast; pure in-process |

**Pros:**
- Zero external dependencies; works everywhere
- Very fast (in-process WASM)
- Full control over feature set
- `tree-sitter-wasm` available for Node/Bun

**Cons:**
- Tree-sitter gives you syntax, not semantics. Type inference (hover types, overload resolution) requires full language server
- Must implement symbol analysis for each language grammar separately
- Find-references across files requires building and maintaining a project-wide symbol index
- Rename refactor with type awareness is hard to implement correctly
- Goes against the grain of "don't reinvent the wheel"

**Example libraries**: `web-tree-sitter` (WASM), `tree-sitter` (native Node addon), language grammars available for 100+ languages.

**Verdict**: Best for offline/zero-dependency scenarios, but semantic accuracy is significantly lower than a real LSP server. Good complement to Approach B for fast operations (symbol list, syntax highlights) but not a replacement.

---

#### Approach D: Lightweight Code Graph + Heuristics

**Description**: Parse files with Tree-sitter, build an in-memory symbol index (code graph). Agents query the graph for navigation. No full LSP protocol.

| Factor | Rating | Notes |
|---|---|---|
| Implementation complexity | 3/5 | Symbol indexer + query API; simpler than full LSP |
| Feature completeness | 2/5 | Covers 60-70% of use cases; no type info |
| Reliability | 4/5 | In-process, no external dependencies |
| Works in cloud/containers | 5/5 | No external deps |
| Maintenance burden | 3/5 | Symbol index must stay in sync with edits |

**Pros:**
- Simpler than full LSP protocol implementation
- Can be incrementally built (index on demand)
- Works well for symbol navigation in large codebases

**Cons:**
- No type information (hover docs, type signatures)
- Rename across files is heuristic only (may miss dynamic references)
- Requires re-indexing on file changes
- Still need per-language parsing logic

**Verdict**: Good fallback for languages without LSP servers, but not primary recommendation.

---

### 2.3 Recommended Approach: B + C Hybrid

**Primary: MCP-Based LSP Proxy (Approach B)** for semantic features (hover types, rename, diagnostics)
**Fallback: Tree-sitter (Approach C)** for fast structural operations when LSP is unavailable

This hybrid gives agents:
- Full semantic accuracy when language servers are available
- Graceful degradation to structural analysis when they are not
- Fast in-process operations for common structural queries (list symbols, find all occurrences by name)

---

## Part 3: Recommended Architecture

### 3.1 Directory Structure

```
packages/daemon/src/lib/
  lsp/
    index.ts                         # Public API: LspManager
    lsp-manager.ts                   # Lifecycle: spawn/stop/reuse LSP servers per workspace
    lsp-client.ts                    # JSON-RPC LSP client (stdio transport)
    lsp-mcp-server.ts                # MCP server that exposes LSP as tools
    tree-sitter/
      index.ts                       # Public API: TreeSitterIndex
      symbol-indexer.ts              # File → symbol table using tree-sitter
      languages/                     # Per-language grammar configs
        typescript.ts
        python.ts
        rust.ts
    servers/
      typescript.ts                  # tsserver / typescript-language-server config
      python.ts                      # pylsp / pyright-langserver config
      rust.ts                        # rust-analyzer config
      registry.ts                    # Language → server binary mapping
  rpc-handlers/
    lsp-handlers.ts                  # RPC: lsp.hover, lsp.goto, lsp.refs, lsp.rename, lsp.diag
```

### 3.2 LSP Server Lifecycle

```
Per workspace (not per session):
  1. Project opened → detect languages via file extensions
  2. LspManager.getOrSpawnServer(workspace, language) → LspClient
  3. LspClient connects via stdio, sends initialize request
  4. Server is kept alive while any session in the workspace is active
  5. Workspace closed / idle timeout → server killed
```

**Rationale for per-workspace (not per-session):**
- Language servers index the entire project and maintain internal caches
- Spawning one per session wastes memory and init time
- Multiple agents working on the same codebase share the same language server view

### 3.3 MCP Tool Definitions for Agents

The LSP capabilities would be exposed as MCP tools callable by agents:

```typescript
// packages/daemon/src/lib/lsp/lsp-mcp-server.ts

const LSP_TOOLS = [
  {
    name: 'lsp__hover',
    description: 'Get type information and documentation for the symbol at a position',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Absolute file path' },
        line: { type: 'number', description: '0-indexed line number' },
        character: { type: 'number', description: '0-indexed character offset' },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'lsp__goto_definition',
    description: 'Jump to where a function, variable, or type is defined',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        line: { type: 'number' },
        character: { type: 'number' },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'lsp__find_references',
    description: 'Find all usages of the symbol at this position across the project',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        line: { type: 'number' },
        character: { type: 'number' },
        includeDeclaration: { type: 'boolean', default: false },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'lsp__rename',
    description: 'Rename a symbol across all files in the project',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        line: { type: 'number' },
        character: { type: 'number' },
        newName: { type: 'string' },
      },
      required: ['file', 'line', 'character', 'newName'],
    },
  },
  {
    name: 'lsp__diagnostics',
    description: 'Get current errors and warnings for a file',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
      },
      required: ['file'],
    },
  },
  {
    name: 'lsp__completion',
    description: 'Get completion suggestions at a position',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        line: { type: 'number' },
        character: { type: 'number' },
      },
      required: ['file', 'line', 'character'],
    },
  },
  {
    name: 'lsp__document_symbols',
    description: 'List all symbols (functions, classes, variables) in a file',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
      },
      required: ['file'],
    },
  },
  {
    name: 'lsp__workspace_symbols',
    description: 'Search for symbols by name across the entire project',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol name or prefix to search for' },
      },
      required: ['query'],
    },
  },
];
```

### 3.4 Example Agent Interaction Flow

```
Agent working on TypeScript codebase:

1. Agent reads a file, sees `getUserById(id)` on line 45
2. Agent calls: lsp__goto_definition({ file: "src/api.ts", line: 45, character: 12 })
3. → LspManager finds existing tsserver for this workspace
4. → LspClient sends textDocument/definition request
5. → tsserver returns: { uri: "src/db/users.ts", range: { start: {line: 23} } }
6. Agent reads: src/db/users.ts:23 — sees the full implementation
7. Agent calls: lsp__find_references({ file: "src/db/users.ts", line: 23, character: 17 })
8. → Returns all 12 call sites across the project
9. Agent makes targeted edits at each call site knowing exact locations
```

### 3.5 Integration Points in NeoKai

**1. Session startup**: When an agent session starts, register the MCP LSP server in the session's MCP config if `tools.useLspTools` is enabled.

```typescript
// In query-options-builder.ts
if (sessionConfig.tools?.useLspTools) {
  mcpServers['__neokai_lsp'] = {
    type: 'stdio',
    command: process.execPath,
    args: [lspMcpServerEntrypoint, workspacePath],
  };
}
```

**2. Language detection**: On workspace open, scan for language markers (`tsconfig.json` → TypeScript, `Cargo.toml` → Rust, `pyproject.toml` / `setup.py` → Python).

**3. Daemon startup**: `LspManager` initialized as a singleton in `DaemonApp`, shared across sessions.

**4. RPC exposure**: Add `lsp.*` RPC handlers for the frontend to show LSP status (which servers are running, which languages are active).

---

## Part 4: Open Questions

### Latency Budget
- What's acceptable for agent LSP operations? Suggested: < 200ms for cached queries, < 2s for cold start
- Should the LSP server warm up proactively when a session starts, or lazy-initialize on first use?
- Recommendation: warm up proactively for TypeScript/Python/Rust (most common); lazy for others

### Language Priority
Which languages to support in Phase 1?
- **Must have**: TypeScript/JavaScript (NeoKai is a TypeScript project; most agents work on TS codebases)
- **Should have**: Python (common in AI/ML projects agents work on)
- **Nice to have**: Rust, Go
- **Later**: Ruby, C#, Java, etc.

### Always-On vs On-Demand
- **Always-on**: LSP tools always in system prompt, agent decides when to use them
  - Pro: agent can use LSP at any time without explicit user configuration
  - Con: increases tool count, may confuse agents that don't need LSP
- **On-demand**: LSP tools enabled per session/room via config
  - Pro: clean separation, opt-in, doesn't bloat tool list for simple tasks
  - Con: friction for users who always want code intelligence
- **Recommendation**: On-demand per session, with a room-level default setting

### Multi-Language Projects (Polyglot)
- One LspManager should support multiple language servers per workspace
- Language detection should be per-file based on extension, not per-workspace
- Tool calls should route to the correct server based on file extension

### State Sharing
- **Shared across sessions in same workspace**: Yes — reduces cold start latency, consistent diagnostics
- **Fresh per session**: No — wasteful, slower
- **Exception**: Sessions with different `cwd` or git branches should get separate LSP instances to avoid cross-contamination

### Container/Cloud Deployments
- Without language server binaries, MCP LSP proxy silently degrades to tree-sitter fallback
- NeoKai should provide a Docker base image layer with common language servers pre-installed
- Alternative: agent detects missing LSP and installs server via `bun add -g typescript-language-server` automatically

### Rename Safety
- LSP rename is purely syntactic — it renames all symbol references but won't catch dynamic access patterns (e.g., `obj['methodName']` in JavaScript)
- Agents should be prompted to verify rename results with `lsp__find_references` before committing
- Add a `dryRun` parameter to `lsp__rename` that returns the proposed edits without applying them

---

## Summary

| | Approach A (SDK LSP) | Approach B (MCP Proxy) | Approach C (Tree-sitter) | Approach D (Code Graph) |
|---|---|---|---|---|
| Complexity | 1/5 | 3/5 | 4/5 | 3/5 |
| Feature completeness | 2/5 | 5/5 | 3/5 | 2/5 |
| Cloud/container ready | 1/5 | 3/5 | 5/5 | 5/5 |
| Semantic accuracy | 2/5 | 5/5 | 2/5 | 2/5 |
| Maintenance | 1/5 | 2/5 | 4/5 | 3/5 |

**Recommended path:**
1. **Immediate** (1-2 days): Set `ENABLE_LSP_TOOL=1` in daemon environment. Zero code change, unlocks LSP for local dev users who have plugins installed.
2. **Phase 1** (2-4 weeks): Implement MCP-based LSP proxy for TypeScript and Python. Agents get `lsp__*` tools in their system prompt when enabled.
3. **Phase 2** (4-8 weeks): Add Tree-sitter fallback for structural queries; works everywhere without binary dependencies.
4. **Phase 3** (ongoing): Expand language support; add workspace-level LSP status UI in NeoKai frontend.
