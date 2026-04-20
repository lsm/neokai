# Milestone 6: Gap G -- Verify Fallback Model Availability Before Switch

## Goal and Scope

`trySwitchToFallbackModel()` does not check if the fallback model's API key/provider is actually available before switching. It could switch to a model whose provider is down or has no API key configured, causing a cascading failure. The fix adds a provider availability check integrated into the existing fallback chain traversal loop.

## Tasks

### Task 6.1: Add provider availability check to `trySwitchToFallbackModel()`

**Title**: Check provider availability before calling `sessionFactory.switchModel()`

**Description**: In `room-runtime.ts`, `trySwitchToFallbackModel()` (line 333) currently calls `sessionFactory.switchModel()` without verifying that the fallback provider is available. Add a check using an `isProviderAvailable` callback before attempting the switch. The check must be integrated INTO the existing fallback chain traversal loop (lines 364-381), not as a separate outer loop.

**Current chain traversal structure** (lines 364-381):
```typescript
const currentIndex = fallbackModels.findIndex(...);
let fallback: FallbackModelEntry | undefined;
if (currentIndex === -1) {
    fallback = fallbackModels[0];
} else {
    const nextIndex = currentIndex + 1;
    if (nextIndex < fallbackModels.length) {
        fallback = fallbackModels[nextIndex];
    }
}
```

This code only considers the "next" model in the chain. To support skipping unavailable providers, the traversal must be changed to a loop that iterates through remaining fallbacks until an available one is found.

**Subtasks**:
1. Add an optional `isProviderAvailable?: (provider: string, model: string) => Promise<boolean>` callback to the `RoomRuntimeConfig` interface (line 114). This allows injecting a provider availability check without coupling `RoomRuntime` to the global `ProviderRegistry` singleton. Place it after the `deadLoopConfig` field (around line 150).
2. Store `this.isProviderAvailable = config.isProviderAvailable` in the constructor.
3. Refactor the fallback chain traversal in `trySwitchToFallbackModel()`:
   a. Determine the starting index: if current model is in the chain, start at `currentIndex + 1`; otherwise start at `0`.
   b. Loop from the starting index through the end of the chain:
      - For each candidate, skip if `candidate.model === currentModel && candidate.provider === currentProvider` (don't switch to itself).
      - If `this.isProviderAvailable` is configured, call `await this.isProviderAvailable(candidate.provider, candidate.model)`. If unavailable, log a warning and `continue` to the next candidate.
      - If the candidate is available (or no callback configured), break out of the loop and proceed with `switchModel()`.
   c. If no available fallback was found, return `false`.
4. If `this.isProviderAvailable` is NOT configured (e.g., tests, backward compatibility), skip the check and proceed as before (the first valid candidate in the chain is used).
5. Update the `createRuntimeTestContext` helper to optionally provide `isProviderAvailable` for testing.

**Acceptance Criteria**:
- When a provider availability callback is configured, `trySwitchToFallbackModel()` checks it before switching.
- If the preferred fallback is unavailable, the next fallback in the chain is tried.
- If no fallback has an available provider, `false` is returned.
- When no callback is configured, existing behavior is preserved (backward compatible).
- The check is integrated into the existing chain traversal loop, not a separate outer loop.

**Dependencies**: None (fully independent).

**Agent Type**: coder

---

### Task 6.2: Wire up provider availability check in runtime service

**Title**: Wire `ProviderRegistry.isAvailable()` into `RoomRuntime` via config

**Description**: In `room-runtime-service.ts` (or wherever `RoomRuntime` instances are created for production), pass the provider availability check as the `isProviderAvailable` config option. This uses the `ProviderRegistry` (at `packages/daemon/src/lib/providers/registry.ts:47`) to check if a provider has valid credentials before switching.

**Concrete implementation**:
```typescript
isProviderAvailable: async (providerId: string, _model: string) => {
    const provider = providerRegistry.get(providerId as ProviderId);
    if (!provider) return false;
    return Boolean(await provider.isAvailable());
},
```

Where `providerRegistry` is the existing `ProviderRegistry` singleton instance accessible from the runtime service layer. The `Provider.isAvailable()` method is defined at `packages/shared/src/provider/types.ts:137` and returns `Promise<boolean> | boolean`.

**Subtasks**:
1. Locate where `RoomRuntime` is instantiated in production code (likely `room-runtime-service.ts` or the room setup code).
2. Add the `isProviderAvailable` callback using the `ProviderRegistry.get()` method.
3. The check should be lightweight — `provider.isAvailable()` typically checks for API key presence (synchronous for env-var based providers, async for token-refresh providers).

**Acceptance Criteria**:
- Production `RoomRuntime` instances have `isProviderAvailable` configured.
- The check uses `ProviderRegistry.get(providerId)?.isAvailable()` to verify credentials.

**Dependencies**: Task 6.1

**Agent Type**: coder

---

### Task 6.3: Unit tests for fallback model availability check

**Title**: Add tests for fallback model availability verification

**Description**: Add unit tests verifying that `trySwitchToFallbackModel()` respects provider availability.

**Subtasks**:
1. Test: Fallback configured but provider unavailable — `trySwitchToFallbackModel()` returns `false`.
2. Test: First fallback unavailable, second fallback available — switches to second fallback.
3. Test: All fallbacks available — switches to first fallback (existing behavior).
4. Test: No `isProviderAvailable` callback configured — falls through to switch without checking (backward compat).
5. Test: Fallback available but `switchModel()` itself fails — returns `false` (existing behavior preserved).
6. Test: Current model is in the fallback chain and all subsequent models are unavailable — returns `false` (no point switching to an earlier model).

**Acceptance Criteria**:
- Test "does not switch when fallback provider is unavailable" passes.
- Test "tries next fallback when first is unavailable" passes.
- Test "switches normally when all fallbacks available" passes.
- Test "skips check when no isProviderAvailable callback configured" passes.

**Dependencies**: Task 6.1

**Agent Type**: coder
