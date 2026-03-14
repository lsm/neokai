# Codex CLI Tool Integration

**Date:** 2026-03-14
**Status:** Investigation Report
**Scope:** Comparing NeoKai's tool execution model with OpenAI Codex CLI, analyzing integration
patterns and their trade-offs

---

## 1. Introduction

Tool execution is the deepest architectural mismatch between NeoKai's agent pipeline and the
OpenAI Codex CLI. NeoKai maintains full visibility and control over every tool call: the Claude
Agent SDK surfaces `tool_use` blocks in assistant messages, NeoKai executes the corresponding MCP
server tool, and feeds the `tool_result` back as a user message. Codex CLI inverts this entirely —
tools are resolved inside the Codex process and the caller receives only the final agent response.

This report maps both execution models in detail, evaluates four integration patterns, and
recommends the approach best aligned with NeoKai's architecture.

---

## 2. NeoKai's Tool Execution Model

### 2.1 Flow

```
User message
    |
    v
NeoKai MessageQueue  -->  Claude Agent SDK (query() generator)
                                |
                                v
                       [LLM API call — Anthropic]
                                |
                                v
                   SDKAssistantMessage (tool_use block)
                                |
                         NeoKai dispatches
                                |
                                v
                       MCP Server Tool execution
                         (bash, file ops, etc.)
                                |
                                v
                   SDKUserMessage (tool_result block)
                                |
                          fed back to SDK
                                |
                                v
                   SDKAssistantMessage (text block)
                                |
                                v
                   SDKResultMessage (success)
```

### 2.2 Key Code Paths

**`packages/daemon/src/lib/agent/query-runner.ts`** — `QueryRunner.runQuery()` iterates over the
`query()` generator and calls `onSDKMessage()` for each yielded message.

**`packages/daemon/src/lib/agent/sdk-message-handler.ts`** — `SDKMessageHandler.handleMessage()`
processes incoming messages, tracking `tool_use` blocks in `handleAssistantMessage()` to increment
`session.metadata.toolCallCount`.

**`packages/daemon/src/lib/providers/pimono-adapter.ts`** — `piMonoQueryGenerator()` illustrates
how tool execution works in the custom provider path: `convertToAgentTools()` wraps NeoKai tool
definitions as `AgentTool` objects with an `execute` callback; pi-agent-core calls that callback
when the LLM issues a tool call, then pi-agent-core handles the tool-result injection internally.

### 2.3 Properties

| Property | NeoKai (Claude Agent SDK path) | NeoKai (pi-mono path) |
|---|---|---|
| Tool definitions source | Claude Agent SDK built-ins + MCP servers | MCP server tools passed as `ToolDefinition[]` |
| Tool execution location | MCP server subprocess | `ToolExecutionCallback` in daemon process |
| Tool result injection | SDK manages internally | pi-agent-core manages internally |
| Caller visibility | `tool_use` and `tool_result` blocks in messages | `tool_execution_start/end` events |
| Permission gating | `canUseTool` callback | Not implemented (always executes) |
| NeoKai controls which tools | Yes — via tool name allowlists | Yes — via `ProviderQueryOptions.tools` |

---

## 3. Codex CLI Tool Execution Model

### 3.1 Flow

```
User prompt (stdin or JSON-RPC)
    |
    v
Codex CLI process
    |
    v
[LLM API call — OpenAI]
    |
    v
[Tool call decided by model]
    |
    v
Codex ToolRouter (internal)
    |       |         |
    v       v         v
  Shell   Patch   Web Search
 execute  apply    request
    |       |         |
    v       v         v
[Tool result injected back to model — internal]
    |
    v
[LLM continues — next turn]
    |
    v
Final agent_message
    |
    v
JSONL event stream to caller
```

### 3.2 Properties

