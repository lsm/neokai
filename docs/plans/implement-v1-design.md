# Plan: Implement Makai V1 Design

**Goal:** Complete the V1 SDK + Agent + Provider implementation for the Makai project (lsm/makai), following the phased roadmap in `docs/implementation-traceability-matrix.md` and `docs/v1-sdk-agent-provider-spec.md`.

---

## Global Requirements (apply to every task PR)

These requirements from `docs/review-process.md` apply to **every** task in this plan:

1. **Backward-compatibility assessment** — every PR must include an explicit assessment of whether the changes break any existing `stream_request`, `complete_request`, or other existing flows. If no existing behavior is affected, state so explicitly.
2. **External review rounds** — every PR must complete two external review rounds per `docs/review-process.md`. Since a coder agent cannot perform its own external review, the agent must: push all changes, open the PR with `gh pr create`, then halt and surface to the human with a message like: "PR ready for external review. Awaiting two external review rounds per docs/review-process.md before merging." Do not self-merge.
3. **Single phase per PR** — `docs/review-process.md` prohibits mixed-phase PRs. Each task in this plan corresponds to exactly one phase.
4. **Traceability matrix update** — each PR must update the relevant rows in `docs/implementation-traceability-matrix.md`.

---

## Failure Handling

If any task fails CI, fails external review, or requires significant rework: downstream tasks halt. The coder agent must surface the specific failure to the human with the blocked task name and error summary, and await direction before proceeding.

---

## Task 0 — Verify prerequisites (gate, not a PR task)

**Phase:** pre-execution gate
**Agent:** coder

