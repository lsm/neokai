# Milestone 4: Codex Bridge Parity Gaps

## Goal

Close the most impactful parity gaps in the `anthropic-to-codex-bridge` provider (backed by `codex app-server`). These gaps block real NeoKai usability with the Codex backend.

## Scope

- `packages/daemon/src/lib/providers/codex-anthropic-bridge/server.ts` -- Multiple tool results, error envelopes
- `packages/daemon/src/lib/providers/codex-anthropic-bridge/translator.ts` -- `tool_choice` pass-through
- `packages/daemon/src/lib/providers/codex-anthropic-bridge/process-manager.ts` -- Token usage wiring
- `packages/daemon/tests/unit/providers/codex-anthropic-bridge/` -- Unit tests for all changes

---

### Task 4.1: Support Multiple Tool Results in Codex Bridge

**Description:** The bridge currently uses only `toolResults[0]` when resuming a suspended session. This breaks multi-tool round-trips where the Codex model emits multiple tool calls in a single turn. Fix the server to resume with all tool results.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Read `packages/daemon/src/lib/providers/codex-anthropic-bridge/server.ts` -- find the `toolResults[0]` usage.
3. Read `packages/daemon/src/lib/providers/codex-anthropic-bridge/process-manager.ts` to understand how `BridgeSession` processes tool results and whether it supports multiple results.
4. Modify the server to iterate over all tool results and resume with each one:
   - If `BridgeSession.provideResult` only accepts one result at a time, call it for each result sequentially.
   - If the underlying Codex app-server only supports one tool call per turn, document this as a known limitation and use the first result but log a warning for additional ones.
5. Add unit tests in `packages/daemon/tests/unit/providers/codex-anthropic-bridge/server.test.ts` covering:
   - Single tool result (existing behavior preserved).
   - Multiple tool results in one continuation request.
6. Run `bun run typecheck` and `bun run lint`.
7. Run `cd packages/daemon && bun test tests/unit/providers/codex-anthropic-bridge/`.
8. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- The bridge handles multiple tool results from a single continuation request.
- If the underlying backend does not support parallel tool results, a clear warning is logged and the first result is used.
- Unit tests cover both single and multiple tool result cases.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 1.1

---

### Task 4.2: Anthropic-Style JSON Error Envelopes for Codex Bridge

**Description:** The bridge currently returns plain-text HTTP error bodies and embeds errors as `[Codex error: ...]` text blocks in SSE responses. Replace these with Anthropic-standard JSON error envelopes for HTTP errors and Anthropic-style `error` SSE events for streaming errors.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Read the Anthropic API error format documentation. Standard shape:
   ```json
   {"type":"error","error":{"type":"<error_type>","message":"<message>"}}
   ```
   Error types: `invalid_request_error`, `authentication_error`, `not_found_error`, `api_error`, `overloaded_error`.
3. In `packages/daemon/src/lib/providers/codex-anthropic-bridge/server.ts`:
   - Replace all plain-text error responses (400, 404, 500) with JSON bodies matching the Anthropic error envelope format.
   - For streaming errors, emit an `error` SSE event with the Anthropic error JSON before closing the stream.
4. Add a helper function `createAnthropicError(httpStatus: number, type: string, message: string)` in the translator or server to standardize error creation.
5. Add unit tests covering:
   - 400 Bad Request returns proper JSON envelope.
   - 404 Session Not Found returns proper JSON envelope.
   - 500 Internal Server Error returns proper JSON envelope.
   - Streaming error emits an `error` SSE event.
6. Run `bun run typecheck` and `bun run lint`.
7. Run `cd packages/daemon && bun test tests/unit/providers/codex-anthropic-bridge/`.
8. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- All HTTP error responses use Anthropic JSON error envelope format.
- Streaming errors emit an `error` SSE event with Anthropic-format payload.
- No more plain-text error bodies in the codex bridge server.
- Unit tests verify error envelope format for all error paths.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 1.1

---

### Task 4.3: Wire Token Usage from Codex Bridge

**Description:** The bridge emits synthetic/zero `input_tokens` and heuristic `output_tokens`. Wire the `thread/tokenUsage/updated` notification from the Codex app-server process manager to populate accurate usage fields in the SSE `message_delta` event.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Read `packages/daemon/src/lib/providers/codex-anthropic-bridge/process-manager.ts`:
   - Find how `thread/tokenUsage/updated` events are received.
   - Understand the token usage data shape from the app-server.
3. In `process-manager.ts`:
   - Capture token usage from the `thread/tokenUsage/updated` notification.
   - Expose it via `BridgeSession` (e.g., `getUsage()` method or an event emitter).
4. In `server.ts`:
   - When building the `message_delta` SSE event, use actual token usage from the bridge session if available.
   - Fall back to heuristic estimation if the notification has not yet arrived.
5. In `translator.ts`, update the `messageDeltaSSE` helper to accept actual usage values.
6. Add unit tests covering:
   - Token usage is captured from app-server notification.
   - `message_delta` SSE event includes actual token counts when available.
   - Fallback to heuristic when no notification arrives.
7. Run `bun run typecheck` and `bun run lint`.
8. Run `cd packages/daemon && bun test tests/unit/providers/codex-anthropic-bridge/`.
9. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- Token usage from `thread/tokenUsage/updated` is captured and exposed.
- SSE `message_delta` events include actual token counts when available.
- Fallback to heuristic estimation works when no notification arrives.
- Unit tests verify usage wiring.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 1.1
