# Plan: Review PR #1484 — feat(space): block reason tagging for space tasks

## Scope

**What this plan covers:**
- Review PR #1484 (`feat/space-block-reason-tagging`) for correctness, style, and test coverage
- Post structured feedback directly on the PR

**Out of scope:**
- Making code changes to the PR
- Any implementation work beyond the review itself

---

## PR Summary

PR #1484 implements Gap #8 from the space-autonomy gap analysis. It adds:

1. **`SpaceBlockReason` type** (6 values) in `packages/shared/src/types/space.ts`
2. **`blockReason` field** on `SpaceTask` and `UpdateSpaceTaskParams`
3. **Migration 83** — adds `block_reason TEXT` column to `space_tasks`
4. **Tagging logic** in `SpaceTaskManager.setTaskStatus()` / `failTask()`
5. **Four tagged call sites** across `space-runtime.ts` and `task-agent-tools.ts`
6. **Auto-clear** of `blockReason` on reactivation (blocked → open/in_progress)
7. **Test helper** update (`space-test-db.ts`) and `space-store.test.ts` fixture update

---

## Review Findings

### ✅ Strengths

- Clean type definition with well-chosen discriminated values
- `setTaskStatus` correctly stamps on entry and clears on reactivation
- Migration is idempotent (checks `tableHasColumn` before `ALTER TABLE`)
- `failTask()` signature cleanly extends with optional `blockReason`
- `space-runtime.ts` tags three distinct paths: `workflow_invalid`, `execution_failed`, `agent_crashed`
- `task-agent-tools.ts` correctly tags `human_input_requested` at the HITL request site
- Test helper schema kept in sync — avoids schema drift in unit tests

### ⚠️ Issues Found

#### Issue 1 — `gate_rejected` is defined but never wired up (medium)

`SpaceBlockReason` includes `gate_rejected`, the PR description names it in the table, but no code path actually sets it. In `task-agent-tools.ts` (gate-reject branch, ~line 486), the workflow run is transitioned to `blocked` with `failureReason: 'humanRejected'`, but no call to `taskManager.setTaskStatus(…, 'blocked', { blockReason: 'gate_rejected' })` is made. In `space-runtime.ts`, the blocked-node-execution handler catches this case and tags it with `execution_failed` instead.

**Expected fix:** When `space-runtime.ts` sets `blockReason: 'execution_failed'` for a blocked workflow run, it should inspect the run's `failureReason` and emit `gate_rejected` instead when it equals `humanRejected`. Or, `task-agent-tools.ts` should call `taskManager.setTaskStatus` on the canonical task directly with `gate_rejected` at the rejection site.

#### Issue 2 — No dedicated unit tests for `blockReason` behavior (medium)

`space-task-manager.test.ts` was NOT updated. The new behavior (stamp on entry, clear on reactivation, `failTask` with reason) has no direct unit test coverage. The PR description lists "2060 space unit tests pass" but these are all pre-existing tests that happen to still pass after schema changes — they don't verify the new semantics.

**Expected fix:** Add tests to `space-task-manager.test.ts` (or a new file) covering:
- `failTask(id, error, 'agent_crashed')` → `task.blockReason === 'agent_crashed'`
- `setTaskStatus(id, 'blocked', { blockReason: 'human_input_requested' })` → reason stamped
- Reactivation (blocked → in_progress) → `task.blockReason === null`
- `setTaskStatus(id, 'blocked')` (no reason) → `task.blockReason === null` (not undefined)

#### Issue 3 — `dependency_failed` is also un-wired (low / acknowledged)

Similar to `gate_rejected`, the PR includes `dependency_failed` in the type but no code path uses it. The PR doc notes "future, Gap 5" for this one, making it an intentional placeholder. This is acceptable **if a follow-up issue is tracked**, but the type should ideally not ship with values that are permanently dead code.

**Suggested:** Either add a TODO comment on the `dependency_failed` variant pointing to the gap, or open a tracking issue reference.

#### Issue 4 — `task-agent-tools.ts` overloads `execution_failed` for agent-reported blocks (low)

In `task-agent-tools.ts` (~line 144), when the task agent calls the `update_task_status` tool with `status: 'blocked'`, the code infers `blockReason: 'execution_failed'`. This is a reasonable default, but an agent setting its own task to `blocked` is most naturally a self-reported execution failure, not a system-detected crash. The distinction matters for future retry/notification logic. Consider whether a separate reason like `task_self_reported` or leaving it as `execution_failed` (with documentation) is the intended long-term design.

### ✅ CI Status

- All completed checks: SUCCESS (lint, typecheck, unit, online)
- Several checks still IN_PROGRESS at review time (cross-provider, rpc-1/2/4, space-1/2, web)
- PR is MERGEABLE against `dev`

---

## Steps

1. Post this structured review as a comment on PR #1484
2. Wait for author response on Issues 1 and 2 (the blocking gaps)
3. No code changes needed from this reviewer — this is a read-only review task

---

## Testing Strategy

N/A — this is a review task, not an implementation task.

---

## Risk Areas

- **`gate_rejected` dead code**: Shipping an unreachable enum value makes downstream consumers (notification logic, UI badge filtering) unreliable when they branch on it — they'll never fire for gate rejections.
- **Missing unit test regression net**: Without explicit tests for stamp/clear semantics, a future refactor of `setTaskStatus` could silently break the invariant.

---

## Open Questions

1. Is `gate_rejected` intentionally deferred to a follow-up PR, or should it be wired up in this PR?
2. Should `dependency_failed` be removed until Gap #5 is implemented, or is it acceptable as a forward-compatible placeholder?
