# Codex CLI Adapter vs. Pi-Mono Adapter: Comparison Report

**Date:** 2026-03-14
**Status:** Decision memo — provider strategy for OpenAI model access in NeoKai

---

## 1. Executive Summary

The pi-mono adapter (`pimono-adapter.ts` + `openai-provider.ts`) gives NeoKai transparent, auditable control over every tool call made during an AI session, at the cost of depending on the `@mariozechner/pi-agent-core` npm package and its current tool-use correctness. The Codex CLI adapter (`codex-cli-adapter.ts` + `codex-cli-provider.ts`) offers a fully autonomous execution path by delegating all tool operations to the `codex exec` subprocess, which is powerful for batch tasks but eliminates NeoKai's ability to intercept or audit individual tool calls. The recommended strategy is to fix the pi-mono tool-use bug for the primary transparent-access path and offer Codex CLI as a complementary opt-in provider for fully autonomous delegation.

---

## 2. Architecture Comparison

### Pi-Mono Adapter (`pimono-adapter.ts`)

The pi-mono adapter bridges NeoKai sessions to OpenAI-compatible APIs through the `@mariozechner/pi-agent-core` `Agent` class. The execution model is:

1. NeoKai receives a user message and invokes `piMonoQueryGenerator`.
2. The generator constructs an `Agent` instance (from `@mariozechner/pi-agent-core`) with:
   - The OpenAI model resolved via `@mariozechner/pi-ai`'s `getModel()`.
   - NeoKai tool definitions converted to `AgentTool[]` via `convertToAgentTools()`.
   - A `toolExecutor` callback that delegates tool execution back to NeoKai's own tool system.
3. The `Agent` runs a multi-turn loop: it calls the OpenAI API, receives `tool_use` blocks, calls the `execute` method on the relevant `AgentTool`, and feeds `tool_result` blocks back into the conversation automatically.
4. The generator subscribes to `AgentEvent` emissions (`message_update`, `tool_execution_start`, `tool_execution_end`, etc.) and translates each into NeoKai `SDKMessage` types (`stream_event`, `tool_progress`, `assistant`, `result`).

Key architectural characteristics:
- **NeoKai executes all tools.** Every file operation, shell command, or MCP call goes through NeoKai's existing tool handlers.
- **Full tool call visibility.** Each `tool_use` / `tool_result` pair surfaces as `tool_progress` messages in the NeoKai UI.
- **Direct API calls.** No subprocess spawn; HTTP requests go directly from the NeoKai daemon process to the OpenAI endpoint.
- **Multi-turn loop managed by pi-agent-core.** The adapter delegates turn coordination (inject tool results, re-prompt) to the `Agent` class.

### Codex CLI Adapter (`codex-cli-adapter.ts`)

The Codex CLI adapter uses `codex exec --json` as an opaque subprocess. The execution model is:

1. NeoKai receives a user message and invokes `codexExecQueryGenerator`.
2. The generator spawns `Bun.spawn([codexBin, 'exec', '--json', '--model', ..., promptText])` with the working directory set to the session `cwd`.
3. The subprocess runs autonomously: Codex makes its own OpenAI API calls, decides which tools to invoke, reads and writes files, executes shell commands — all without any callback into NeoKai.
4. Codex emits a JSONL event stream on stdout. The adapter reads this line by line, parses `CodexEvent` objects, and translates them into NeoKai `SDKMessage` types via `translateCodexEvent()`.
5. `item.delta` events produce `stream_event` messages (streaming text). `item.started` / `item.completed` for `command_execution`, `file_change`, `web_search`, and `mcp_tool_call` items produce `tool_progress` pairs (start + end). `agent_message` items produce `assistant` messages. `turn.completed` carries token usage.

Key architectural characteristics:
- **Codex executes all tools autonomously.** NeoKai's `ProviderQueryOptions.tools` list is explicitly ignored (see adapter comments and `tools: []` in `createSystemInitMessage`).
- **Tool call visibility is surface-level only.** NeoKai sees that a `file_change` or `command_execution` happened, but cannot inspect inputs, control permissions, or inject custom tool results.
- **Subprocess overhead.** Each query spawns a new `codex exec` process (~100–500 ms cold-start, depending on system load and Node.js runtime startup).
- **Codex manages its own multi-turn loop.** NeoKai sees only the high-level JSONL events; the inner tool-use / tool-result conversation is invisible.