| Property | Codex CLI |
|---|---|
| Tool definitions source | Built-in: shell execution, file patching, web search, JS REPL |
| Tool execution location | Inside the Codex process |
| Tool result injection | Codex manages internally; never surfaced to caller |
| Caller visibility | `item.started/completed` with `type: "command_execution"` (tool name and output) |
| Permission gating | `ToolRouter` enforces `approval` policies: `untrusted`, `on-request`, `never` |
| Sandbox | `read-only`, `workspace-write`, `danger-full-access` (via `--sandbox` flag) |
| Caller controls which tools | No — caller cannot inject custom tool definitions |
| Caller receives tool results | No — only final agent message |

### 3.3 Sandbox Levels

Codex uses a three-tier sandbox model that governs what its built-in tools can do:

| Sandbox Level | What is Permitted |
|---|---|
| `read-only` | Read files, list directories, run read-only shell commands |
| `workspace-write` | Read + write within the designated workspace directory |
| `danger-full-access` (`--yolo`) | Unrestricted shell execution, arbitrary file writes |

There is no mechanism for the caller to specify per-tool permissions. The `--full-auto` flag
combines `danger-full-access` with auto-approval of all tool calls, making Codex fully autonomous.

---

## 4. Architectural Mismatch Analysis

The core incompatibility can be stated directly:

**NeoKai expects an agent that surfaces `tool_use` blocks so NeoKai can execute tools and return
`tool_result` blocks. Codex never emits `tool_use` blocks; it executes tools itself and returns
only the final response.**

This has several downstream consequences:

1. **NeoKai's MCP tools cannot be used.** Codex's ToolRouter only knows its own built-in tools.
   NeoKai's `Bash`, `FileEdit`, `FileRead`, `TodoWrite`, and other SDK tools are invisible to Codex.

2. **`session.metadata.toolCallCount` cannot be accurately populated.** The adapter can count
   `command_execution` items, but these are shell commands — not the named NeoKai tools tracked
   by `handleAssistantMessage()`.

3. **`canUseTool` permission callbacks do not apply.** NeoKai's `AskUserQuestionHandler` and
   permission gating are implemented as `canUseTool` callbacks passed to the SDK. There is no
   equivalent hook in the Codex API.

4. **Tool results are opaque.** NeoKai's UI displays tool output via `tool_result` content blocks.
   With Codex, tool output is embedded in the `command_execution` item's `output` field but is not
   surfaced in the final `agent_message`. The adapter can emit a synthetic `SDKToolProgressMessage`
   for visibility, but the actual output is not included.

5. **No mid-turn steering.** NeoKai's `MessageQueue` allows injecting user messages between tool
   calls while the SDK is running. This is used for features like the `/context` command and manual
   steering. Codex's single-invocation model has no equivalent.

---

## 5. Integration Patterns

Four distinct integration patterns are viable. Each has different trade-offs for transparency,
complexity, and feature coverage.

### Pattern A: Delegate Entire Subtask to Codex (`--full-auto`)

**Description:** NeoKai treats Codex as an autonomous sub-agent. When the user requests a task,
NeoKai launches `codex exec --full-auto --json "task description"` in the session's working
directory and translates the output event stream into `SDKMessage` objects for display.

```
User message
    |
    v
NeoKai adapter
    |  spawns process
    v
codex exec --full-auto --json "task"
    |
    v
[JSONL event stream]
    |
    v
Adapter translates to SDKMessages
    |
    v
NeoKai MessageHub / UI
```

**Trade-offs:**

| Factor | Assessment |
|---|---|
| Implementation complexity | Low — adapter only needs to translate event stream |
| NeoKai tool interop | None — Codex uses its own tools |
| Context window visibility | Limited — only token counts from `turn.completed` |
| Permission gating | None — Codex is fully autonomous |
| Multi-turn support | Via `--thread-id` across invocations |
| Cost tracking | Not available (Codex does not report cost) |
| Suitable for | Delegating fully self-contained coding tasks |

**Code analogy:** This mirrors `piMonoQueryGenerator()` in `pimono-adapter.ts`, where a
subprocess runs the full agent loop and NeoKai translates events. The difference is that
pi-agent-core does accept NeoKai tool definitions; Codex does not.

---

### Pattern B: Expose NeoKai Tools as MCP Server to Codex

