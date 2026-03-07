# Plan: Implement Makai V1 Design

**Goal:** Complete the V1 SDK + Agent + Provider implementation for the Makai project (lsm/makai), following the phased roadmap in `docs/implementation-traceability-matrix.md` and `docs/v1-sdk-agent-provider-spec.md`.

---

## Prerequisites (must be merged before Task 1 starts)

The following in-progress matrix rows have active branches in lsm/makai and must be merged into the default branch **before** the execution chain below begins:

| Row | Branch | Required by |
|-----|--------|-------------|
| M-001 | `codex/phase1-stdio-runtime` | All tasks (protocol dispatch foundation) |
| M-002 | `codex/phase1-25-auth-stdio-runtime` | Task 5a (`client.auth.*` over protocol transport) |
| M-003 | PR #21 (check merge status) | Task 1 (model_ref format used in catalog); Tasks 5a/5b (SDK uses model_ref) |

**If any prerequisite branch has unresolved review issues, stop and surface to the human for triage before proceeding.** Do not attempt to proceed with the plan while a prerequisite branch is blocked.

To verify prerequisites before starting Task 1, run in the lsm/makai repo:
```bash
gh pr list --state merged | grep -E "M-001|M-002|M-003|model.ref|phase1"
# Confirm all three branches show as merged; if not, halt.
```

---

## Ordered Task List

### Task 1 — Finish and merge PR #23 (M-004)

**Phase:** 1.5
**Clause:** `§2.3`, `§5`; Phase 1.5 plan
**Agent:** coder

**Description:**
PR #23 (https://github.com/lsm/makai/pull/23) implements M-004: provider model catalog + `models_request`/`models_response` protocol. Address any outstanding review feedback, complete both external review rounds required by `docs/review-process.md` (both rounds are currently listed as "pending" in the PR body), ensure all tests pass, then merge.

Note: `protocol/model_catalog_types.zig` was created in this PR. Task 2 imports from it — do not recreate the types there.

Test commands: `zig build test-protocol-types`, `zig build test-unit-protocol`, `zig build test-unit-makai-cli`, `npm test`

**Acceptance criteria:**
- External review process per `docs/review-process.md` is complete (both rounds recorded in the PR body, not merely no open comments)
- All CI checks pass
- PR #23 merged into the default branch
- M-004 row in `docs/implementation-traceability-matrix.md` updated to `done`
- Verify no unresolved prerequisite row (M-001, M-002, M-003) remains `in progress` before merging

---

### Task 2 — M-005: Agent protocol model passthrough (Zig)

**Phase:** 1.5
**Clause:** `§6`; Phase 1.5 plan
**Depends on:** Task 1
**Agent:** coder

**Description:**
Add `models_request` and `models_response` payload variants to the agent protocol. The agent server forwards `models_request` to the appropriate provider session, waits for `models_response`, and relays it back — preserving the exact typed shape defined in `protocol/model_catalog_types.zig` (created in M-004). No raw JSON blobs. No new catalog types — import only from the shared module.

Files to modify:
- `zig/src/protocol/agent/types.zig` — add `models_request`/`models_response` payload variants
- `zig/src/protocol/agent/envelope.zig` — serde for new payload variants
- `zig/src/protocol/agent/server.zig` — `handleModelsRequest` passthrough handler (ack + relay from provider)
- `zig/src/protocol/agent/runtime.zig` — outbox pumping for queued model responses
- `zig/build.zig` — wire test targets if needed

**Acceptance criteria:**
- Agent `models_request` is forwarded to the provider and `models_response` relayed back unchanged
- `ModelsResponse` shape is identical to provider protocol response (shared types from `model_catalog_types.zig`, not duplicated)
- Unit tests cover: ack+relay happy path, provider nack passthrough, filter forwarding
- Changes on a feature branch with a GitHub PR created via `gh pr create`
- M-005 row in traceability matrix updated to `in progress` / `done` as applicable

---

### Task 3 — M-006: Credential resolution, model resolver, and §8 error code extension (Phase 2a)