---

## 3. Feature Matrix

| Feature | Pi-Mono Adapter | Codex CLI Adapter |
|---|---|---|
| **Tool execution control** | NeoKai executes tools via callback | Codex executes tools autonomously |
| **Tool call visibility** | Full: tool name, inputs, outputs, errors | Partial: tool name and type only (no inputs/outputs) |
| **Streaming support** | Yes — `message_update` text delta events | Yes — `item.delta` text delta events |
| **Multi-turn support** | Yes — pi-agent-core manages turn loop | Yes — Codex manages its own turn loop |
| **Vision / multimodal** | Yes — `ImageContent` blocks supported in `sdkToAgentMessage` | No — only text extracted from user messages (`extractTextFromUserMessage`) |
| **API rate limiting / cost tracking** | Full token usage per turn (input, output, cache read/write, cost USD) | Input + output tokens only; `total_cost_usd` always 0 |
| **Session resume / persistence** | None — stateless per query | None — stateless per query; `codex exec` has no built-in session resume |
| **Sandbox / security** | NeoKai controls all file ops; no subprocess | Codex `workspace-write` sandbox by default; NeoKai cannot audit individual tool calls |
| **Abort / cancellation** | `agent.abort()` called on signal | `proc.kill()` called on signal |
| **Maintenance burden** | Depends on `@mariozechner/pi-agent-core` npm package; version drift risk | Depends on `codex` binary on PATH; separate installation required |
| **Production readiness** | Blocked by known tool-use bug | Functional when `codex` binary and API key are present |
| **Model selection flexibility** | Full — any model registered in `@mariozechner/pi-ai`; fallback synthesis for unknown Copilot models | Limited to `CODEX_CLI_MODELS` list; model ID passed as CLI flag |
| **GitHub Copilot support** | Yes — `github-copilot` provider path with `gpt-5.1-codex` template fallback | No — only `OPENAI_API_KEY` / `CODEX_API_KEY` |
| **Permission denial tracking** | Supported in result message (empty list currently) | Not supported (empty list always) |

---

## 4. Performance Considerations

### Pi-Mono Adapter
- **No subprocess overhead.** API calls are direct HTTP requests from the daemon process.
- **Startup latency:** Negligible — `Agent` construction is synchronous, first API call initiates within milliseconds of receiving the user message.
- **Tool execution latency:** Determined by NeoKai's own tool handler roundtrip, which is already on the hot path for Claude Code sessions.
- **Parallel tool execution:** Not explicitly managed by the adapter; depends on pi-agent-core's internal scheduling. The current implementation processes `AgentEvent` items sequentially through the event queue.

### Codex CLI Adapter
- **Subprocess spawn overhead:** Typically 100–500 ms per query for Node.js/npm binary cold start. On developer machines this is usually acceptable; in high-throughput or latency-sensitive scenarios it may be noticeable.
- **Built-in parallel tool execution:** Codex has its own internal parallelism for file operations and shell commands, which can outperform sequential tool calls in pi-agent-core for complex multi-file editing tasks.
- **Process isolation benefit:** Codex subprocess failure (crash, OOM) does not take down the NeoKai daemon. The adapter catches spawn errors and process exit codes gracefully.
- **No streaming backpressure control:** The adapter reads stdout via `reader.read()` in a loop. Bun's pipe buffering handles backpressure, but very verbose Codex output (large diffs, long command output) will accumulate in the buffer before being processed.

---

## 5. Reliability

### Pi-Mono Adapter
- **npm package dependency.** `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` are external packages. If the pi-ai API shape changes or the package is abandoned, the adapter breaks.
- **Known tool-use issue.** The current investigation context indicates tool use is failing. The root cause is likely in how `convertToAgentTools` bridges NeoKai's tool definitions to pi-agent-core's `AgentTool` schema, or in how the `Agent` event loop handles `tool_execution_*` events versus the actual execution callback invocation.
- **Model resolution.** The adapter uses `getModel()` from `@mariozechner/pi-ai` and falls back to synthesizing a Copilot model entry for unknown model IDs. If `@mariozechner/pi-ai` does not recognize the model, the fallback only works for `github-copilot` provider; `openai` provider will fail.

