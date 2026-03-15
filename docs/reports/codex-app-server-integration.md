# Codex App Server as a Transparent AgentSession Backend

**Date:** 2026-03-14
**Status:** POC Implemented
**Files:**
- `packages/daemon/src/lib/providers/codex-app-server-adapter.ts`
- `packages/daemon/src/lib/providers/codex-app-server-provider.ts`
- `packages/daemon/tests/unit/providers/codex-app-server-adapter.test.ts`

---

## Executive Summary

**YES — `codex app-server` can serve as a transparent backend for NeoKai's AgentSession.**

The App Server exposes a JSON-RPC 2.0 (lite) daemon over stdio with a first-class mechanism
called **Dynamic Tools** (experimental API v2). When the LLM wants to call a registered tool,
Codex pauses and sends an `item/tool/call` _server request_ (JSON-RPC request from server to
client) to NeoKai. NeoKai executes the tool via its own handlers and returns the result. The LLM
resumes with the result injected into context.

This is fundamentally different from the `codex exec` approach (used in `CodexCliProvider`) where
tools execute inside the subprocess with no interception. The App Server gives NeoKai the same
control over tool execution that it has with the Claude Agent SDK.

---

## 1. Protocol Overview

### Transport

```
codex app-server --listen stdio://    (default)
codex app-server --listen ws://IP:PORT  (experimental WebSocket)
```

Wire format: newline-delimited JSON (JSONL) on stdin/stdout.
Note: the `"jsonrpc":"2.0"` field is **omitted** on the wire (a "lite" variant of JSON-RPC 2.0).

### Three message shapes

```
Client → Server (request):     { "method": "...", "id": N, "params": {...} }
Client → Server (notification): { "method": "..." }
Server → Client (response):    { "id": N, "result": {...} } or { "id": N, "error": {...} }
Server → Client (notification): { "method": "...", "params": {...} }
Server → Client (server request): { "method": "...", "id": "srv-N", "params": {...} }
```

**Server requests** (method + id) require the client to respond immediately. They arrive
interleaved with regular notifications in the read loop.

### Initialization handshake

```json
// Client → Server
{ "method": "initialize", "id": 0, "params": {
    "clientInfo": { "name": "neokai", "title": "NeoKai", "version": "1.0.0" },
    "capabilities": { "experimentalApi": true }
} }
// Server → Client
{ "id": 0, "result": { "serverInfo": { ... } } }
// Client → Server (notification, no response)
{ "method": "initialized" }
```

`experimentalApi: true` is **required** to use Dynamic Tools. Without it, `item/tool/call`
requests are rejected by the server with an error response.

---

## 2. Dynamic Tools — The Key Mechanism

### Registration at `thread/start`

NeoKai's tools (from `ProviderQueryOptions.tools`) are registered as `dynamicTools` when
starting a thread. Each tool maps directly from NeoKai's `ToolDefinition`:

```json
// Client → Server
{ "method": "thread/start", "id": 1, "params": {
    "model": "gpt-5.3-codex",
    "workingDirectory": "/path/to/project",
    "dynamicTools": [
      {
        "name": "bash",
        "description": "Execute a shell command",
        "inputSchema": { "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"] },
        "deferLoading": false
      },
      {
        "name": "str_replace_editor",
        "description": "Edit a file",
        "inputSchema": { ... },
        "deferLoading": false
      }
    ]
} }
// Server → Client
{ "id": 1, "result": { "threadId": "thread-abc123" } }
```

### Tool call interception flow

When the LLM decides to call a dynamic tool:

```
1. Server → Client (notification):
   { "method": "item/started", "params": { "item": { "id": "item-5", "type": "dynamicToolCall" } } }

2. Server → Client (SERVER REQUEST — must respond):
   { "method": "item/tool/call", "id": "srv-req-1", "params": {
       "threadId": "thread-abc123",
       "turnId": "turn-xyz456",
       "callId": "call-001",
       "tool": "bash",
       "arguments": { "command": "ls -la src/" }
   } }

3. NeoKai executes the tool via its MCP tool handler

4. Client → Server (response to server request):
   { "id": "srv-req-1", "result": {
       "success": true,
       "contentItems": [{ "type": "inputText", "text": "src/\n  lib/\n  main.ts\n" }]
   } }

5. Server → Client (notification):
   { "method": "item/completed", "params": { "item": { "id": "item-5", "type": "dynamicToolCall", "status": "completed" } } }

6. LLM continues with the tool result in context
```

### Tool result format

`DynamicToolCallResponse.contentItems` supports two content types:
- `{ "type": "inputText", "text": "..." }` — text result (most tools)
- `{ "type": "inputImage", "imageUrl": "data:image/..." }` — image result (for vision tools)

### Built-in tool approvals (separate mechanism)

