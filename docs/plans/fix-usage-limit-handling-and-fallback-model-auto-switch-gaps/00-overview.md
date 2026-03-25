# Fix Usage Limit Handling and Fallback Model Auto-Switch Gaps

## Goal Summary

Fix 7 bugs and gaps in the room runtime's handling of usage limits ("You've hit your limit") and fallback model auto-switching. The core issue is that the `usage_limit` detection path lacks the re-detection guard that the `rate_limit` path already has, causing infinite backoff loops after a limit resets. Several related gaps in mirroring, manual recovery, envelope routing, leader recovery, provider availability checks, and task restriction cleanup compound the problem.

## High-Level Approach

The `rate_limit` handler at line 687 of `room-runtime.ts` has a `!group.rateLimit` guard that prevents re-detection on re-triggers (e.g., after `recoverStuckWorkers` fires post-expiry). The `usage_limit` handler at line 729 lacks this guard entirely, causing Bug A (infinite deadlock). The same pattern must be applied to the leader path at line 1094.

All fixes follow the existing patterns in the codebase -- the re-detection guard for `rate_limit`, the `clearRateLimit`/`clearTaskRestriction` methods already on `SessionGroupRepository` and `RoomRuntime`, and the mirroring callback structure in `setupMirroring()`.

## Milestones

1. **Bug A: Usage limit re-detection guard** -- Add `!group.rateLimit` guard to `usage_limit` handler in both worker and leader paths to prevent infinite backoff loops after limit reset.
2. **Bug B: Clear group rate limit on manual status change** -- Add `clearGroupRateLimit(taskId)` method to `RoomRuntime` and call it from `task.setStatus` handler AND `task.sendHumanMessage` handler when the task is in `rate_limited`/`usage_limited` status. The `sendHumanMessage` handler currently has NO special handling for rate-limited tasks at all — it falls through to generic routing while the group still has `rateLimit` set.
3. **Bug D + Gap H: Skip stale envelope routing and clear restriction after fallback switch** -- After a successful `trySwitchToFallbackModel()`, return early from `onWorkerTerminalState`/`onLeaderTerminalState` to avoid sending stale error text to the leader. Also clear `task.restrictions` and `group.rateLimit` before returning. (Milestones 3 and 4 merged — see PR grouping below.)
4. **Gap E: Real-time usage_limit detection in mirroring** -- Add `usage_limit` handling to the `setupMirroring()` callback alongside the existing `rate_limit` handling. Includes re-detection guard and fresh-state-read guidance.
5. **Gap F: Leader recovery mechanism** -- Add `recoverStuckLeaders()` method mirroring the `recoverStuckWorkers()` pattern, triggered from `tick()` after rate limit expiry. Uses `sessionFactory.injectMessage()` to re-inject the last worker message into the leader session.
6. **Gap G: Verify fallback model availability before switch** -- Check provider availability via `registry.get(providerId)?.isAvailable()` before calling `sessionFactory.switchModel()`, integrated into the existing fallback chain traversal loop.

## PR Grouping Strategy

| PR | Milestones | Rationale |
|----|-----------|-----------|
| PR 1 | M1 + M2 | Both fix the critical deadlock path. M1 prevents the loop; M2 lets users manually recover. Independent, can be merged together. |
| PR 2 | M3 (Bug D + Gap H merged) | Single coherent change: "fix the fallback switch success path." The `clearTaskRestriction` call is part of the same return-early logic. |
| PR 3 | M4 (Gap E) | Independent feature: real-time usage_limit detection in mirroring. |
| PR 4 | M5 (Gap F) | Independent feature: leader recovery mechanism. Depends on PR 1 (needs re-detection guard). |
| PR 5 | M6 (Gap G) | Independent feature: provider availability check. |

## Cross-Milestone Dependencies and Sequencing

- **Milestone 1** (Bug A) is the highest priority and must be completed first. It is the root cause of permanent deadlocks.
- **Milestone 3** (Bug D + Gap H merged) — the `clearTaskRestriction` call is now part of the same return-early change. No cross-milestone dependency.
- **Milestone 4** (Gap E) is independent but should follow Milestone 1 since it follows the same pattern.
- **Milestone 5** (Gap F) depends on Milestone 1 (Bug A) since the leader re-detection guard is needed to prevent the re-injected leader output from re-triggering the backoff.
- **Milestone 6** (Gap G) is fully independent and can be done in any order.
- **Milestone 2** (Bug B) is independent and can be done in any order, but logically pairs well with Milestone 1.

## Total Estimated Task Count

18 tasks across 6 milestones (Milestones 3 and 4 from the original plan merged).

## Verification Notes

All bugs and gaps were verified against the actual codebase before planning. Key findings:

- **Bug A**: ✅ Confirmed at worker line 729 and leader line 1094 — no `!group.rateLimit` guard. The `rate_limit` path at line 687 correctly has this guard. The deadlock loop via `recoverStuckWorkers` → `onWorkerTerminalState` → re-apply backoff is real.
- **Bug B**: ✅ Confirmed — `TaskManager.setTaskStatus()` (line 256-261) clears `task.restrictions` but `group.rateLimit` is untouched. **Additional gap found**: `task.sendHumanMessage` has NO handling for `rate_limited`/`usage_limited` tasks — falls through to generic routing while group still has `rateLimit` set.
- **Bug D**: ✅ Confirmed at line 766 — falls through to routing with stale error text. Returning early is correct.
- **Gap E**: ✅ Confirmed at line 2242 — mirroring only checks `rate_limit`. Existing `rate_limit` mirroring has no re-detection guard either (works because `createRateLimitBackoff` only parses specific patterns).
- **Gap F**: ✅ Confirmed — `recoverStuckWorkers()` exists at line 2548 but no leader equivalent. Comment at line 1059-1064 acknowledges this. Re-injection must go through `sessionFactory.injectMessage()` to trigger a fresh leader response.
- **Gap G**: ✅ Confirmed — `trySwitchToFallbackModel()` at line 333-427 doesn't check provider availability. `ProviderRegistry.get()` at `packages/daemon/src/lib/providers/registry.ts:47` and `Provider.isAvailable()` at `packages/shared/src/provider/types.ts:137` are the concrete APIs to use. The check should be integrated into the existing chain loop (between finding `fallback` at line 383 and calling `switchModel` at line 397).
- **Gap H**: ✅ Confirmed — no `clearTaskRestriction()` call after successful fallback switch.