**Phase:** 2a
**Clause:** Phase 2a plan; `§3.2`; `§8`
**Depends on:** Task 1
**Agent:** coder

**Description:**
Three tightly coupled changes that must land together because they all touch the binary request dispatch path:

**M-006 — Credential resolution in binary request path:**
Wire the credential resolution/load path into binary (non-stdio) request handling. Credential discovery must follow the same precedence as the auth protocol: env vars → credential file → keychain → settings env block. Binary request handlers must fail fast with a typed `auth_required` nack when credentials are absent and no auth flow is active.

**§3.2 — Model resolver component:**
Add the single conversion boundary between the discovery plane and the execution plane: a `model_catalog` + `model_resolver` component that translates a `model_ref` (from `models.resolve`) into an `ai_types.Model` for provider dispatch. No other code path may perform this conversion. This resolver is needed in the binary request path before a provider can be invoked.

**§8 — Error code enum extension:**
Extend the provider `ErrorCode` enum in `zig/src/protocol/provider/types.zig` to include `auth_required` (needed here) and prepare stub entries for `auth_refresh_failed` and `auth_expired` (used in Task 4). These must be distinct typed codes, not generic `provider_error`.

Files to modify:
- `zig/src/protocol/provider/types.zig` — extend `ErrorCode` enum
- `zig/src/tools/makai.zig` — binary request credential resolution
- New file: `zig/src/protocol/model_resolver.zig` — model_ref → ai_types.Model resolver

**Acceptance criteria:**
- Binary request path resolves credentials before dispatching to providers
- Missing credentials return `auth_required` nack (not a panic or untyped error)
- `model_ref` → `ai_types.Model` conversion occurs only through the resolver component; no other code path performs the translation
- `ErrorCode` enum has `auth_required`, `auth_refresh_failed`, `auth_expired` as distinct typed values
- Unit tests cover: all credential discovery precedence cases, resolver with valid model_ref, resolver with invalid model_ref, `auth_required` nack
- Existing stdio credential path unaffected
- Changes on a feature branch with a GitHub PR via `gh pr create`
- M-006 row in traceability matrix updated

---

### Task 4 — M-007 + M-008: Auth refresh, retry, and concurrency hardening (Phase 2b + 2c)

**Phase:** 2b, 2c
**Clause:** `§8`; Phase 2b + 2c plan
**Depends on:** Task 2 (auth-flow events flow through agent path) AND Task 3 (auth_refresh_failed/auth_expired error codes exist)
**Agent:** coder

**Description:**
Implement auth refresh retry-once behavior (M-007) and per-provider refresh lock with race-safe credential persistence (M-008).

**M-007 — Refresh + retry-once:**
- On `auth_expired` or credential rejection, attempt auto-refresh exactly once before returning a typed `auth_expired` or `auth_refresh_failed` error
- Emit typed `auth_refresh_failed` / `auth_expired` auth events (reuse the error codes added in Task 3, not generic `provider_error`)
- Refresh attempt must not block unrelated provider sessions

**M-008 — Refresh lock and race-safe persistence:**
- Use `std.Thread.Mutex` for per-provider refresh lock — only one refresh in flight at a time per provider
- Concurrent requests during refresh wait for lock release (do not start a second refresh)
- Credential persistence after refresh uses write-to-temp-file + atomic rename to avoid partial-write corruption
- Lock scope covers the full refresh round-trip (request → response → persist), not just the network call

**Acceptance criteria:**
- Refresh is attempted exactly once on expiry before surfacing `auth_expired` to caller
- Concurrent sessions sharing a provider see at most one refresh call (second waits, does not double-refresh)
- `auth_refresh_failed` and `auth_expired` are distinct typed events (not generic nack codes)
- Credential persistence uses write-to-temp + atomic rename (not in-place overwrite)
- Unit tests cover: retry-once happy path, retry-once failure (both retries fail), concurrent refresh deduplication, lock released after refresh completes
- Changes on a feature branch with a GitHub PR via `gh pr create`
- M-007 and M-008 rows in traceability matrix updated