**Description:** NeoKai starts a local MCP server that exposes its own tool definitions. Codex is
configured (via `codex.toml`) to connect to this MCP server as a tool provider. Codex can then
call NeoKai's tools via the MCP protocol.

```
User message
    |
    v
NeoKai starts MCP server (local)
    |
    v
codex exec --json "task" (configured with NeoKai MCP server)
    |
    v
[LLM wants to call NeoKai tool]
    |
    v
Codex ToolRouter calls NeoKai MCP server
    |
    v
NeoKai MCP server executes tool
    |
    v
MCP tool result returned to Codex
    |
    v
Codex continues turn
    |
    v
Final agent_message to NeoKai
```

**Trade-offs:**

| Factor | Assessment |
|---|---|
| Implementation complexity | High — requires NeoKai to implement a full MCP server endpoint |
| NeoKai tool interop | Full — Codex can invoke NeoKai tools via MCP |
| Context window visibility | Limited — same as Pattern A |
| Permission gating | Partial — NeoKai MCP server can implement its own permission logic |
| Multi-turn support | Via `--thread-id`; MCP server must survive across invocations |
| Suitable for | Use cases requiring NeoKai tool access from a Codex-backed agent |

**Key consideration:** The NeoKai daemon already uses MCP servers as tool providers (inbound
direction). Running NeoKai as an outbound MCP server requires a new server endpoint, state
sharing between the adapter and the MCP server, and per-session routing of MCP calls. This is
significant new infrastructure.

---

### Pattern C: Use Codex as MCP Tool Within NeoKai Agents

**Description:** Codex exposes itself as an MCP server via `codex mcp-server`. NeoKai configures
this as an MCP server in its session, making `codex` callable as a tool by the Claude Agent SDK's
model.

```
User message
    |
    v
NeoKai (Claude Agent SDK)
    |
    v
[Claude LLM — tool_use: "codex"]
    |
    v
NeoKai dispatches to codex MCP tool
    |
    v
codex mcp-server executes subtask
    |
    v
tool_result returned to NeoKai
    |
    v
Claude LLM continues
```

**Trade-offs:**

| Factor | Assessment |
|---|---|
| Implementation complexity | Low-medium — configure Codex as an MCP server, no new adapter needed |
| NeoKai tool interop | Full NeoKai tool access on the outer agent; Codex has its own tools internally |
| Context window visibility | Full — outer Claude Agent SDK session is unchanged |
| Permission gating | Full — NeoKai's `canUseTool` applies to the `codex` MCP tool call |
| Multi-turn support | Handled by outer Claude Agent SDK session |
| Suitable for | Delegating specific subtasks to Codex while keeping NeoKai in overall control |
| Key constraint | Codex `mcp-server` mode is a separate binary invocation; requires Codex installed |

**This is the cleanest architectural fit.** NeoKai's core agent loop remains unchanged. The
Claude model decides when to delegate to Codex. NeoKai retains full session state, context
tracking, and tool visibility for its own tools. The Codex invocation is opaque but bounded.

---

### Pattern D: Direct OpenAI API (Keep pi-mono Adapter)

**Description:** Use NeoKai's existing pi-mono adapter path (`piMonoQueryGenerator()`) with an
OpenAI model directly. This bypasses Codex entirely and uses the same OpenAI API that Codex
connects to internally.

```
User message
    |
    v
piMonoQueryGenerator (pimono-adapter.ts)
    |
    v
pi-agent-core Agent (multi-turn tool calling)
    |
    v
[OpenAI API call]
    |
    v
[Tool call — pi-agent-core dispatches to NeoKai ToolExecutionCallback]
    |
    v
NeoKai tool executes
    |
    v
Tool result injected by pi-agent-core
    |
    v
SDKMessage events yielded
    |
    v
NeoKai SDKMessageHandler (unchanged)
```

**Trade-offs:**