Codex has built-in tools (bash sandbox, apply_patch). These trigger approval server requests:
- `item/commandExecution/requestApproval` — for built-in shell execution
- `item/fileChange/requestApproval` — for built-in file patching
- `item/permissions/requestApproval` — for sandbox permission upgrades

The adapter auto-accepts these (`{ "decision": "accept" }`). For full NeoKai transparency,
set `sandboxPolicy: { type: "readOnly" }` at `thread/start` to prevent built-in tool execution
and register all tools as dynamic tools instead.

---

## 3. Architecture: `AppServerConnection`

The adapter implements a `AppServerConnection` class that manages the subprocess and the
bidirectional JSON-RPC protocol:

```
NeoKai AgentSession
    │
    ▼
codexAppServerQueryGenerator()
    │
    ├── AppServerConnection.create(codexPath, cwd, apiKey)
    │   ├── Bun.spawn('codex app-server', { stdout: pipe, stdin: pipe })
    │   └── startReadLoop() → background task multiplexing 3 message types
    │
    ├── conn.initialize()  → experimentalApi: true
    │
    ├── conn.startThread(model, cwd, options.tools as dynamicTools)
    │   └── returns threadId
    │
    ├── conn.startTurn(threadId, userMessageText)
    │   └── returns turnId
    │
    ├── [notification + server-request loop]
    │   │
    │   ├── item/agentMessage/delta  →  stream_event SDKMessage  →  AsyncQueue
    │   ├── item/started (tool)     →  tool_progress(0)          →  AsyncQueue
    │   ├── item/completed (msg)    →  SDKAssistantMessage        →  AsyncQueue
    │   ├── item/completed (tool)   →  tool_progress(elapsed)     →  AsyncQueue
    │   ├── turn/completed          →  'done' sentinel            →  AsyncQueue
    │   │
    │   └── item/tool/call SERVER REQUEST
    │       ├── call toolExecutor(toolName, args, callId)
    │       └── respond { success, contentItems }
    │
    ├── [generator drains AsyncQueue, yields SDKMessages]
    │
    └── finally: conn.kill(), remove abort listener
```

### Read loop multiplexer

The background read loop handles 3 message shapes from the same stdout stream:

```typescript
// server request: has both 'method' AND 'id'
if ('method' in msg && 'id' in msg) {
  const handler = serverRequestHandlers.get(msg.method);
  const result = handler ? await handler(msg.params) : {};
  write({ id: msg.id, result });
}
// notification: has 'method' but no 'id'
else if ('method' in msg) {
  notificationHandlers.get(msg.method)?.(msg.params);
}
// response to our request: has 'id' but no 'method'
else if ('id' in msg) {
  pendingRequests.get(msg.id)?.resolve(msg.result);
}
```

### AsyncQueue decouples read loop from generator

The notification handlers push `SDKMessage | 'done' | Error` onto an `AsyncQueue`. The
generator drains the queue with `await queue.next()`. This decouples the real-time read loop
from the generator's pull-based iteration without blocking either side.

---

## 4. Comparison: `codex exec` vs `codex app-server`

| Dimension | `codex exec` (CodexCliProvider) | `codex app-server` (CodexAppServerProvider) |
|-----------|----------------------------------|----------------------------------------------|
| Process model | Spawn per query, exits on done | Long-lived daemon (POC: spawn per query) |
| Tool execution | Codex runs tools internally | NeoKai intercepts via `item/tool/call` |
| Tool control | None — fully autonomous | Full — NeoKai executes and returns results |
| NeoKai tool defs | Ignored (documented) | Registered as dynamicTools, fully exercised |
| Multi-turn | New thread each query | Thread persists (supports `thread/resume`) |
| Streaming | JSONL from stdout | JSON-RPC notifications (same wire, richer) |
| Session resume | Not possible | `conn.request('thread/resume', { threadId })` |
| Sandboxing | Codex's own sandbox | Configurable: `sandboxPolicy: readOnly` = off |
| API requirement | None | `experimentalApi: true` required |
| Startup cost | ~50ms per query | ~200ms first query, ~0ms subsequent (daemon) |
| Protocol complexity | Simple JSONL | Bidirectional JSON-RPC (more complex) |
| Transparency to NeoKai | Low | **High — matches Claude Agent SDK behavior** |

---

## 5. Current POC Limitations

### 5.1 `toolExecutor` not wired from AgentSession

The provider calls `codexAppServerQueryGenerator(..., undefined)` — the tool executor is `null`.
When the LLM calls a tool, the adapter responds with:
```json
{ "success": false, "contentItems": [{ "type": "inputText", "text": "No tool executor available" }] }
```

**What's needed:** Thread the MCP `ToolExecutionCallback` from `AgentSession` through the
provider's `createQuery()` method. The callback signature already matches `pimono-adapter.ts`:
```typescript
type ToolExecutionCallback = (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
) => Promise<{ output: unknown; isError: boolean }>;
```