### Codex CLI Adapter
- **Binary installation dependency.** `codex` must be installed and on `PATH`. The `findCodexCli()` function uses `which codex` — if the binary is not installed, `createQuery()` returns `null` silently. This silent failure mode could confuse users who expect OpenAI Codex CLI models to appear in the model list.
- **Path resolution.** On macOS, GUI applications can have a stripped `PATH` that omits user-managed `PATH` entries (e.g., from `.zshrc`). The daemon process may not inherit the shell `PATH` where `codex` is installed via `npm -g` or `brew`.
- **Exit code reliability.** Non-zero exit codes produce error results, but Codex can emit `error` events in the JSONL stream before exiting 0. The adapter handles both cases.
- **Version compatibility.** The adapter assumes the `codex exec --json` JSONL event schema is stable. Schema changes in the `codex` binary would require adapter updates.

---

## 6. Security Analysis

### Pi-Mono Adapter
- **API key handling.** The OpenAI API key is passed as a string via `options.apiKey` (loaded from `OPENAI_API_KEY` or OAuth token). It is held in process memory and used directly in HTTP request headers by pi-agent-core. It is never written to disk by the adapter itself.
- **Tool execution scope.** All file operations are executed by NeoKai's own tool handlers, which apply the configured `permissionMode`. NeoKai can audit, log, or deny individual tool calls.
- **No subprocess.** There is no child process to escape the daemon's security boundary.

### Codex CLI Adapter
- **API key propagation.** The API key is written into the subprocess environment (`OPENAI_API_KEY`, `CODEX_API_KEY`) via `subEnv`. This is standard practice but means the key is present in the subprocess environment, accessible to any code Codex runs.
- **Sandbox mode.** Codex defaults to `workspace-write` sandbox, which restricts file writes to the working directory. This provides a degree of containment but is enforced by Codex, not NeoKai.
- **No NeoKai audit trail.** NeoKai cannot intercept individual `command_execution` or `file_change` tool calls. It only sees that they occurred, not their inputs or outputs. This means NeoKai cannot apply `permissionMode: 'bypassPermissions'` vs. `'default'` logic to Codex-executed tool calls.
- **Autonomous approval mode.** The default `approvalMode: 'never'` means Codex will execute all tool calls without asking for confirmation. Combined with `workspace-write` sandbox, this is appropriate for fully delegated tasks but requires trust in Codex's judgment.

---

## 7. When to Use Each

### Use Pi-Mono Adapter When:
- Transparent model access with NeoKai tool control is required — the operator needs an audit trail of every tool call.
- The session is part of an existing NeoKai room workflow where tool results feed back into the conversation context.
- The model is `openai` or `github-copilot` provider and must use OAuth credentials managed by NeoKai.
- Fine-grained permission control (`permissionMode`) must apply to file operations.
- Multi-modal inputs (images) need to be forwarded to the model.

### Use Codex CLI Adapter When:
- Delegating a complete, self-contained autonomous task to Codex's superior file editing agent.
- The operator does not need NeoKai to intercept or log individual tool calls.
- Codex's built-in parallel tool execution would outperform sequential NeoKai tool dispatch for large multi-file refactors.
- Testing Codex model capabilities within NeoKai's session management framework.
- The `codex` binary is already installed and the API key is available.

---

## 8. Current Status of Pi-Mono Issues

### Known Issue: Tool Use Failing
The investigation context confirms that tool use is currently broken in the pi-mono adapter. Sessions that require tool execution fail or produce incorrect results.

### Root Cause Analysis

The most likely failure points in the pi-agent-core approach:

1. **`convertToAgentTools` schema mismatch.** The adapter uses `Type.Record(Type.String(), Type.Any())` as the JSON schema for all tool parameters. Pi-agent-core may require per-tool schemas derived from the actual tool input schema. If the schema doesn't validate correctly, pi-agent-core may reject tool call inputs before invoking the `execute` callback.

