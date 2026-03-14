# Codex CLI Message Format Mapping

**Date:** 2026-03-14
**Status:** Investigation Report
**Scope:** NeoKai `SDKMessage` types vs OpenAI Codex CLI `codex exec --json` JSONL event stream

---

## 1. Introduction

NeoKai's agent pipeline is built around a typed `SDKMessage` union defined in
`packages/shared/src/sdk/sdk.d.ts` and re-exported through `packages/shared/src/sdk/index.ts`.
Every message flowing between the Claude Agent SDK and NeoKai's daemon conforms to one of the
discriminated types in this union. The `SDKMessageHandler` (`packages/daemon/src/lib/agent/sdk-message-handler.ts`)
consumes these messages, persists them to SQLite, broadcasts deltas to connected browser clients via
the MessageHub, and drives UI state (processing phase, context usage, tool-call counts, cost
accumulation).

Integrating OpenAI Codex CLI as an alternative execution backend requires an **adapter layer** that
translates between:

- **Input direction** — NeoKai `SDKUserMessage` objects → Codex CLI prompt (stdin or JSON-RPC
  `turn/start`)
- **Output direction** — Codex CLI JSONL event stream → NeoKai `SDKMessage` objects

This report documents the complete mapping, its constraints, and the edge cases that an adapter
must handle.

---

## 2. NeoKai `SDKMessage` Type Reference

The following message types are relevant to a Codex adapter. Type definitions are drawn from
`packages/shared/src/sdk/sdk.d.ts` and the type guards in
`packages/shared/src/sdk/type-guards.ts`.

### 2.1 `SDKSystemMessage` (subtype: `init`)

Emitted once at the start of every session. Carries the model name, working directory, available
tools, permission mode, and the SDK's own internal session ID.

```typescript
{
  type: 'system',
  subtype: 'init',
  uuid: UUID,
  session_id: string,
  cwd: string,
  model: string,
  tools: string[],
  permissionMode: PermissionMode,
  mcp_servers: McpServerStatusConfig[],
  slash_commands: string[],
  output_style: string,
  skills: string[],
  plugins: string[],
  apiKeySource: ApiKeySource,
  claude_code_version: string,
}
```

The pi-mono adapter (`packages/daemon/src/lib/providers/pimono-adapter.ts`) synthesizes this
message via `createSystemInitMessage()` at the beginning of its generator rather than receiving it
from an external process. A Codex adapter would follow the same pattern.

### 2.2 `SDKUserMessage`

Carries the human turn. Content may be a plain string or a heterogeneous array of blocks.

```typescript
{
  type: 'user',
  uuid: UUID,
  session_id: string,
  parent_tool_use_id: string | null,
  message: {
    role: 'user',
    content: string | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
      | { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
    >,
  },
}
```

### 2.3 `SDKAssistantMessage`

The model's response. Content blocks may include plain text, tool-use invocations, or thinking
blocks.

```typescript
{
  type: 'assistant',
  uuid: UUID,
  session_id: string,
  parent_tool_use_id: string | null,
  message: {
    role: 'assistant',
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      | { type: 'thinking'; thinking: string }
    >,
  },
}
```

### 2.4 `SDKToolProgressMessage`

Indicates that a tool is currently executing. Emitted at start and again at completion with
`elapsed_time_seconds` populated. The UI uses this for in-progress indicators.

```typescript
{
  type: 'tool_progress',
  uuid: UUID,
  session_id: string,
  tool_name: string,
  tool_use_id: string,
  parent_tool_use_id: string | null,
  elapsed_time_seconds: number,
}
```

### 2.5 `SDKResultMessage`

Marks the end of a turn. The `subtype` field distinguishes success from error variants.

```typescript
// Success
{
  type: 'result',
  subtype: 'success',
  uuid: UUID,
  session_id: string,
  is_error: false,
  result: string,
  stop_reason: string,
  duration_ms: number,
  duration_api_ms: number,
  num_turns: number,
  total_cost_usd: number,
  usage: {
    input_tokens: number,
    output_tokens: number,
    cache_read_input_tokens: number,
    cache_creation_input_tokens: number,
  },
  permission_denials: Array<{ tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }>,
}

// Error
{
  type: 'result',
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd',
  uuid: UUID,
  session_id: string,
  is_error: true,
  errors: string[],
  stop_reason: string,
  // ... same duration/usage fields
}
```

