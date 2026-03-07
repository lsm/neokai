# Plan: Implement Makai V1 Design

**Goal:** Complete the V1 SDK + Agent + Provider implementation for the Makai project (lsm/makai), following the phased roadmap in `docs/implementation-traceability-matrix.md` and `docs/v1-sdk-agent-provider-spec.md`.

---

## Ordered Task List

### Task 1 — Finish and merge PR #23 (M-004)

**Phase:** 1.5
**Clause:** `§2.3`, `§5`; Phase 1.5 plan
**Agent:** coder

**Description:**
PR #23 (https://github.com/lsm/makai/pull/23) implements M-004: provider model catalog + `models_request`/`models_response` protocol. Complete any outstanding review comments, ensure all tests pass (`zig build test-protocol-types`, `zig build test-unit-protocol`, `zig build test-unit-makai-cli`, `npm test`), then merge the PR.

**Acceptance criteria:**
- All CI checks on PR #23 pass
- No open review comments blocking merge
- PR #23 merged into the default branch
- M-004 row in `docs/implementation-traceability-matrix.md` updated to `done`

---

### Task 2 — M-005: Agent protocol model passthrough (Zig)

**Phase:** 1.5
**Clause:** `§6`; Phase 1.5 plan
**Depends on:** Task 1
**Agent:** coder

**Description:**
Add `models_request` and `models_response` payload variants to the agent protocol. The agent server forwards `models_request` to the appropriate provider session, waits for `models_response`, and relays it back — preserving the exact typed shape. No raw JSON blobs. Reuse the shared `protocol/model_catalog_types.zig` module (already created in M-004).

Files to modify:
- `zig/src/protocol/agent/types.zig` — add payload variants
- `zig/src/protocol/agent/envelope.zig` — serde for new payload variants
- `zig/src/protocol/agent/server.zig` — `handleModelsRequest` passthrough handler
- `zig/src/protocol/agent/runtime.zig` — outbox pumping for queued model responses
- `zig/build.zig` — wire new test targets if needed

**Acceptance criteria:**
- Agent `models_request` is forwarded to the provider and `models_response` relayed back unchanged
- `ModelsResponse` shape is identical to the provider protocol response (shared types)
- Unit tests cover: ack+relay happy path, provider nack passthrough, filter forwarding
- Changes on a feature branch with a GitHub PR created via `gh pr create`
- M-005 row updated to `in progress` / `done` as applicable

---

### Task 3 — M-006: Credential resolution in binary request path (Phase 2a)

**Phase:** 2a
**Clause:** Phase 2a plan
**Depends on:** Task 1
**Agent:** coder

**Description:**
Wire the credential resolution and load path into binary (non-stdio) request handling. Credential discovery must follow the same precedence as the auth protocol: env vars → credential file → keychain → settings env block. Binary request handlers must fail fast with a typed `auth_required` nack when credentials are absent and no auth flow is active.

**Acceptance criteria:**
- Binary request path resolves credentials before dispatching to providers
- Missing credentials return `auth_required` nack (not a panic or untyped error)
- Unit tests cover all credential discovery precedence cases
- Existing stdio credential path unaffected
- Changes on a feature branch with a GitHub PR via `gh pr create`
- M-006 row updated to `in progress` / `done`

---

### Task 4 — M-007 + M-008: Auth refresh, retry, and concurrency hardening (Phase 2b + 2c)

**Phase:** 2b, 2c
**Clause:** `§8`; Phase 2b + 2c plan
**Depends on:** Task 3
**Agent:** coder

**Description:**
Implement the auth refresh and retry-once behavior (M-007) and the refresh lock scope with race-safe persistence (M-008).

M-007 specifics:
- On `auth_expired` or `auth_refresh_failed`, attempt auto-refresh once before returning typed error
- Emit typed `auth_refresh_failed` / `auth_expired` auth events (not generic `provider_error`)
- Refresh attempt must not block unrelated provider sessions