2. **Event loop race condition.** The event queue / callback pattern (`state.resolveEventCallback`) assumes that `agent.subscribe()` events arrive on the same tick or are queued reliably. If pi-agent-core's event emission is synchronous and happens before the `await getNextEvent()` is reached, events may be lost or the queue may not drain correctly.

3. **`agent.prompt()` API surface.** The adapter calls `agent.prompt(agentMessages)` with a pre-constructed `AgentMessage[]`. If the pi-agent-core API expects a different call pattern for multi-turn sessions or tool injection, the agent may complete the first turn but not continue after tool results.

4. **Tool result injection.** The `execute` callback in `convertToAgentTools` returns an `AgentToolResult`-shaped object, but the exact return type expected by pi-agent-core may have diverged from what NeoKai provides. A mismatch here would cause the agent to treat tool results as errors or ignore them.

### Comparison with Codex CLI Approach
The Codex CLI approach avoids this entire class of problems by delegating the tool-use loop entirely to the `codex` binary. This is why Codex CLI works where pi-mono does not — but it does so by giving up NeoKai's tool control, not by solving the underlying API integration problem.

### Recommendation
Fix the pi-mono tool use rather than switching backends. The pi-agent-core integration should be debugged by:
1. Adding verbose logging in `convertToAgentTools` and the `execute` callback to verify tool calls are being dispatched.
2. Checking the pi-agent-core changelog for breaking changes to the `Agent` constructor, `AgentTool.execute` signature, or `AgentEvent` types.
3. Simplifying the schema to match what pi-agent-core actually validates.

---

## 9. Recommendation

**RECOMMENDATION: Fix the pi-mono adapter as the primary transparent backend. Register Codex CLI as a complementary opt-in provider.**

The pi-mono adapter is the correct architectural choice for NeoKai's goal of transparent model access with full tool-call visibility. Its current broken state is a fixable integration bug, not an architectural problem. The Codex CLI adapter, while functional, trades away a core NeoKai value proposition (tool auditability) in exchange for autonomous execution.

The two approaches are not in competition — they serve different use cases:

- **Pi-mono** = "transparent passthrough" — NeoKai stays in the loop on every tool call.
- **Codex CLI** = "autonomous delegation" — NeoKai steps aside and lets Codex drive.

Both are legitimate patterns. Neither should replace the other. The Codex CLI provider (already implemented in this PR) should be available as an opt-in provider, registered in the factory alongside the existing providers, not as a replacement for the OpenAI provider.

---

## 10. Migration Path

If Codex CLI is adopted as an opt-in provider:

1. **Keep pi-mono as the default for OpenAI sessions.** `OpenAiProvider` (id: `openai`) continues to use `piMonoQueryGenerator`. Fix the tool-use bug in this path.

2. **Register `CodexCliProvider` in `factory.ts`.** The provider (id: `openai-codex-cli`) is registered alongside existing providers. It is available when the `codex` binary is on PATH and `OPENAI_API_KEY` or `CODEX_API_KEY` is set. It will not auto-detect model IDs (`ownsModel` returns `false`) — sessions must explicitly specify `provider: 'openai-codex-cli'` in their configuration.

3. **Session configuration.** Users can select Codex CLI execution by setting the provider to `openai-codex-cli` in session config. NeoKai's session manager will route queries to `CodexCliProvider.createQuery()`, which spawns `codex exec --json`.

4. **Model ID routing.** `CodexCliProvider` uses the same model ID strings as `OpenAiProvider` (e.g., `gpt-5.3-codex`, `gpt-5.4`). `OpenAiProvider.ownsModel()` returns `true` for any model ID starting with `gpt-` via its `lower.startsWith('gpt-')` check. `CodexCliProvider.ownsModel()` always returns `false`. This means auto-detection always routes `gpt-*` models to `OpenAiProvider` (pi-mono path). The Codex CLI provider is only invoked when a session explicitly sets `provider: 'openai-codex-cli'` — never via auto-detection.

5. **Documentation.** Communicate clearly to users that `openai-codex-cli` sessions delegate autonomously to Codex — NeoKai tool interceptors, permission modes, and audit logs do not apply within the Codex subprocess.