### 2.6 Stream Event

A partial text chunk used for incremental UI rendering.

```typescript
{
  type: 'stream_event',
  uuid: UUID,
  session_id: string,
  parent_tool_use_id: string | null,
  event: {
    type: 'content_block_delta',
    index: number,
    delta: { type: 'text_delta'; text: string },
  },
}
```

---

## 3. Codex CLI JSONL Event Stream

When invoked as `codex exec --json "prompt text"`, Codex writes newline-delimited JSON to stdout.
The canonical sequence for a single turn with one tool execution and one agent response is:

```jsonl
{"type":"thread.started","thread_id":"<uuid>"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls -la","shell":"bash"}}
{"type":"item.delta","item_id":"item_1","delta":{"type":"text_delta","text":"drwxr-xr-x ..."}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","output":"drwxr-xr-x ...","exit_code":0}}
{"type":"item.started","item":{"id":"item_2","type":"agent_message","text":""}}
{"type":"item.delta","item_id":"item_2","delta":{"type":"text_delta","text":"Here is my analysis..."}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Here is my analysis..."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"output_tokens":122}}
```

When using Codex's app-server mode (JSON-RPC over stdio), the same information arrives as
notification frames:

```json
{"method":"item/agentMessage/delta","params":{"item_id":"item_2","delta":{"type":"text_delta","text":"Here is..."}}}
{"method":"item/completed","params":{"item":{"id":"item_2","type":"agent_message","text":"Here is my analysis..."}}}
{"method":"turn/completed","params":{"usage":{"input_tokens":24763,"output_tokens":122}}}
```

---

## 4. Message Type Mapping Table

| NeoKai Message Type | Direction | Codex Equivalent | Mapping Notes |
|---|---|---|---|
| `SDKSystemMessage` (init) | NeoKai → Codex | No equivalent | Synthesized by the adapter at generator start; inject `systemPrompt` via `--config` or `codex.toml` |
| `SDKUserMessage` (text) | NeoKai → Codex | Prompt text passed via stdin or `turn/start` | Only plain-text content is forwarded; multi-block content is concatenated to text |
| `SDKUserMessage` (image) | NeoKai → Codex | `--image <path>` flag or base64 via JSON-RPC | Requires temp file write; limited to one image per invocation in `exec` mode |
| `SDKUserMessage` (tool_result) | N/A | Not applicable | Tool results never enter NeoKai's inbound queue when using Codex; Codex owns tool execution internally |
| `SDKAssistantMessage` | Codex → NeoKai | `item.completed` with `type: "agent_message"` | No `tool_use` blocks; only `type: "text"` content blocks |
| `SDKToolProgressMessage` (start) | Codex → NeoKai | `item.started` with `type: "command_execution"` | `tool_name` set to `"shell"` or similar; `tool_use_id` derived from Codex `item.id` |
| `SDKToolProgressMessage` (end) | Codex → NeoKai | `item.completed` with `type: "command_execution"` | `elapsed_time_seconds` computed from wall-clock delta between `item.started` and `item.completed` |
| `SDKResultMessage` (success) | Codex → NeoKai | `turn.completed` with `usage` | `total_cost_usd` always 0 (Codex does not report cost); `num_turns` tracked by adapter |
| `SDKResultMessage` (error) | Codex → NeoKai | Process exit code != 0 or `error` event | Adapter maps non-zero exit to `subtype: "error_during_execution"` |
| `stream_event` (text_delta) | Codex → NeoKai | `item.delta` with `delta.type: "text_delta"` | Direct field mapping; only emitted when Codex streaming is active |

---

## 5. Detailed Format Examples

### 5.1 User Prompt: NeoKai to Codex

**Input — NeoKai `SDKUserMessage`:**
```json
{
  "type": "user",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "session_id": "a1b2c3d4",
  "parent_tool_use_id": null,
  "message": {
    "role": "user",
    "content": "Refactor the login function to use async/await"
  }
}
```