### 5.2 Spawn per query (not long-lived daemon)

Each `createQuery()` call spawns a new `codex app-server` process and terminates it when the
query completes. This adds ~200ms startup overhead per query and loses thread history.

**What's needed:** A shared `AppServerConnection` instance per `CodexAppServerProvider` (or per
daemon process), with a connection pool for concurrency. The provider would maintain:
```typescript
private connection: AppServerConnection | null = null;
private async getConnection(): Promise<AppServerConnection> { ... }
```

### 5.3 No image content in tool results

`DynamicToolCallResponse.contentItems` supports `inputImage` with a data URL, but the current
adapter only serializes tool output to text. Screenshot/vision tool results are not forwarded.

### 5.4 Built-in tools still execute

Codex's built-in sandbox tools (`bash`, `apply_patch`) execute alongside dynamic tools. To make
the App Server fully transparent (all execution through NeoKai), set:
```typescript
{ sandboxPolicy: { type: 'readOnly' } }
```
in `thread/start` params. This disables built-in command/file execution and forces the LLM to
use only the registered dynamic tools.

---

## 6. Integration Path for Full Transparency

Two blockers must be resolved before Dynamic Tools work end-to-end.

### Blocker A: `query-runner.ts` passes `tools: []` to all custom-query providers

`packages/daemon/src/lib/agent/query-runner.ts` currently hardcodes `tools: []` when building
`ProviderQueryOptions` for custom-query providers (including Codex App Server):

```typescript
// packages/daemon/src/lib/agent/query-runner.ts ~line 228
const customQueryOptions: ProviderQueryOptions = {
  ...
  tools: [],  // ← always empty; Codex App Server gets zero Dynamic Tools
  ...
};
```

The reason `queryOptions.tools` (from `QueryOptionsBuilder`) cannot simply be forwarded here is
that it holds the SDK-native tool spec (`string[] | { type: "preset"; preset: "claude_code" }`)
which is incompatible with `ToolDefinition[]`. To fix this, NeoKai's MCP tool definitions must be
separately assembled as `ToolDefinition[]` objects and injected here. The `QueryOptionsBuilder`
does not currently produce `ToolDefinition` objects — it produces the SDK preset name.

**Required change:** Expose a `getMcpToolDefinitions(): ToolDefinition[]` method on
`AgentSession` (or `QueryOptionsBuilder`) and populate `customQueryOptions.tools` with the
result before calling `provider.createQuery()`.

### Step 1: Wire `toolExecutor` from AgentSession

Once `customQueryOptions.tools` has real `ToolDefinition` entries (Blocker A), wire the MCP
tool execution callback into the provider:

```typescript
// In the query runner, after creating the provider query:
const toolExecutor: ToolExecutionCallback = async (toolName, toolInput, toolUseId) => {
  const result = await mcpServer.callTool(toolName, toolInput);
  return { output: result.content, isError: result.isError };
};

// Pass to provider via createQuery extension, or inject into provider config
```

Currently `CodexAppServerProvider.createQuery()` passes `toolExecutor: undefined`. The provider
interface's `createQuery()` signature must be extended to accept an optional `toolExecutor`
parameter, or the executor must be injected via provider configuration.

### Step 2: Add sandbox policy option

Expose `sandboxPolicy` in `CodexAppServerAdapterConfig` and set `readOnly` for fully
transparent operation (no built-in tool execution, all tools through NeoKai).

### Step 3: Long-lived connection pooling

Move the `AppServerConnection` lifecycle from per-query to per-provider-instance, with
connection recycling and health-checking for daemon stability.

### Step 4: Thread resumption for multi-turn

Store `threadId` in NeoKai's `SessionConfig.providerMetadata` after `thread/start`. On
subsequent queries in the same NeoKai session, call `thread/resume` instead of `thread/start`
to restore conversation context.

---

## 7. Recommendation

The `codex app-server` with Dynamic Tools is the correct path for making OpenAI Codex models
work transparently under NeoKai's AgentSession. It provides:

1. **Full tool call interception** — NeoKai executes tools, not Codex
2. **Streaming responses** — `item/agentMessage/delta` matches Claude SDK's text streaming
3. **Multi-turn with persistence** — threads can be resumed across queries
4. **Configurable sandboxing** — NeoKai can disable Codex's built-in execution entirely

The primary blocker is wiring the `ToolExecutionCallback` from `AgentSession` into the provider.
This requires a small architectural change to how `createQuery()` receives execution context.

The `codex exec` adapter (`CodexCliProvider`) remains useful for fully autonomous task delegation
where NeoKai does not need tool control. The two providers serve different use cases:

| Provider | Use Case |
|----------|----------|
| `openai-codex-app-server` | Transparent model access with NeoKai tool control |
| `openai-codex-cli` | Fully autonomous task delegation to Codex |
| `openai` (pi-mono) | Current implementation, fix needed for tool use |
