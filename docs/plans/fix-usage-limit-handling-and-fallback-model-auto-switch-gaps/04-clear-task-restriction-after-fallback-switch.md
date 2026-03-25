# Milestone 4: Gap H -- Clear Task Restriction After Successful Fallback Switch

## Goal and Scope

This milestone is largely addressed by Task 3.1 and 3.2 (Milestone 3), which clear `task.restrictions` and `group.rateLimit` after a successful fallback switch. This milestone covers the remaining edge case: if the task was previously set to `usage_limited`/`rate_limited` from a prior detection cycle, and then a successful fallback switch happens, the restriction must be cleared.

Since Tasks 3.1 and 3.2 already include `clearTaskRestriction()` calls, this milestone primarily adds focused regression tests for this specific scenario.

## Tasks

### Task 4.1: Regression tests for task restriction clearing after fallback switch

**Title**: Add regression tests for task restriction clearing across fallback cycles

**Description**: Add tests that verify `task.restrictions` is properly cleared when a fallback model switch succeeds, even if the task was previously restricted from an earlier detection cycle.

**Subtasks**:
1. Test: Simulate first `rate_limit` detection (sets backoff + restriction). Manually expire the backoff. Simulate re-trigger that detects `usage_limit`. Configure fallback model. Verify that after successful switch, task restriction is cleared (not still set from the earlier `rate_limit` cycle).
2. Test: Task in `usage_limited` status with restriction set. Fallback switch succeeds. Verify task status is restored to `in_progress` and `restrictions` is null.

**Acceptance Criteria**:
- Test "task restriction cleared after fallback switch even with prior rate_limit cycle" passes.
- Test "task status restored to in_progress after fallback switch from usage_limited" passes.
- Existing tests continue to pass.

**Dependencies**: Task 3.1 (which already adds the `clearTaskRestriction` call).

**Agent Type**: coder