**Output — `codex exec` invocation:**
```bash
codex exec --json "Refactor the login function to use async/await"
```

Or in app-server JSON-RPC mode:
```json
{"jsonrpc":"2.0","id":1,"method":"turn/start","params":{"prompt":"Refactor the login function to use async/await"}}
```

**Adapter responsibility:** Extract `message.content` as a string. If content is an array,
concatenate all `type: "text"` blocks with newlines. Discard `tool_result` blocks (never
applicable in this direction with Codex). Pass images as `--image` flags or base64 params.

---

### 5.2 Agent Response: Codex to NeoKai

**Input — Codex JSONL:**
```jsonl
{"type":"item.started","item":{"id":"item_3","type":"agent_message","text":""}}
{"type":"item.delta","item_id":"item_3","delta":{"type":"text_delta","text":"I've refactored "}}
{"type":"item.delta","item_id":"item_3","delta":{"type":"text_delta","text":"the login function."}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"I've refactored the login function."}}
```

**Adapter output — stream events (for incremental UI):**
```json
{
  "type": "stream_event",
  "uuid": "<generated>",
  "session_id": "<neokai-session-id>",
  "parent_tool_use_id": null,
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "text_delta", "text": "I've refactored " }
  }
}
```

**Adapter output — final `SDKAssistantMessage` (on `item.completed`):**
```json
{
  "type": "assistant",
  "uuid": "<generated>",
  "session_id": "<neokai-session-id>",
  "parent_tool_use_id": null,
  "message": {
    "role": "assistant",
    "content": [
      { "type": "text", "text": "I've refactored the login function." }
    ]
  }
}
```

Note: No `tool_use` blocks are present. Codex never surfaces tool invocations to the caller.

---

### 5.3 Tool Execution: Codex to NeoKai

**Input — Codex JSONL:**
```jsonl
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"cat src/auth.ts","shell":"bash"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","output":"export async function login...","exit_code":0}}
```

**Adapter output — `SDKToolProgressMessage` (start):**
```json
{
  "type": "tool_progress",
  "uuid": "<generated>",
  "session_id": "<neokai-session-id>",
  "tool_name": "shell",
  "tool_use_id": "item_1",
  "parent_tool_use_id": null,
  "elapsed_time_seconds": 0
}
```

**Adapter output — `SDKToolProgressMessage` (end):**
```json
{
  "type": "tool_progress",
  "uuid": "<generated>",
  "session_id": "<neokai-session-id>",
  "tool_name": "shell",
  "tool_use_id": "item_1",
  "parent_tool_use_id": null,
  "elapsed_time_seconds": 0.342
}
```

---

### 5.4 Turn End: Codex to NeoKai

**Input — Codex JSONL:**
```jsonl
{"type":"turn.completed","usage":{"input_tokens":24763,"output_tokens":122}}
```

**Adapter output — `SDKResultMessage`:**
```json
{
  "type": "result",
  "subtype": "success",
  "uuid": "<generated>",
  "session_id": "<neokai-session-id>",
  "is_error": false,
  "result": "I've refactored the login function.",
  "stop_reason": "end_turn",
  "duration_ms": 3812,
  "duration_api_ms": 3812,
  "num_turns": 1,
  "total_cost_usd": 0,
  "usage": {
    "input_tokens": 24763,
    "output_tokens": 122,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  },
  "permission_denials": []
}
```

**Limitation:** `total_cost_usd` is always 0. Codex does not report cost in its JSONL stream.
The pi-mono adapter (`pimono-adapter.ts`) computes cost from per-token pricing tables; the same
approach can be applied here if token prices for the target GPT model are known.

---

## 6. Edge Cases

### 6.1 Multi-Block User Content

NeoKai's `SDKUserMessage` supports heterogeneous content arrays including images and tool results.
Codex's `exec` mode accepts only a single text prompt plus optional `--image` flags.

**Strategy:**
- Concatenate all `type: "text"` blocks (preserving order) into a single string.
- For each `type: "image"` block with a `base64` source: write to a temp file and pass as
  `--image <path>` (or inline in JSON-RPC mode if supported).
