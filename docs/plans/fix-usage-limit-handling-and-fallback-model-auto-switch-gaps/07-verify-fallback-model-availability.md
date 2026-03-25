# Milestone 7: Gap G -- Verify Fallback Model Availability Before Switch

## Goal and Scope

`trySwitchToFallbackModel()` does not check if the fallback model's API key/provider is actually available before switching. It could switch to a model whose provider is down or has no API key configured, causing a cascading failure. The fix adds a provider availability check before calling `sessionFactory.switchModel()`.

## Tasks

### Task 7.1: Add provider availability check to `trySwitchToFallbackModel()`

**Title**: Check provider availability before calling `sessionFactory.switchModel()`

**Description**: In `room-runtime.ts`, `trySwitchToFallbackModel()` (line 333) currently calls `sessionFactory.switchModel()` without verifying that the fallback provider is available. Add a check using the provider registry or a provider availability callback before attempting the switch.

**Subtasks**:
1. Add an optional `isProviderAvailable?: (provider: string, model: string) => Promise<boolean>` callback to the `RoomRuntimeConfig` interface (line 115). This allows injecting a provider availability check without coupling `RoomRuntime` to the global `ProviderRegistry` singleton.
2. In `trySwitchToFallbackModel()`, after finding the fallback model (line 383-389), check provider availability:
   a. If `this.isProviderAvailable` is configured, call `await this.isProviderAvailable(fallback.provider, fallback.model)`.
   b. If the provider is not available, log a warning and try the next fallback in the chain (loop through remaining fallbacks).
   c. If no fallback has an available provider, return `false`.
3. If `this.isProviderAvailable` is NOT configured (e.g., tests, backward compatibility), skip the check and proceed as before.
4. Update the `createRuntimeTestContext` helper to optionally provide `isProviderAvailable` for testing.

**Acceptance Criteria**:
- When a provider availability callback is configured, `trySwitchToFallbackModel()` checks it before switching.
- If the preferred fallback is unavailable, the next fallback in the chain is tried.
- If no fallback has an available provider, `false` is returned.
- When no callback is configured, existing behavior is preserved (backward compatible).

**Dependencies**: None (fully independent).

**Agent Type**: coder

---

### Task 7.2: Wire up provider availability check in runtime service

**Title**: Wire `ProviderRegistry.isAvailable()` into `RoomRuntime` via config

**Description**: In `room-runtime-service.ts` (or wherever `RoomRuntime` instances are created for production), pass the provider availability check as the `isProviderAvailable` config option. This uses the `ProviderRegistry` to check if a provider has valid credentials before switching.

**Subtasks**:
1. Locate where `RoomRuntime` is instantiated in production code (likely `room-runtime-service.ts`).
2. Add `isProviderAvailable: async (provider, model) => { ... }` that uses the provider registry to check availability.
3. The check should be lightweight -- call `provider.isAvailable()` which typically checks for API key presence.

**Acceptance Criteria**:
- Production `RoomRuntime` instances have `isProviderAvailable` configured.
- The check uses the provider registry to verify credentials.

**Dependencies**: Task 7.1

**Agent Type**: coder

---

### Task 7.3: Unit tests for fallback model availability check

**Title**: Add tests for fallback model availability verification

**Description**: Add unit tests verifying that `trySwitchToFallbackModel()` respects provider availability.

**Subtasks**:
1. Test: Fallback configured but provider unavailable -- `trySwitchToFallbackModel()` returns `false`.
2. Test: First fallback unavailable, second fallback available -- switches to second fallback.
3. Test: All fallbacks available -- switches to first fallback (existing behavior).
4. Test: No `isProviderAvailable` callback configured -- falls through to switch without checking (backward compat).
5. Test: Fallback available but `switchModel()` itself fails -- returns `false` (existing behavior preserved).

**Acceptance Criteria**:
- Test "does not switch when fallback provider is unavailable" passes.
- Test "tries next fallback when first is unavailable" passes.
- Test "switches normally when all fallbacks available" passes.
- Test "skips check when no isProviderAvailable callback configured" passes.

**Dependencies**: Task 7.1

**Agent Type**: coder