---

### Task 5a — M-009a: TypeScript SDK auth API (Phase 3)

**Phase:** 3
**Clause:** `§3.6`, `§4`; Phase 3 plan
**Depends on:** M-002 merged (prerequisite) — does NOT depend on Tasks 2 or 3
**Agent:** coder

**Description:**
Implement `MakaiAuthApi` (`client.auth.*`) as specified in `§3.6` and `§4` of the spec. Auth runs over protocol transport — no CLI subprocess spawning.

TypeScript target files (create under `typescript/src/`):
- `client/auth.ts` — `MakaiAuthApi` implementation
- `client/transport.ts` — protocol transport wrapper (if not already created by M-002 TS work)
- `client/types.ts` — shared TS types (AuthStatus, MakaiAuthEvent, AuthFlowHandlers, ProviderAuthInfo)

API surface:
- `client.auth.listProviders()` → `Promise<ProviderAuthInfo[]>`
- `client.auth.login(providerId, handlers?)` → `Promise<void>` (emits MakaiAuthEvent stream via handlers)
- `client.auth.logout(providerId)` → `Promise<void>`
- Handler precedence: per-call `handlers` → `client` default handlers → none

**Acceptance criteria:**
- All types match `§3.6` and `§4` spec interfaces exactly
- `client.auth.login()` communicates over protocol transport (no `child_process.spawn` / `Bun.spawn`)
- Cancelled OAuth flow rejects with `MakaiAuthError { kind: "cancelled" }` per `§3.3`
- Auth event flattening: `auth_url`, `prompt`, `progress`, `success`, `error` delivered as unified `MakaiAuthEvent` union
- TypeScript unit tests cover: listProviders happy path, login with auth events, login cancellation → cancelled error, logout, per-call handler overrides default
- Changes on a feature branch with a GitHub PR via `gh pr create`
- M-009a row in traceability matrix updated

---

### Task 5b — M-009b + M-009c: TypeScript SDK models, provider, and agent APIs (Phase 3)

**Phase:** 3
**Clause:** `§3`, `§3.5`; Phase 3 plan
**Depends on:** Task 2 (agent passthrough in place) AND Task 3 (model resolver + credential path in place)
**Agent:** coder

**Description:**
Implement `MakaiModelsApi`, `MakaiProviderApi`, and `MakaiAgentApi` as specified in `§3`, `§3.5` of the spec.

TypeScript target files (extend/create under `typescript/src/`):
- `client/models.ts` — `MakaiModelsApi` implementation
- `client/provider.ts` — `MakaiProviderApi` implementation
- `client/agent.ts` — `MakaiAgentApi` implementation
- `client/index.ts` — `createMakaiClient(options?)` factory wiring all surfaces

**M-009b (`client.models.*`):**
- `list(request?)` → `Promise<ListModelsResponse>` — maps to provider `models_request`
- `resolve(request)` → `Promise<ResolveModelResponse>` — maps to `models_request` with exact `model_id` filter per `§3.5`
- `ModelDescriptor` shape matches spec exactly

**M-009c (`client.provider.*` and `client.agent.*`):**
- `provider.complete(model_ref, messages, options?)` → `Promise<CompletionResponse>`
- `provider.stream(model_ref, messages, options?)` → `AsyncIterable<ProviderStreamEvent>`
- `agent.run(model_ref, options)` → `AsyncIterable<AgentStreamEvent>`
- Same `model_ref` value (from `models.resolve`) accepted by both `provider.*` and `agent.*`

**Acceptance criteria:**
- All types match `§3` spec interfaces exactly (no missing or extra fields)
- `models.resolve()` maps to `models_request` with exact `model_id` + optional `api` filter (no separate resolve envelope)
- If resolve returns >1 result, SDK surfaces `invalid_request` error (ambiguous match)
- If resolve returns 0 results, SDK surfaces `invalid_request` with "model not found" per `§3.5`
- Same `model_ref` accepted by both `provider.complete()` and `agent.run()`
- `createMakaiClient()` factory wires all four surfaces
- TypeScript unit tests cover each API: list, resolve (happy path, ambiguous, not-found), provider complete, provider stream, agent run
- Changes on a feature branch with a GitHub PR via `gh pr create`
- M-009b and M-009c rows in traceability matrix updated