- `type: "tool_result"` blocks in an inbound `SDKUserMessage` indicate that NeoKai has already
  executed a tool and is feeding the result back. This flow does not occur when Codex owns tool
  execution. If the adapter ever receives such a message, it should discard or log a warning.

### 6.2 Empty Prompt

`codex exec` requires a non-empty prompt. If the upstream `SDKUserMessage` resolves to an empty
string after content extraction, the adapter should emit a synthetic `SDKResultMessage` with
`subtype: "error_during_execution"` and message `"Empty prompt"` rather than launching the Codex
process.

### 6.3 Process Exit Codes

Codex may exit with a non-zero code for reasons unrelated to the model's output (network failure,
auth error, permission denied). The adapter must distinguish:

- Exit code `0`: success path — emit `SDKResultMessage` with `subtype: "success"`.
- Exit code `1` with stderr content: execution error — emit `SDKResultMessage` with
  `subtype: "error_during_execution"`, `errors: [stderr text]`.
- Exit code `130` (SIGINT): user abort — emit `SDKResultMessage` with `subtype: "error_during_execution"`,
  `stop_reason: "aborted"`.

### 6.4 Absence of `turn.completed` Before Process Exit

If the Codex process exits without emitting `turn.completed` (e.g., crash, timeout), the adapter
must synthesize a `SDKResultMessage` with `subtype: "error_during_execution"` to prevent the
`SDKMessageHandler` from waiting indefinitely.

### 6.5 `item.started` Without Paired `item.completed`

The adapter should maintain a map of in-flight item IDs. On process exit, any items still in the
map are treated as incomplete and a corresponding `SDKToolProgressMessage` with elapsed time is
emitted.

### 6.6 Codex `file_patch` Items

Codex emits `item.type: "file_patch"` for unified-diff file edits. NeoKai has no equivalent
`SDKMessage` type for file patches. The adapter options are:

- Translate to a `SDKToolProgressMessage` with `tool_name: "file_patch"` for UI visibility.
- Emit a synthetic `SDKAssistantMessage` with text content describing the patch summary.
- Silently discard (least visible but simplest).

---

## 7. Multi-Turn Handling

### 7.1 How Codex Manages Multi-Turn Context

Unlike the Claude Agent SDK, which exposes a streaming `query()` generator that NeoKai feeds
messages to over the lifetime of the session, Codex CLI manages its own conversation state via
its `thread_id` system. Each `codex exec` invocation either starts a fresh thread or resumes an
existing one via `--thread-id`.

This means:

- NeoKai cannot "inject" messages mid-turn the way it does with the Claude Agent SDK's
  `AsyncGenerator` prompt interface.
- Multi-turn conversation history is stored by Codex, not by NeoKai.
- NeoKai's own `sdkSessionId` persistence and the `--resume` pattern do not apply to Codex.

### 7.2 Thread ID Persistence

The adapter must:

1. Capture `thread.started.thread_id` from the first Codex invocation.
2. Persist this ID in NeoKai's session metadata (e.g., `session.metadata.codexThreadId`).
3. On subsequent turns, pass `--thread-id <codexThreadId>` to resume the Codex conversation.

This corresponds to the pattern already used by `SDKMessageHandler.handleSystemMessage()` for
capturing the Claude Agent SDK's `session_id`. A Codex adapter would follow identical persistence
logic but store `codexThreadId` instead of `sdkSessionId`.

### 7.3 Session Isolation

Each NeoKai session maps to exactly one Codex thread. Creating a new NeoKai session creates a
fresh Codex thread (no `--thread-id` passed). Sessions cannot share a Codex thread.

---

## 8. Context Window Strategy

The Claude Agent SDK exposes detailed context usage via the `/context` slash command, which
NeoKai's `SDKMessageHandler` parses to populate `ContextInfo` for the UI. Codex provides only
the `usage` field in `turn.completed` (`input_tokens`, `output_tokens`).

**Adapter approach (mirrors `updateContextInfoFromUsage()` in `SDKMessageHandler`):**