M-008 specifics:
- Per-provider refresh lock: only one refresh in flight at a time per provider
- Concurrent requests during refresh wait for lock release, then retry with new token
- Credential persistence after refresh must be race-safe (atomic write or equivalent)

**Acceptance criteria:**
- Refresh is attempted exactly once on expiry before surfacing `auth_expired` to caller
- Concurrent sessions sharing a provider see at most one refresh call
- `auth_refresh_failed` and `auth_expired` are distinct typed protocol events
- Credential persistence is atomic (no partial-write corruption under concurrent access)
- Unit tests cover: retry-once happy path, retry-once failure, concurrent refresh deduplication
- Changes on a feature branch with a GitHub PR via `gh pr create`
- M-007 and M-008 rows updated

---

### Task 5 — M-009a + M-009b + M-009c: TypeScript SDK public API (Phase 3)

**Phase:** 3
**Clause:** `§3`, `§3.5`, `§3.6`; Phase 3 plan
**Depends on:** Task 2 (agent passthrough), Task 3 (credential path)
**Agent:** coder

**Description:**
Implement the full TypeScript `MakaiClient` public API as specified in `§3` of `docs/v1-sdk-agent-provider-spec.md`. Three sub-surfaces:

- **M-009a** (`client.auth.*`): `listProviders()`, `login(providerId)`, `logout(providerId)`, auth event handler registration. Auth runs over protocol transport — no CLI subprocess.
- **M-009b** (`client.models.*`): `list(request?)`, `resolve(request)`. Wire to provider `models_request`/`models_response`. `resolve` maps to exact `model_id` filter. Expose `ModelDescriptor` shape.
- **M-009c** (`client.provider.*` and `client.agent.*`): `provider.complete()`, `provider.stream()`, `agent.run()` accepting `model_ref` from `models.resolve`. Same `model_ref` works for both paths.

Use `createMakaiClient(options?)` factory. Auth handler precedence: per-call → client-level default → none.

**Acceptance criteria:**
- All TypeScript types match the spec interfaces in `§3` exactly (no extra or missing fields)
- `client.auth.login()` emits auth events over protocol transport (no subprocess)
- `client.models.list()` / `resolve()` returns `ModelDescriptor[]` using provider passthrough
- `client.provider.complete()` and `client.agent.run()` accept the same `model_ref`
- TypeScript unit tests cover each API surface (happy path + error cases)
- Changes on a feature branch with a GitHub PR via `gh pr create`
- M-009a, M-009b, M-009c rows updated

---

### Task 6 — M-010 + M-011: Stream lifecycle guarantees and auth retry policy in SDK (Phase 3)

**Phase:** 3
**Clause:** `§3.4`, `§3.6`, `§4`; Phase 3 plan
**Depends on:** Task 5
**Agent:** coder

**Description:**
Enforce stream lifecycle semantics and auth retry policy in the TypeScript SDK layer.

M-010 (stream lifecycle):
- Provider streams emit exactly one terminal event (`message_end` or `error`) — deduplicate or discard extras
- Agent streams emit exactly one terminal `agent_end` or `error`
- Tool calls are buffered until complete before emission in V1
- `thinking_delta` normalizes provider-native reasoning deltas to a uniform event shape

M-011 (auth retry + handler precedence):
- `auth_retry_policy`: `"manual"` (default — throw on expiry) or `"auto_once"` (attempt auto-login, then throw if still failed)
- Auth handler precedence: per-call `handlers` → `client` default → none
- Auth event flattening: `auth_url`, `prompt`, `progress`, `success`, `error` delivered as unified `MakaiAuthEvent` union

**Acceptance criteria:**
- No duplicate terminal stream events reach callers under any error condition
- Tool calls never delivered as partial objects
- `thinking_delta` events present for all reasoning-capable providers
- `auto_once` policy retries login exactly once before surfacing `MakaiAuthError`
- Unit tests cover: duplicate terminal suppression, partial tool-call buffering, auto_once retry, handler precedence
- Changes on a feature branch with a GitHub PR via `gh pr create`
- M-010 and M-011 rows updated