**Description:**
Before Task 1 begins, verify that M-001, M-002, and M-003 are merged into `lsm/makai:main`. These rows are known to have had active branches (`codex/phase1-stdio-runtime`, `codex/phase1-25-auth-stdio-runtime`, PR #21). Their merge status may be uncertain — use specific PR numbers to check:

```bash
# Run in lsm/makai repo
for pr in 16 17 21; do
  echo -n "PR #$pr: "
  gh pr view $pr --repo lsm/makai --json state,mergedAt --jq '"state=\(.state) mergedAt=\(.mergedAt)"'
done
# Expected: all three show state=MERGED
```

**If all three are MERGED:** Proceed to Task 1.

**If any show CLOSED (not merged) or OPEN:**
- For CLOSED PRs: check if the branch content was squash-merged or cherry-picked to main via `git log --oneline main | grep -i "phase1\|auth.*stdio\|model.ref"`. If found, treat as merged.
- If content is truly absent from main: halt and surface to the human. New PRs must be opened, reviewed, and merged from those branches before Task 1 can start. Do not proceed unilaterally.

**Additionally:** Update `docs/implementation-traceability-matrix.md` to set M-001, M-002, M-003 rows to `done` if they are merged but the matrix still shows `in progress`. Include this update in the Task 1 PR (see Task 1 description).

---

## Ordered Task List

### Task 1 — Finish and merge PR #23 (M-004) + matrix cleanup

**Phase:** 1.5
**Clause:** `§2.3`, `§5`; Phase 1.5 plan
**Depends on:** Task 0 gate (all prerequisites verified merged)
**Agent:** coder

**Description:**
PR #23 (https://github.com/lsm/makai/pull/23) implements M-004: provider model catalog + `models_request`/`models_response` protocol. Address any outstanding review feedback, complete both external review rounds required by `docs/review-process.md`, ensure all tests pass, then merge.

Also include in this PR: update M-001, M-002, and M-003 rows in `docs/implementation-traceability-matrix.md` to `done` if they were not updated after their PRs (#16, #17, #21) merged. This ensures the matrix is consistent before downstream tasks begin and prevents a false failure in Task 8's completeness check.

Note: `protocol/model_catalog_types.zig` was created in this PR. Task 2 imports from it — do not recreate types there.

Test commands: `zig build test-protocol-types`, `zig build test-unit-protocol`, `zig build test-unit-makai-cli`, `npm test`

**Acceptance criteria:**
- External review process per `docs/review-process.md` is complete (both rounds recorded, not merely no open comments)
- Backward-compatibility assessment included in PR: confirm existing `stream_request`/`complete_request` flows unaffected
- All CI checks pass
- PR #23 merged into the default branch
- M-001, M-002, M-003 rows updated to `done` in traceability matrix (if not already)
- M-004 row updated to `done` in traceability matrix

---

### Task 2 — M-005: Agent protocol model passthrough (Zig)

**Phase:** 1.5
**Clause:** `§6`; Phase 1.5 plan
**Depends on:** Task 1
**Agent:** coder

**Description:**
Add `models_request` and `models_response` payload variants to the agent protocol. The agent server forwards `models_request` to the appropriate provider session, waits for `models_response`, and relays it back — preserving the exact typed shape defined in `protocol/model_catalog_types.zig` (created in M-004). No raw JSON blobs. Import shared types; do not duplicate them.

Per `§9`, implement feature detection: if the provider returns `not_implemented` nack for `models_request`, the agent must relay that nack gracefully rather than erroring. Per `§9`, the protocol version stays at `1` and unknown fields in envelopes must be ignored by parsers (silently skipped).

Files to modify:
- `zig/src/protocol/agent/types.zig` — add `models_request`/`models_response` payload variants
- `zig/src/protocol/agent/envelope.zig` — serde for new payload variants; unknown fields ignored
- `zig/src/protocol/agent/server.zig` — `handleModelsRequest` passthrough handler (ack + relay from provider)
- `zig/src/protocol/agent/runtime.zig` — outbox pumping for queued model responses
- `zig/build.zig` — wire test targets if needed

**Acceptance criteria:**
- Agent `models_request` is forwarded to the provider and `models_response` relayed back unchanged
- `ModelsResponse` shape is identical to provider protocol response (shared types from `model_catalog_types.zig`, not duplicated)
- Provider `not_implemented` nack is relayed to caller without agent-level error (feature detection per §9)
- Envelope parser ignores unknown fields without error (add a test with a synthetic unknown field)
- Protocol smoke test: a Zig integration test or test binary sends `models_request` through stdio and asserts the response matches the `ModelsResponse` schema from `model_catalog_types.zig`
- Unit tests cover: ack+relay happy path, provider nack passthrough, filter forwarding, unknown-field ignore
- Backward-compatibility assessment in PR: existing `stream_request`/`complete_request` flows unaffected
- External review rounds completed per global requirements
- Changes on a feature branch with a GitHub PR via `gh pr create`; halt for human review before merging
- M-005 row in traceability matrix updated

---

### Task 3 — M-006: Credential resolution, model resolver, and §8 error code extension (Phase 2a)

**Phase:** 2a
**Clause:** Phase 2a plan; `§3.2`; `§8`
**Depends on:** Task 1
**Agent:** coder

**Description:**
Three tightly coupled changes that all touch the binary request dispatch path and are grouped under Phase 2a. They share a single PR because they are prerequisites to each other within this phase: the model resolver requires credential resolution to have run first, and both require the typed error codes to exist. Note: `docs/review-process.md`'s single-phase rule is satisfied because §3.2 (model resolver) and §8 (error codes) are cross-cutting normative requirements that apply within Phase 2a and are not standalone matrix rows; they are correctly bundled with M-006.

**M-006 — Credential resolution in binary request path:**
Wire credential resolution/load path into binary (non-stdio) request handling. Discovery precedence: env vars → credential file → keychain → settings env block. Binary request handlers must fail with a typed `auth_required` nack when credentials are absent and no auth flow is active.

**§3.2 — Model resolver component:**
Add the single conversion boundary between the discovery plane and execution plane: a `model_catalog + model_resolver` component that translates a `model_ref` into an `ai_types.Model` for provider dispatch. No other code path may perform this conversion.

**§8 — Error code enum extension:**
Extend the provider `ErrorCode` enum in `zig/src/protocol/provider/types.zig` to include `auth_required` (needed here), `auth_refresh_failed`, and `auth_expired` (used in Task 4b) as distinct typed values — not generic `provider_error`.

Files to modify:
- `zig/src/protocol/provider/types.zig` — extend `ErrorCode` enum
- `zig/src/tools/makai.zig` — binary request credential resolution
- New file: `zig/src/protocol/model_resolver.zig` — model_ref → ai_types.Model resolver

**Acceptance criteria:**
- Binary request path resolves credentials before dispatching to providers
- Missing credentials return `auth_required` nack (not a panic or untyped error)
- `model_ref` → `ai_types.Model` conversion occurs only through the resolver component
- `ErrorCode` enum has `auth_required`, `auth_refresh_failed`, `auth_expired` as distinct typed values
- Unit tests cover: all credential discovery precedence cases, resolver with valid model_ref, resolver with invalid model_ref, `auth_required` nack
- Existing stdio credential path unaffected
- Backward-compatibility assessment in PR: existing `stream_request`/`complete_request` flows unaffected
- External review rounds completed per global requirements
- Changes on a feature branch with a GitHub PR via `gh pr create`; halt for human review before merging
- M-006 row in traceability matrix updated

---

### Task 4a — M-007: Auth refresh and retry-once behavior (Phase 2b)

**Phase:** 2b
**Clause:** `§8`; Phase 2b plan
**Depends on:** Task 3 (error codes for auth_refresh_failed/auth_expired exist)
**Agent:** coder

**Description:**
Implement auth refresh retry-once behavior. M-007 is a behavioral state machine change and is separated from M-008 (concurrency lock) to limit PR blast radius per the review process.

- On `auth_expired` or credential rejection, attempt auto-refresh exactly once before returning a typed `auth_expired` or `auth_refresh_failed` error
- Emit typed `auth_refresh_failed` / `auth_expired` events (reuse error codes added in Task 3)
- Refresh attempt must not block unrelated provider sessions
- Does not implement the refresh lock — that is M-008 (Task 4b)

**Acceptance criteria:**
- Refresh is attempted exactly once on expiry before surfacing `auth_expired` to caller
- `auth_refresh_failed` and `auth_expired` are distinct typed events (not generic nack codes)
- Unit tests cover: retry-once happy path (refresh succeeds → request retried), retry-once failure (refresh fails → typed error surfaced), no retry on non-auth errors
- Backward-compatibility assessment in PR: existing credential flows unaffected
- External review rounds completed per global requirements
- Changes on a feature branch with a GitHub PR via `gh pr create`; halt for human review before merging
- M-007 row in traceability matrix updated

---

### Task 4b — M-008: Refresh lock scope, timeouts, and race-safe persistence (Phase 2c)

**Phase:** 2c
**Clause:** Phase 2c plan
**Depends on:** Task 4a (retry state machine in place before adding the lock around it)
**Agent:** coder

**Description:**
Implement the per-provider refresh lock and race-safe credential persistence. M-008 is a concurrency primitive and is separated from M-007 to make each PR independently reviewable.

- Use `std.Thread.Mutex` for per-provider refresh lock — only one refresh in flight at a time per provider
- Concurrent requests during refresh wait for lock release (do not start a second refresh)
- **Lock timeout:** if the refresh lock is held for more than 30 seconds, release lock ownership and fail all waiting requests with typed `auth_refresh_failed` (per Phase 2c plan)
- Credential persistence after refresh uses write-to-temp-file + atomic rename to avoid partial-write corruption
- Lock scope covers the full refresh round-trip (request → response → persist → release), not just the network call

**Acceptance criteria:**
- Concurrent sessions sharing a provider see at most one refresh call (second waits, does not double-refresh)
- Lock held >30s causes waiting requests to fail with `auth_refresh_failed` (not a deadlock or hang)
- Credential persistence uses write-to-temp + atomic rename (not in-place overwrite)
- Unit tests cover: concurrent refresh deduplication, lock release after success, 30s timeout → waiting requests fail, lock released after timeout (does not remain stuck)
- Backward-compatibility assessment in PR: existing credential and stream flows unaffected
- External review rounds completed per global requirements
- Changes on a feature branch with a GitHub PR via `gh pr create`; halt for human review before merging
- M-008 row in traceability matrix updated

---

### Task 5a — M-009a: TypeScript SDK auth API (Phase 3)

**Phase:** 3
**Clause:** `§3.6`, `§4`; Phase 3 plan
**Depends on:** M-002 merged (verified in Task 0) — does NOT depend on Tasks 2, 3, 4a, or 4b
**Agent:** coder

**Description:**
Implement `MakaiAuthApi` (`client.auth.*`) as specified in `§3.6` and `§4`. Auth runs over protocol transport — no CLI subprocess spawning. Implement exactly the spec interface, no additional methods.

The normative `MakaiAuthApi` interface from `§3` is:
```ts
interface MakaiAuthApi {
  listProviders(): Promise<ProviderAuthInfo[]>;
  login(providerId: ProviderId, handlers?: AuthFlowHandlers): Promise<{ status: "success" }>;
}
```
Note: there is no `logout()` method in the spec interface. Do not add it.

TypeScript target files (create under `typescript/src/`):
- `client/auth.ts` — `MakaiAuthApi` implementation
- `client/transport.ts` — protocol transport wrapper (if not already created by M-002 TS work)
- `client/types.ts` — shared TS types (AuthStatus, MakaiAuthEvent, AuthFlowHandlers, ProviderAuthInfo, MakaiAuthError)

**Acceptance criteria:**
- Types match `§3.6` and `§4` spec interfaces exactly — no `logout()` or other non-spec methods
- `client.auth.login()` communicates over protocol transport (no `child_process.spawn` / `Bun.spawn`)
- Cancelled OAuth flow rejects with `MakaiAuthError { kind: "cancelled" }` per `§3.3`
- Auth event flattening: `auth_url`, `prompt`, `progress`, `success`, `error` delivered as unified `MakaiAuthEvent` union
- Handler precedence: per-call `handlers` → client-level default → none (unit test verifies override)
- Unit tests cover: listProviders, login with auth events, login cancellation → cancelled error, per-call handler overrides default
- Backward-compatibility assessment in PR: no existing flows broken
- External review rounds completed per global requirements
- Changes on a feature branch with a GitHub PR via `gh pr create`; halt for human review before merging
- M-009a row in traceability matrix updated

---

### Task 5b — M-009b + M-009c: TypeScript SDK models, provider, and agent APIs (Phase 3)

**Phase:** 3
**Clause:** `§3`, `§3.5`; Phase 3 plan
**Depends on:** Task 2 (agent passthrough in place) AND Task 3 (model resolver + credential path in place)
**Agent:** coder

**Description:**
Implement `MakaiModelsApi`, `MakaiProviderApi`, and `MakaiAgentApi`, and the `createMakaiClient()` factory as specified in `§3` and `§3.5`.

TypeScript target files (create/extend under `typescript/src/`):
- `client/models.ts` — `MakaiModelsApi`
- `client/provider.ts` — `MakaiProviderApi`
- `client/agent.ts` — `MakaiAgentApi`
- `client/index.ts` — `createMakaiClient(options?)` factory

**M-009b (`client.models.*`):**
- `list(request?)` → `Promise<ListModelsResponse>` — maps to provider `models_request`
- `resolve(request)` → `Promise<ResolveModelResponse>` — maps to `models_request` with exact `model_id` filter per `§3.5` (no separate resolve envelope type in V1)
- `ListModelsResponse` exposes `fetched_at_ms` and `cache_max_age_ms` per `§2.3` for caller staleness detection
- Feature detection per `§9`: if provider returns `not_implemented`, surface as a typed error (not uncaught exception)

**M-009c (`client.provider.*` and `client.agent.*`):**
- `provider.complete(model_ref, messages, options?)` → `Promise<CompletionResponse>`
- `provider.stream(model_ref, messages, options?)` → `AsyncIterable<ProviderStreamEvent>`
- `agent.run(request: AgentRunRequest)` → `Promise<AgentRunResponse>` (blocking, not streaming)
- `agent.stream(request: AgentRunRequest)` → `AsyncIterable<AgentStreamEvent>` (streaming)
- Same `model_ref` value (from `models.resolve`) accepted by all four methods

**`createMakaiClient()` factory:**
- Returns `MakaiClient` with `auth`, `models`, `agent`, `provider` surfaces
- Includes `close(): Promise<void>` method that tears down the transport connection per `§3`

**Acceptance criteria:**
- All types match `§3` spec interfaces exactly
- `models.resolve()` maps to `models_request` with exact `model_id` + optional `api` filter
- If resolve returns >1 result, SDK surfaces `invalid_request` error (ambiguous match) per `§3.5`
- If resolve returns 0 results, SDK surfaces `invalid_request` with "model not found" per `§3.5`
- `ListModelsResponse` includes `fetched_at_ms` and `cache_max_age_ms` fields; unit test verifies fields present
- `agent.run()` returns `Promise<AgentRunResponse>` (blocking); `agent.stream()` returns `AsyncIterable<AgentStreamEvent>` — both are distinct methods
- `createMakaiClient()` returns client with `close(): Promise<void>`; unit test verifies it resolves without throwing
- Same `model_ref` accepted by `provider.complete()`, `provider.stream()`, `agent.run()`, `agent.stream()`
- `not_implemented` nack from provider surfaced as typed error (feature detection per `§9`)
- Unit tests cover: list, resolve (happy path, ambiguous, not-found), provider complete, provider stream, agent run, agent stream, client close
- Backward-compatibility assessment in PR: no existing flows broken
- External review rounds completed per global requirements
- Changes on a feature branch with a GitHub PR via `gh pr create`; halt for human review before merging
- M-009b and M-009c rows in traceability matrix updated

---

### Task 6 — M-010 + M-011: Stream lifecycle guarantees and auth retry policy (Phase 3)

**Phase:** 3
**Clause:** `§3.4`, `§3.6`; Phase 3 plan
**Depends on:** Task 4b (backend refresh behavior in place) AND Task 5a AND Task 5b
**Agent:** coder

**Description:**
Enforce stream lifecycle semantics and auth retry policy in the TypeScript SDK layer.

**M-010 — Stream lifecycle:**
Implement a `StreamGuard` wrapper that enforces single-terminal-event invariant:
- Provider streams emit exactly one terminal event (`message_end` or `error`) — on receiving a second terminal event, StreamGuard silently discards it (does not throw to caller) and logs a warning to preserve caller-visible stream integrity
- Agent streams emit exactly one terminal `agent_end` or `error` — same discard behavior
- Tool calls buffered until complete before emission (no partial tool-call objects delivered)
- `thinking_delta` normalization: implement normalizers for at least two distinct provider-native reasoning formats (e.g., Anthropic `thinking` block → `thinking_delta`, OpenAI reasoning token → `thinking_delta`), each with dedicated unit tests

**M-011 — Auth retry policy + handler precedence:**
- `auth_retry_policy: "manual"` (default) — throw `MakaiAuthError` on expiry, no retry
- `auth_retry_policy: "auto_once"` — attempt `client.auth.login()` exactly once after `auth_expired`, then retry original request; throw if still fails
- Handler precedence: per-call `handlers` → client-level default → none

**Acceptance criteria:**
- Second terminal event silently discarded by StreamGuard; warning logged; caller never sees duplicate terminal events
- Tool calls never delivered as partial objects (buffered in StreamGuard until `tool_call_end`)
- `thinking_delta` normalization unit tests cover at least two distinct provider-native formats
- `auto_once`: single retry after `auth_expired`, error thrown if retry also fails — verified by unit test
- `manual`: no retry, immediate throw — verified by unit test
- Handler precedence verified by unit test (per-call overrides client-level)
- Backward-compatibility assessment in PR: existing stream/complete flows unaffected
- External review rounds completed per global requirements
- Changes on a feature branch with a GitHub PR via `gh pr create`; halt for human review before merging
- M-010 and M-011 rows in traceability matrix updated

---

### Task 7a — M-012: Demo migration to SDK-backed path (Phase 4)

**Phase:** 4
**Clause:** `§9` Phase F; Phase 4 plan
**Depends on:** Task 6
**Agent:** coder

**Description:**
Migrate the demo (`demo/` directory in lsm/makai) to use `createMakaiClient()` exclusively. Remove any provider-specific header management, token file reads, or raw response parsing. The demo must implement the full flow from `§2` using only public SDK APIs.

**Acceptance criteria:**
- Demo contains zero provider-specific credential or response-parsing code (verified by grep: `git grep -n "Authorization\|Bearer\|token_file\|raw.*response" demo/` returns empty)
- Automated integration test using MockTransport verifies the full OAuth → model list → agent run demo flow end-to-end
- Backward-compatibility assessment in PR: existing demo behavior preserved (same user-visible flow, different implementation path)
- External review rounds completed per global requirements
- Changes on a feature branch with a GitHub PR via `gh pr create`; halt for human review before merging
- M-012 row in traceability matrix updated

---

### Task 7b — M-013: CLI auth migration to protocol-wrapper mode (Phase 5)

**Phase:** 5
**Clause:** `§9` Phase C; Phase 5 plan
**Depends on:** Task 7a
**Agent:** coder

**Description:**
Migrate `makai auth` CLI commands to thin wrappers over the protocol transport layer. The CLI must not duplicate auth credential logic that already exists in the protocol runtime.

- `makai auth providers` → thin wrapper over `client.auth.listProviders()`; prints `ProviderAuthInfo[]` to stdout
- `makai auth login <providerId>` → thin wrapper over `client.auth.login(providerId)` with auth events printed to stdout

**Acceptance criteria:**
- `makai auth providers` integration test (using MockTransport): asserts (1) the mock transport receives a well-formed `auth_providers_request` envelope matching `§4` type definition before sending mock response, and (2) the printed stdout output matches the `ProviderAuthInfo[]` shape
- `makai auth login` integration test (using MockTransport): asserts `auth_login_start` envelope sent with correct `providerId`; `auth_url`, `prompt`, `success`/`error` events printed in correct order
- CLI contains no duplicated auth credential logic (grep: `git grep -n "credentials\|token_file\|keychain" src/tools/` returns only delegation calls, not implementation)
- Backward-compatibility assessment in PR: `makai auth` commands produce equivalent output to previous behavior
- External review rounds completed per global requirements
- Changes on a feature branch with a GitHub PR via `gh pr create`; halt for human review before merging
- M-013 row in traceability matrix updated

---

### Task 8 — M-014: Hardening and acceptance tests (Phase 6)

**Phase:** 6
**Clause:** `§10`; Phase 6 plan
**Depends on:** Task 7b
**Agent:** coder

**Description:**
Implement the acceptance test suite covering all six criteria from `§10`, plus backward-compatibility regression suite. **Mocking strategy:** use a `MockTransport` implementing the same MessageHub interface with pre-recorded fixtures for each protocol exchange. Tests run without real API keys. For subprocess-spawn interception (criterion 4), use a per-test spy that wraps `Bun.spawn` / `child_process.spawn` and asserts it is never called during auth flows.

**The six acceptance criteria from `§10`:**
1. TS client completes OAuth + lists models + executes a model without provider-specific code — automated integration test using MockTransport
2. Model list shape identical via provider endpoint and agent passthrough — snapshot test asserts `ModelDescriptor[]` JSON from both paths are structurally identical
3. Agent and provider paths accept same `model_ref` — single test calls `provider.complete()` and `agent.run()` with same `model_ref`, both succeed
4. SDK auth APIs run over protocol transport (zero subprocess spawns) — Bun.spawn/child_process.spawn spy asserts zero calls during full auth flow
5. `makai auth providers` and `makai auth login` functional as protocol wrappers — CLI commands run against MockTransport, outputs verified
6. Existing stream/complete flows remain functional — run full existing unit and integration suite; zero regressions

**Additional hardening:**
- Per `§9`: add a test that sends a response with synthetic unknown fields and verifies parsers ignore them without error
- Fix any bugs or edge cases found during acceptance testing
- Final matrix check: `grep "not started\|in progress" docs/implementation-traceability-matrix.md` must return empty

**Acceptance criteria:**
- All 6 criteria from `§10` have automated test coverage using MockTransport
- Unknown-field resilience test passes (§9)
- `grep "not started\|in progress" docs/implementation-traceability-matrix.md` returns empty
- Zero regressions in existing unit and integration tests
- CI runs all tests without real API keys
- Backward-compatibility assessment in PR
- External review rounds completed per global requirements
- Changes on a feature branch with a GitHub PR via `gh pr create`; halt for human review before merging
- M-014 row updated to `done`

---

## Dependency Graph

```
Task 0 (prerequisite gate: verify M-001, M-002, M-003 merged)
  └─► Task 1 (M-004 — merge PR #23 + matrix cleanup for M-001/M-002/M-003)
        ├─► Task 2 (M-005 — agent passthrough, Zig, Phase 1.5)
        └─► Task 3 (M-006 + §3.2 + §8 — credential/resolver/errors, Zig, Phase 2a)
                    └─► Task 4a (M-007 — auth retry-once, Zig, Phase 2b)
                              └─► Task 4b (M-008 — refresh lock + persistence, Zig, Phase 2c)

M-002 merged (Task 0) ─► Task 5a (M-009a — TS auth API, Phase 3)

Task 2 ──┐
Task 3 ──┤
         └─► Task 5b (M-009b+M-009c — TS models/provider/agent API, Phase 3)

Task 4b ──┐
Task 5a ──┤
Task 5b ──┤
          └─► Task 6 (M-010+M-011 — stream lifecycle + auth retry, TS, Phase 3)
                        └─► Task 7a (M-012 — demo migration, Phase 4)
                                      └─► Task 7b (M-013 — CLI migration, Phase 5)
                                                    └─► Task 8 (M-014 — hardening, Phase 6)
```

Note: Task 4a/4b (auth refresh/lock) depend only on Task 3. They do NOT depend on Task 2 — M-007/M-008 are Zig binary-path changes that have no dependency on the agent protocol passthrough (M-005). The agent-path auth surfaces are handled at the TypeScript SDK layer in Tasks 5a/5b/6.

---

## Agent Type Assignments

All tasks: **coder** agent.