```typescript
const contextInfo: ContextInfo = {
  model: 'codex-model-name',
  totalUsed: usage.input_tokens,
  totalCapacity: 128000,          // fixed by model; may need config
  percentUsed: (usage.input_tokens / 128000) * 100,
  breakdown: {
    'Input Tokens': {
      tokens: usage.input_tokens,
      percent: (usage.input_tokens / 128000) * 100,
    },
    'Output Tokens': {
      tokens: usage.output_tokens,
      percent: (usage.output_tokens / 128000) * 100,
    },
  },
  apiUsage: {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  lastUpdated: Date.now(),
  source: 'context-command',
};
```

The `totalCapacity` value must be configured per model (e.g., 128 000 for most GPT-4o variants,
200 000 for some reasoning models). There is no dynamic discovery mechanism comparable to the
Claude SDK's `/context` command output.

---

## 9. Session ID Handling

NeoKai assigns its own UUIDs to sessions (`session.id`). The Claude Agent SDK also assigns an
internal `session_id` that NeoKai stores in `session.sdkSessionId` for resumption.

For Codex:

| NeoKai field | Codex equivalent | Notes |
|---|---|---|
| `session.id` | (none) | NeoKai's primary key; not passed to Codex |
| `session.sdkSessionId` | `thread_id` from `thread.started` | Stored as `session.metadata.codexThreadId` |
| `SDKMessage.session_id` | N/A | Adapter fills this with NeoKai's `session.id` |
| `SDKMessage.uuid` | `item.id` | Adapter generates NeoKai UUIDs; Codex item IDs used only for in-flight tracking |

---

## 10. Limitations and Known Gaps

1. **No cost reporting.** Codex does not include cost in `turn.completed`. The adapter reports
   `total_cost_usd: 0`. Token-based cost estimation is possible but requires a separate
   pricing lookup table.

2. **No tool_use blocks in assistant messages.** Codex resolves all tool calls internally before
   responding. NeoKai's tool-call count metadata (`session.metadata.toolCallCount`) cannot be
   populated accurately; the best approximation is counting `command_execution` items.

3. **No `/context` slash command.** The detailed breakdown (system prompt tokens, tool schema
   tokens, conversation history tokens) that NeoKai normally retrieves via the Claude Agent SDK's
   `/context` command is not available. Context display in the UI will show only coarse
   input/output token totals.

4. **No `tool_result` injection.** NeoKai cannot provide tool results back to Codex mid-turn.
   This means MCP tools defined in NeoKai cannot be used unless Codex is configured to connect to
   NeoKai as an MCP server (see tool-integration report).

5. **Single prompt per invocation.** `codex exec` mode processes one prompt per subprocess
   invocation. The streaming `AsyncGenerator` prompt interface of the Claude Agent SDK (which allows
   NeoKai to inject messages mid-turn via `MessageQueue`) has no direct equivalent. Multi-turn
   conversation requires separate invocations with `--thread-id`.

6. **Image support constraints.** Multi-image inputs and inline base64 images depend on Codex
   version support. The `--image` flag accepts a file path; base64 data must be written to a
   temporary file first.

7. **Thinking blocks.** NeoKai supports `type: "thinking"` content blocks (mapped by pi-mono
   adapter as `<thinking>...</thinking>` text). Codex does not emit thinking blocks; this field
   would always be absent from Codex-sourced `SDKAssistantMessage` objects.

---

## 11. Summary

The message format mapping between NeoKai's `SDKMessage` types and Codex CLI's JSONL event stream
is achievable for the core conversational flow. The primary structural difference is that Codex
treats tool execution as fully internal — there are no `tool_use` blocks in assistant output, and
tool results cannot be injected by the adapter. This opaque tool execution model is the same
constraint that applies to NeoKai's existing pi-mono adapter path (OpenAI, GitHub Copilot), where
the pi-agent-core `Agent` class similarly handles tool dispatch internally.

An adapter following the same pattern as `piMonoQueryGenerator` in
`packages/daemon/src/lib/providers/pimono-adapter.ts` — synthesizing NeoKai-compatible
`SDKMessage` objects from external agent events — would satisfy the NeoKai message pipeline
without changes to `SDKMessageHandler`, `QueryRunner`, or the frontend.