---

### Task 7 — M-012 + M-013: Demo and CLI migration (Phase 4 + 5)

**Phase:** 4, 5
**Clause:** `§9` Phase F, Phase C; Phase 4 + 5 plan
**Depends on:** Task 6
**Agent:** coder

**Description:**
Migrate the demo and CLI auth commands to the SDK-backed protocol paths.

M-012 (demo migration, Phase F):
- Update `demo/` to use `createMakaiClient()` exclusively
- Remove any provider-specific header management, token file reads, or raw response parsing from demo code
- Demo must complete a full OAuth → model list → agent run / provider complete flow using only public SDK APIs

M-013 (CLI migration, Phase C):
- `makai auth providers` → thin wrapper over `client.auth.listProviders()`
- `makai auth login <providerId>` → thin wrapper over `client.auth.login(providerId)` with auth event printing to stdout
- CLI must not duplicate auth credential logic already in the protocol runtime

**Acceptance criteria:**
- Demo contains zero provider-specific credential or response-parsing code
- `makai auth providers` and `makai auth login` produce correct output using protocol transport
- Manual smoke test of full OAuth → model list → run flow passes in demo
- Changes on a feature branch with a GitHub PR via `gh pr create`
- M-012 and M-013 rows updated

---

### Task 8 — M-014: Hardening and acceptance tests (Phase 6)

**Phase:** 6
**Clause:** `§10`; Phase 6 plan
**Depends on:** Task 7
**Agent:** coder

**Description:**
Implement the acceptance test suite covering all six criteria in `§10` of the spec:

1. TS client completes OAuth + lists models + executes a model without provider-specific code
2. Model list shape is identical via provider endpoint and agent passthrough
3. Agent and provider paths both accept the same `model_ref`
4. SDK auth APIs run over protocol transport (verified by intercepting subprocess spawns — zero allowed)
5. `makai auth providers` and `makai auth login` are functional as protocol wrappers
6. Existing `stream` and `complete` flows remain functional after all migrations

Also: fix any latent bugs or edge cases discovered during acceptance testing.

**Acceptance criteria:**
- All 6 acceptance criteria from `§10` have automated test coverage
- Tests run cleanly in CI without real API keys (mock transport or recorded fixtures)
- Zero regressions in existing unit and integration tests
- M-014 row updated to `done`
- Final review: all rows in `docs/implementation-traceability-matrix.md` are `done`

---

## Dependency Graph

```
Task 1 (M-004 merge PR #23)
  └─► Task 2 (M-005 agent passthrough)
  └─► Task 3 (M-006 credential resolution)
        └─► Task 4 (M-007+M-008 auth refresh & concurrency)
Task 2 ──┐
Task 3 ──┤
         └─► Task 5 (M-009a/b/c TS SDK APIs)
                  └─► Task 6 (M-010+M-011 stream lifecycle + auth retry)
                            └─► Task 7 (M-012+M-013 demo + CLI migration)
                                      └─► Task 8 (M-014 hardening + acceptance)
```

---

## Agent Type Assignments

| Task | Agent |
|------|-------|
| Task 1 — Finish and merge PR #23 | coder |
| Task 2 — M-005 agent passthrough (Zig) | coder |
| Task 3 — M-006 credential resolution (Zig) | coder |
| Task 4 — M-007+M-008 auth refresh & concurrency (Zig) | coder |
| Task 5 — M-009a+M-009b+M-009c TS SDK APIs | coder |
| Task 6 — M-010+M-011 stream lifecycle + auth retry (TS) | coder |
| Task 7 — M-012+M-013 demo + CLI migration | coder |
| Task 8 — M-014 hardening + acceptance tests | coder |