---

### Task 6 — M-010 + M-011: Stream lifecycle guarantees and auth retry policy (Phase 3)

**Phase:** 3
**Clause:** `§3.4`, `§3.6`; Phase 3 plan
**Depends on:** Task 4 (backend refresh behavior in place) AND Task 5a AND Task 5b
**Agent:** coder

**Description:**
Enforce stream lifecycle semantics and auth retry policy in the TypeScript SDK layer.

**M-010 — Stream lifecycle:**
Implement a `StreamGuard` wrapper that enforces single-terminal-event invariant:
- Provider streams emit exactly one terminal event (`message_end` or `error`) — discard or throw on extras
- Agent streams emit exactly one terminal `agent_end` or `error`
- Tool calls buffered until complete before emission in V1 (no partial tool-call objects delivered to caller)
- `thinking_delta` normalizes provider-native reasoning deltas: implement at least two provider-specific normalizers (e.g. Anthropic `thinking` block → `thinking_delta`, OpenAI reasoning token → `thinking_delta`) with unit tests for each

**M-011 — Auth retry policy + handler precedence:**
- `auth_retry_policy: "manual"` (default) — throw `MakaiAuthError` on expiry without retrying
- `auth_retry_policy: "auto_once"` — attempt `client.auth.login()` exactly once after receiving `auth_expired`, then retry the original request; if still fails, throw
- Auth handler precedence confirmed: per-call `handlers` → client-level default → none
- Unified `MakaiAuthEvent` union correctly flattens all auth event variants

**Acceptance criteria:**
- Duplicate terminal events never reach callers under any error condition (enforced by StreamGuard)
- Tool calls never delivered as partial objects (buffered in StreamGuard until `tool_call_end`)
- `thinking_delta` normalization has unit tests covering at least two distinct provider-native formats
- `auto_once` policy: single retry after `auth_expired`, error thrown if retry also fails — confirmed by unit test
- `manual` policy: no retry, immediate throw — confirmed by unit test
- Handler precedence confirmed by unit test (per-call overrides client-level)
- Changes on a feature branch with a GitHub PR via `gh pr create`
- M-010 and M-011 rows in traceability matrix updated

---

### Task 7 — M-012 + M-013: Demo and CLI migration (Phase 4 + 5)

**Phase:** 4, 5
**Clause:** `§9` Phase F, Phase C; Phase 4 + 5 plan
**Depends on:** Task 6
**Agent:** coder

**Description:**
Migrate the demo and CLI auth commands to the SDK-backed protocol paths.

**M-012 (demo migration, Phase F):**
Update `demo/` to use `createMakaiClient()` exclusively. Remove any provider-specific header management, token file reads, or raw response parsing. The demo must implement the full flow from `§2` using only public SDK APIs.

**M-013 (CLI migration, Phase C):**
- `makai auth providers` → thin wrapper over `client.auth.listProviders()`
- `makai auth login <providerId>` → thin wrapper over `client.auth.login(providerId)` with auth event printed to stdout
- CLI must not duplicate auth credential logic already in the protocol runtime

**Acceptance criteria:**
- Demo contains zero provider-specific credential or response-parsing code (verified by code review: grep for direct token file reads, custom header construction)
- `makai auth providers` output matches the `ProviderAuthInfo[]` shape from `§4` (write an automated integration test using mock transport that verifies the printed output format)
- `makai auth login <providerId>` emits auth events correctly via mock transport integration test (auth_url, prompt, success/error variants all tested)
- An automated integration test using mock transport verifies the full OAuth → model list → agent run demo flow end-to-end (no manual steps)
- Changes on a feature branch with a GitHub PR via `gh pr create`
- M-012 and M-013 rows in traceability matrix updated

---

