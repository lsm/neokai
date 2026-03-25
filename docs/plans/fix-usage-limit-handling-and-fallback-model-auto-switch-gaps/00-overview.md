# Fix Usage Limit Handling and Fallback Model Auto-Switch Gaps

## Goal Summary

Fix 7 bugs and gaps in the room runtime's handling of usage limits ("You've hit your limit") and fallback model auto-switching. The core issue is that the `usage_limit` detection path lacks the re-detection guard that the `rate_limit` path already has, causing infinite backoff loops after a limit resets. Several related gaps in mirroring, manual recovery, envelope routing, leader recovery, provider availability checks, and task restriction cleanup compound the problem.

## High-Level Approach

The `rate_limit` handler at line 687 of `room-runtime.ts` has a `!group.rateLimit` guard that prevents re-detection on re-triggers (e.g., after `recoverStuckWorkers` fires post-expiry). The `usage_limit` handler at line 729 lacks this guard entirely, causing Bug A (infinite deadlock). The same pattern must be applied to the leader path at line 1094.

All fixes follow the existing patterns in the codebase -- the re-detection guard for `rate_limit`, the `clearRateLimit`/`clearTaskRestriction` methods already on `SessionGroupRepository` and `RoomRuntime`, and the mirroring callback structure in `setupMirroring()`.

## Milestones

1. **Bug A: Usage limit re-detection guard** -- Add `!group.rateLimit` guard to `usage_limit` handler in both worker and leader paths to prevent infinite backoff loops after limit reset.
2. **Bug B: Clear group rate limit on manual status change** -- Add `clearGroupRateLimit(taskId)` method to `RoomRuntime` and call it from `task.setStatus` handler when transitioning from `usage_limited`/`rate_limited` to `in_progress`.
3. **Bug D: Skip stale envelope routing after fallback switch** -- After a successful `trySwitchToFallbackModel()`, return early from `onWorkerTerminalState`/`onLeaderTerminalState` to avoid sending stale error text to the leader.
4. **Gap H: Clear task restriction after successful fallback switch** -- After a successful fallback switch in the `usage_limit` handler, call `clearTaskRestriction()` to restore task to `in_progress`.
5. **Gap E: Real-time usage_limit detection in mirroring** -- Add `usage_limit` handling to the `setupMirroring()` callback alongside the existing `rate_limit` handling.
6. **Gap F: Leader recovery mechanism** -- Add `recoverStuckLeaders()` method mirroring the `recoverStuckWorkers()` pattern, triggered from `tick()` after rate limit expiry.
7. **Gap G: Verify fallback model availability before switch** -- Check provider availability via `provider.isAvailable()` before calling `sessionFactory.switchModel()`.

## Cross-Milestone Dependencies and Sequencing

- **Milestone 1** (Bug A) is the highest priority and must be completed first. It is the root cause of permanent deadlocks.
- **Milestone 4** (Gap H) depends on Milestone 3 (Bug D) because both modify the `usage_limit` handler's success path. They should be in the same PR or Milestone 4 should follow immediately after.
- **Milestone 5** (Gap E) is independent but should follow Milestone 1 since it follows the same pattern.
- **Milestone 6** (Gap F) depends on Milestone 1 (Bug A) since the leader guard requires the same sentinel pattern.
- **Milestone 7** (Gap G) is fully independent and can be done in any order.
- **Milestone 2** (Bug B) is independent and can be done in any order, but logically pairs well with Milestone 1.

## Total Estimated Task Count

14 tasks across 7 milestones.