| Factor | Assessment |
|---|---|
| Implementation complexity | None — already implemented |
| NeoKai tool interop | Full — pi-agent-core calls back to NeoKai's tool executor |
| Context window visibility | Via `updateContextInfoFromUsage()` in SDKMessageHandler |
| Permission gating | Not implemented in pi-mono path |
| Multi-turn support | pi-agent-core manages internally per-invocation |
| Suitable for | Full NeoKai feature parity with OpenAI models |
| Key constraint | Does not use Codex-specific features (system prompt optimizations, built-in file patching) |

---

## 6. Error Handling

### 6.1 Codex Process Errors

The Codex process may terminate with errors at any point. The adapter must handle:

- **Startup failure** — process exits before emitting `thread.started`. Emit
  `SDKResultMessage` with `subtype: "error_during_execution"`, `errors: ["Codex process failed to start"]`.
- **Authentication error** — typically exit code `1` with stderr containing `"authentication"` or
  `"API key"`. Map to `ErrorCategory.AUTHENTICATION` in NeoKai's `ErrorManager`.
- **Rate limit** — stderr containing `"rate limit"` or HTTP 429. Map to `ErrorCategory.RATE_LIMIT`.
- **Network failure** — `ECONNREFUSED` or `ENOTFOUND`. Map to `ErrorCategory.CONNECTION`.
- **Sandbox violation** — Codex may refuse a command that exceeds the configured sandbox level.
  This results in an `item.completed` with `exit_code != 0`; the adapter should surface this as
  a `SDKToolProgressMessage` with tool name and a synthetic error message.

### 6.2 Startup Timeout

`QueryRunner` uses a `STARTUP_TIMEOUT_MS` (default 15 000 ms) to detect unresponsive backends.
The Codex adapter should respect this by aborting the Codex process if `thread.started` is not
received within the timeout window. The timeout value can be overridden via
`NEOKAI_SDK_STARTUP_TIMEOUT_MS`.

### 6.3 Abort and Cancellation

NeoKai exposes an `AbortSignal` to all query generators (`ProviderQueryContext.signal`). When
this signal fires, the adapter must:

1. Send SIGTERM (or SIGINT) to the Codex child process.
2. Wait for process exit (with a short grace period; send SIGKILL if needed).
3. Emit `SDKResultMessage` with `subtype: "error_during_execution"`, `stop_reason: "aborted"`.

The pi-mono adapter calls `agent.abort()` for the same purpose; the Codex adapter would call
`process.kill()` on the child process.

---

## 7. Timeout Considerations

| Timeout | Source | Default | Notes |
|---|---|---|---|
| Startup timeout | `NEOKAI_SDK_STARTUP_TIMEOUT_MS` | 15 000 ms | Time for first event from Codex |
| Per-tool timeout | Codex internal | Varies | Codex does not expose per-tool timeouts to caller |
| Overall turn timeout | Not defined in NeoKai | None | Consider adding for long-running tasks |
| Thread resume timeout | N/A | N/A | Codex `--thread-id` resume; no explicit timeout |

NeoKai does not currently enforce a per-turn wall-clock timeout. For Codex integrations where
tasks may run for many minutes (e.g., large codebase refactors), an application-level timeout
with a graceful abort should be considered.

---

## 8. MCP Integration Options in Detail

### 8.1 Codex as MCP Client (Pattern B)

Codex supports connecting to external MCP servers via its configuration:

```toml
# codex.toml
[mcp_servers.neokai]
transport = "stdio"
command = "node"
args = ["path/to/neokai-mcp-server.js"]
```

NeoKai would need to implement a new `McpServer` endpoint (using `@modelcontextprotocol/sdk`) that
exposes its tool definitions. The challenge is that NeoKai's tools are session-scoped (different
tools may be available in different sessions), so the MCP server would need to be per-session or
support dynamic tool registration.

The existing `packages/daemon/src/lib/rpc-handlers/mcp-handlers.ts` manages inbound MCP server
connections to NeoKai sessions. Outbound MCP server hosting is not currently implemented.

### 8.2 Codex as MCP Server (Pattern C — Recommended)