### Task 8 — M-014: Hardening and acceptance tests (Phase 6)

**Phase:** 6
**Clause:** `§10`; Phase 6 plan
**Depends on:** Task 7
**Agent:** coder

**Description:**
Implement the acceptance test suite covering all six criteria from `§10`, using mock transport (not real API keys) for the protocol layer and `MAKAI_BINARY_PATH` for binary-backed paths when available in CI.

**Mocking strategy:** Use a `MockTransport` implementing the same MessageHub interface, with pre-recorded fixtures for each protocol exchange. This allows all tests to run without real API keys. For criterion 4 (subprocess spawn interception), mock `Bun.spawn` / `child_process.spawn` at the test-module level and assert it is never called during auth flows.

**The six acceptance criteria from `§10`:**
1. TS client completes OAuth + lists models + executes a model without any provider-specific code — covered by an automated integration test using MockTransport
2. Model list shape is identical via provider endpoint and agent passthrough — assert `ModelDescriptor[]` from `provider.list()` and from agent passthrough share the same JSON shape via snapshot test
3. Agent and provider paths both accept the same `model_ref` — single test calls both `provider.complete()` and `agent.run()` with the same `model_ref` value and asserts both succeed
4. SDK auth APIs run over protocol transport (zero subprocess spawns) — mock `Bun.spawn`/`child_process.spawn`, run full auth flow, assert mock was never called
5. `makai auth providers` and `makai auth login` are functional as protocol wrappers — run CLI commands against MockTransport, verify outputs match protocol responses
6. Existing stream and complete flows remain functional — run existing unit/integration tests; zero regressions allowed

**Additional hardening:**
- Fix any bugs or edge cases found during acceptance testing
- Verify all rows in `docs/implementation-traceability-matrix.md` are `done` by running: `grep -c "not started\|in progress" docs/implementation-traceability-matrix.md` — must return `0`

**Acceptance criteria:**
- All 6 criteria from `§10` have automated test coverage using MockTransport
- `grep "not started\|in progress" docs/implementation-traceability-matrix.md` returns empty (all rows done)
- Zero regressions in existing unit and integration tests
- CI runs all tests without real API keys (MockTransport used throughout)
- Changes on a feature branch with a GitHub PR via `gh pr create`
- M-014 row updated to `done`

---

## Dependency Graph

```
[Prerequisites: M-001, M-002, M-003 must be merged before Task 1]

Task 1 (M-004 — merge PR #23)
  ├─► Task 2 (M-005 — agent passthrough, Zig)
  └─► Task 3 (M-006 + §3.2 + §8 — credential resolution + model resolver + error codes, Zig)
              └─► Task 4 (M-007+M-008 — auth refresh + concurrency, Zig)
                          (also depends on Task 2 for agent-path auth events)

M-002 merged ─► Task 5a (M-009a — TS auth API)
Task 2 ──┐
Task 3 ──┤
         └─► Task 5b (M-009b+M-009c — TS models/provider/agent API)

Task 4  ──┐
Task 5a ──┤
Task 5b ──┤
          └─► Task 6 (M-010+M-011 — stream lifecycle + auth retry, TS)
                        └─► Task 7 (M-012+M-013 — demo + CLI migration)
                                      └─► Task 8 (M-014 — hardening + acceptance tests)
```

---

## Agent Type Assignments

| Task | Agent |
|------|-------|
| Task 1 — Finish and merge PR #23 (M-004) | coder |
| Task 2 — M-005 agent passthrough (Zig) | coder |
| Task 3 — M-006 + §3.2 + §8 credential/resolver/errors (Zig) | coder |
| Task 4 — M-007+M-008 auth refresh + concurrency (Zig) | coder |
| Task 5a — M-009a TS auth API | coder |
| Task 5b — M-009b+M-009c TS models/provider/agent API | coder |
| Task 6 — M-010+M-011 stream lifecycle + auth retry (TS) | coder |
| Task 7 — M-012+M-013 demo + CLI migration | coder |
| Task 8 — M-014 hardening + acceptance tests | coder |
