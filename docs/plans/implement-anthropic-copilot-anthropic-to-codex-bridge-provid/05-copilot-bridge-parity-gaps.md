# Milestone 5: Copilot Bridge Parity Gaps

## Goal

Close the most impactful parity gaps in the `anthropic-copilot` provider (backed by `@github/copilot-sdk`). Focus on token usage, error mapping, and `tool_choice` pass-through.

## Scope

- `packages/daemon/src/lib/providers/anthropic-copilot/server.ts` -- Error mapping
- `packages/daemon/src/lib/providers/anthropic-copilot/streaming.ts` -- Token usage
- `packages/daemon/src/lib/providers/anthropic-copilot/sse.ts` -- SSE event helpers
- `packages/daemon/tests/unit/providers/anthropic-copilot/` -- Unit tests

---

### Task 5.1: Improve Error Mapping in Copilot Bridge

**Description:** The copilot bridge currently returns inconsistent error responses. Standardize to Anthropic JSON error envelopes (same format as Task 4.2) for HTTP errors, and emit Anthropic-style `error` SSE events for streaming errors.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Read `packages/daemon/src/lib/providers/anthropic-copilot/server.ts` -- identify all error response paths.
3. Create a shared `createAnthropicErrorResponse(status: number, errorType: string, message: string)` helper that both the copilot and codex bridges can use. Place it in a new file `packages/daemon/src/lib/providers/shared/error-envelope.ts` or add it to each bridge's own module.
4. Replace all non-JSON error responses in the copilot server with Anthropic error envelopes.
5. For streaming errors, emit an Anthropic-format `error` SSE event.
6. Update or add unit tests in `packages/daemon/tests/unit/providers/anthropic-copilot/server.test.ts`:
   - HTTP 400 returns JSON error envelope.
   - HTTP 500 returns JSON error envelope.
   - Streaming error emits `error` SSE event.
7. Run `bun run typecheck` and `bun run lint`.
8. Run `cd packages/daemon && bun test tests/unit/providers/anthropic-copilot/ --timeout 60000`.
9. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- All HTTP error responses from the copilot bridge use Anthropic JSON error envelope format.
- Streaming errors emit Anthropic-format `error` SSE events.
- Error types are correctly mapped: invalid requests -> `invalid_request_error`, auth issues -> `authentication_error`, etc.
- Unit tests verify error envelope format.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 1.1

---

### Task 5.2: Token Usage Accounting for Copilot Bridge

**Description:** The copilot bridge emits `input_tokens: 0` and `output_tokens: 0` due to SDK limitations. Improve this by at least providing heuristic token counting based on text length, and documenting the limitation. If the Copilot SDK exposes usage data, wire it through.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Read `packages/daemon/src/lib/providers/anthropic-copilot/streaming.ts` and `sse.ts` to understand how usage is currently set.
3. Check the `@github/copilot-sdk` API for any usage/token reporting features.
4. Implement heuristic token counting:
   - Count input tokens based on the system prompt + messages text length (rough estimate: 4 chars per token).
   - Count output tokens by accumulating text delta lengths during streaming.
5. Update `message_start` SSE to include estimated `input_tokens`.
6. Update `message_delta` SSE to include accumulated `output_tokens`.
7. Add a comment documenting that these are heuristic estimates, not actual model-reported values.
8. Add unit tests for heuristic token counting.
9. Run `bun run typecheck` and `bun run lint`.
10. Run `cd packages/daemon && bun test tests/unit/providers/anthropic-copilot/ --timeout 60000`.
11. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- `message_start` includes a non-zero `input_tokens` estimate for any non-empty input.
- `message_delta` includes accumulated `output_tokens` estimate equal to `ceil(total_output_text_length / 4)`.
- `input_tokens` estimate equals `ceil(total_input_text_length / 4)` (where input text = system prompt + serialized messages).
- Documented as heuristic estimates in code comments (not actual model-reported values).
- Unit tests verify: (a) non-zero token counts in SSE events for non-empty messages, (b) the 4-chars-per-token formula produces expected values for known inputs.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 1.1

---

### Task 5.3: tool_choice Pass-Through for Both Bridges (Cross-Cutting)

**Description:** Both bridges currently accept but ignore the `tool_choice` field. For the Copilot bridge, pass `tool_choice` through to the SDK if it supports it. For the Codex bridge, document the limitation. At minimum, log a warning when `tool_choice` is provided but not honored.

> **Note:** This task is filed under Milestone 5 (Copilot) but modifies both bridges (including `codex-anthropic-bridge/server.ts` and `translator.ts`). It is grouped here because the Copilot bridge has the higher likelihood of supporting `tool_choice` pass-through. The Codex bridge changes are documentation/warning-only.

**Agent type:** coder

**Subtasks:**
1. Run `bun install` at the worktree root.
2. Check `@github/copilot-sdk` for `tool_choice` or `toolChoice` support in session creation or message sending.
3. In `packages/daemon/src/lib/providers/anthropic-copilot/server.ts`:
   - If the SDK supports `tool_choice`, pass it through when creating the session or sending messages.
   - If not, log a warning when the request includes `tool_choice` and document the limitation.
4. In `packages/daemon/src/lib/providers/codex-anthropic-bridge/server.ts`:
   - Log a warning when `tool_choice` is provided but not honored.
5. In `packages/daemon/src/lib/providers/codex-anthropic-bridge/translator.ts`:
   - Add `tool_choice` to the `AnthropicRequest` interface for type completeness.
6. Add unit tests that verify:
   - A warning is logged when `tool_choice` is provided but not supported.
   - The request is still processed successfully despite `tool_choice` being unsupported.
7. Run `bun run typecheck` and `bun run lint`.
8. Run relevant unit tests.
9. Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

**Acceptance criteria:**
- `tool_choice` is passed through if the backend supports it.
- A warning is logged when `tool_choice` is provided but not honored.
- `tool_choice` is included in the `AnthropicRequest` type for both bridges.
- Unit tests verify warning logging and graceful handling.
- `bun run typecheck` and `bun run lint` pass.

**Dependencies:** Task 1.1