`codex mcp-server` starts Codex in server mode, accepting MCP JSON-RPC requests over stdio. From
NeoKai's perspective, this is a standard `McpStdioServerConfig`:

```json
{
  "type": "stdio",
  "command": "codex",
  "args": ["mcp-server"],
  "env": {
    "OPENAI_API_KEY": "<key>"
  }
}
```

NeoKai's existing MCP server infrastructure (`McpServerStatusConfig`, session-level MCP
configuration) would handle connecting to Codex as a tool provider. The Claude Agent SDK would
then include a `codex` tool in the session, which the model can call to delegate tasks. No new
adapter code is required beyond the MCP server configuration.

**The key advantage:** NeoKai's entire message pipeline, tool visibility, context tracking,
permission gating, and session state management remain intact. Codex integration is reduced to a
single MCP server configuration entry.

---

## 9. Recommended Integration Pattern

For transparent backend integration with full NeoKai feature parity, the recommendation order is:

1. **Pattern C (Codex as MCP tool)** — No adapter code, no new infrastructure. Codex is a tool
   available to the Claude model in a NeoKai session. Works with the existing MCP server
   configuration system. The model decides when to use Codex. Full visibility and session state
   for NeoKai.

2. **Pattern D (Direct OpenAI API via pi-mono)** — Already implemented. Use this when you need
   an OpenAI model as the primary backend rather than as a subtask tool. Maintains NeoKai tool
   interop and context tracking. Does not use Codex-specific optimizations.

3. **Pattern A (Delegate entire subtask)** — Use this when the task is entirely self-contained
   and NeoKai tool interop is not needed. Lowest complexity. Useful for batch processing
   scenarios where the user explicitly wants Codex's built-in file-patching behavior.

4. **Pattern B (NeoKai as MCP server to Codex)** — Only justifiable if Codex's model quality
   significantly outperforms alternatives AND NeoKai tool access from Codex is required. The
   implementation cost (new MCP server endpoint, per-session routing, state sharing) is
   substantially higher than the alternatives.

---

## 10. Comparison Summary

| Pattern | NeoKai Tool Access | Context Tracking | Permission Gating | Complexity | Recommendation |
|---|---|---|---|---|---|
| A: Codex `--full-auto` | None | Token counts only | None | Low | Specific batch use cases |
| B: NeoKai as MCP server | Full (via MCP) | Token counts only | Partial | High | Not recommended |
| C: Codex as MCP tool | Full (outer session) | Full | Full | Low | Primary recommendation |
| D: Direct OpenAI (pi-mono) | Full | Token counts | Not implemented | None (existing) | OpenAI-primary sessions |

---

## 11. Implementation Notes for Pattern A (Adapter)

If Pattern A is selected, the adapter generator function signature would mirror
`piMonoQueryGenerator` in `packages/daemon/src/lib/providers/pimono-adapter.ts`:

```typescript
export async function* codexQueryGenerator(
  prompt: AsyncGenerator<SDKUserMessage>,
  options: ProviderQueryOptions,
  context: ProviderQueryContext,
  codexBinaryPath: string,
  codexConfig: CodexAdapterConfig,
): AsyncGenerator<SDKMessage, void, unknown> {
  // 1. Yield SDKSystemMessage (synthesized)
  // 2. Consume ONE message from prompt generator (same CRITICAL constraint as pi-mono)
  // 3. Spawn codex process with --json --thread-id (if resuming)
  // 4. Translate JSONL events to SDKMessages
  // 5. Capture thread.started.thread_id for persistence
  // 6. Yield SDKResultMessage on turn.completed or process error
}
```

The "consume ONE message" constraint noted in `piMonoQueryGenerator` applies identically here:
the prompt `AsyncGenerator` yields one message at a time and then blocks, so the adapter must
never iterate it with `for await`.

A `CodexProvider` class implementing the `Provider` interface from
`packages/shared/src/provider/types.ts` would register the adapter in
`packages/daemon/src/lib/providers/registry.ts`, enabling the standard provider selection flow
in `QueryRunner.runQuery()`.
